import * as THREE from 'three';
import type { RoomState, RoomTheme } from '../common/room-state';
import { FirstPersonControls } from './first-person-controls';
import { cellRuns, dominantKey, MONITOR_COLS, MONITOR_ROWS } from './runtime-console-controller';
import type { WebSurfaceFrame } from '../common/web-runtime-protocol';
import { MonitorSelection, monitorCell, monitorCellSpan, visibleMonitorCells } from '../common/monitor-selection';
import type { SelectionUnit } from '../common/monitor-selection';
import type { RoomMember } from '../common/presence-protocol';
import { PLAYER_HOME, PlayerPose, ROOM_LAYOUTS, ROOM_KITS } from '../common/player-state';
import type { RoomLayoutId, RoomKitId } from '../common/player-state';
import type { RuntimeColorMetadata } from '../common/runtime-protocol';
import { terminalLinks } from '../common/terminal-links';
import { CodeReviewFrame, codeReviewPreview } from '../common/code-review-preview';
import { workstationLabelVisible } from './workstation-label-visibility';
import { PoseSmoother } from './movement-smoothing';
export type { CodeReviewFrame } from '../common/code-review-preview';

function safeTruecolor(value: RuntimeColorMetadata | undefined): RuntimeColorMetadata | undefined {
    if (!value || value.foreground.length === 0 || value.foreground.length !== value.background.length) return undefined;
    const cols = value.foreground[0]?.length ?? 0;
    if (!cols || value.background[0]?.length !== cols) return undefined;
    const rows = (input: string[][]): boolean => input.length === value.foreground.length
        && input.every(row => row.length === cols && row.every(color => /^#[0-9a-fA-F]{6}$/.test(color)));
    return rows(value.foreground) && rows(value.background)
        ? { foreground: value.foreground.map(row => row.slice()), background: value.background.map(row => row.slice()) }
        : undefined;
}
/** What the physical terminal monitor shows: runtime frame rows plus optional per-cell colour keys and cursor. */
export interface MonitorFrame {
    lines: string[];
    cells?: string[][];
    unreadBells?: number;
    foreground?: string[];
    background?: string[];
    truecolor?: RuntimeColorMetadata;
    palette?: Record<string, string>;
    cursor?: { x: number; y: number; visible: boolean };
    title?: string;
    status?: string;
}

export type Workstation = 'terminal' | 'terminal-2' | 'code' | 'web' | 'mirror';
export type TerminalWorkstation = 'terminal' | 'terminal-2';
export interface ScreenPoint { x: number; y: number }

/** A canvas-backed screen texture. Changed rows are re-uploaded as one sub-rectangle, never the whole canvas. */
interface ScreenSurface {
    canvas: HTMLCanvasElement;
    texture: THREE.CanvasTexture;
    cellWidth?: number;
    ctx?: CanvasRenderingContext2D;
    /** Same canvas, never rendered: the source for partial uploads. */
    source?: THREE.CanvasTexture;
    dirty?: { from: number; to: number };
    rows?: string[];
    header?: string;
    layout?: string;
    frame?: MonitorFrame;
    selection?: unknown;
    truecolorSource?: RuntimeColorMetadata;
    truecolor?: RuntimeColorMetadata;
}
const SURFACE_W = 1024, SURFACE_H = 576;
/** Cap fill-rate cost on HiDPI screens. The room is mostly flat colour, so 1.5x is visually equal. */
const MAX_PIXEL_RATIO = 1.5;

export interface RoomSceneOptions {
    theme: RoomTheme;
    layout?: RoomLayoutId;
    kit?: RoomKitId;
    camera: RoomState['camera'];
    onSelect: (station: Workstation, point?: ScreenPoint) => void;
    onTextSelect: (station: TerminalWorkstation) => void;
    onCameraChange: (camera: RoomState['camera']) => void;
    onReady: () => void;
    walk?: boolean;
    onInput: (text: string) => void;
    onPaste?: (text: string) => void;
    onScroll?: (deltaY: number) => void;
    onMessage: (text: string) => void;
    onError: (message: string) => void;
    onShortcut?: (shortcut: 'new-shell' | 'select-tab-2' | 'workspace-picker') => void;
    onOpenLink?: (url: string) => void;
    onPose?: (pose: PlayerPose) => void;
}

/** Original, asset-free scene. The IDE remains the authority for all real work. */
export class RoomScene {
    private renderer!: THREE.WebGLRenderer;
    private scene = new THREE.Scene();
    private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 150);
    private state: RoomState['camera'];
    private frame = 0;
    /** Render on demand: one rAF at most is ever pending; idle rooms render nothing. */
    private scheduled = false;
    private idle = true;
    private needsRender = true;
    private focusDrawn = false;
    private lastPose = '';
    private lastView = '';
    private peerVersion = 0;
    private ambientKey = 0;
    private ambientLayout = 0;
    private readonly smoother = new PoseSmoother();
    private data = new Map<string, string>();
    private labelPos = new WeakMap<HTMLElement, string>();
    private readonly tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), region: new THREE.Box2(), at: new THREE.Vector2() };
    /** Frames actually rendered (diagnostics). */
    renders = 0;
    private observer?: ResizeObserver;
    private disposed = false;
    private roots: THREE.Object3D[] = [];
    private labels: HTMLButtonElement[] = [];
    private walker?: FirstPersonControls;
    private navigation: 'walk' | 'overview' = 'overview';
    private lastFrame = performance.now();
    private terminalSurfaces = new Map<TerminalWorkstation, ScreenSurface>();
    private terminalSelection?: { station: TerminalWorkstation; model: MonitorSelection };
    private terminalFrames: Record<TerminalWorkstation, MonitorFrame> = { terminal: { lines: [] }, 'terminal-2': { lines: [] } };
    private screens = new Map<Workstation, THREE.Mesh>();
    private lamps = new Map<TerminalWorkstation, THREE.Mesh>();
    private webSurface?: HTMLCanvasElement;
    private mirrorSurface?: HTMLCanvasElement;
    private mirrorTexture?: THREE.CanvasTexture;
    private mirrorFrame: MonitorFrame = { lines: [] };
    private mirrorLabel?: HTMLButtonElement;
    private deskLabels = new Map<TerminalWorkstation, HTMLButtonElement>();
    private codeSurface?: {canvas:HTMLCanvasElement;texture:THREE.CanvasTexture};
    private webTexture?: THREE.CanvasTexture;
    private webEpoch = 0;
    private webSize = { width: 960, height: 600 };
    private pointer?: { x: number; y: number; startX: number; startY: number; dragged: boolean };
    private cleanup: Array<() => void> = [];
    private peerAvatars = new Map<string,{root:THREE.Group;member:RoomMember}>();
    constructor(private host: HTMLElement, private options: RoomSceneOptions) {
        this.state = { ...options.camera };
        try { this.init(); } catch (error) {
            options.onError(error instanceof Error ? error.message : String(error));
            this.dispose();
        }
    }
    private init(): void {
        const jungle = this.options.theme === 'jungle';
        this.scene.background = new THREE.Color(jungle ? '#101c1a' : '#101622');
        this.scene.fog = new THREE.Fog(jungle ? '#101c1a' : '#101622', 33, 65);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // The room is static: draw the shadow map once, and again only when something that casts moves.
        this.renderer.shadowMap.autoUpdate = false; this.renderer.shadowMap.needsUpdate = true;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.25;
        const canvas = this.renderer.domElement;
        canvas.dataset.testid = 'omo-world-canvas';
        canvas.setAttribute('aria-label', 'Interactive 3D room. Drag or use arrow keys to orbit. Scroll to zoom. Select a workstation to work.');
        canvas.tabIndex = 0;
        this.host.appendChild(canvas);
        this.scene.add(new THREE.HemisphereLight(jungle ? 0xd9f3d5 : 0xc7e6ff, 0x283136, 2.3));
        const sun = new THREE.DirectionalLight(jungle ? 0xffe8b8 : 0xffecd1, 4);
        sun.position.set(-5, 12, 8); sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
        sun.shadow.bias = -0.001; sun.shadow.normalBias = 0.025;
        this.scene.add(sun);
        const accent = new THREE.PointLight(jungle ? 0xc3ff9b : 0x70c9ff, 25, 18);
        accent.position.set(0, 4, -2); this.scene.add(accent);
        this.buildRoom(jungle);
        this.freeze(this.scene.children);
        canvas.dataset.roomLayout = this.options.layout ?? 'classic';
        canvas.dataset.deskPositions = JSON.stringify(Object.fromEntries(this.roots.filter(root => root.userData.workstation === 'terminal' || root.userData.workstation === 'terminal-2').map(root => {
            const point = root.getWorldPosition(new THREE.Vector3());
            return [root.userData.workstation, { x: point.x, z: point.z }];
        })));
        this.bindControls(canvas);
        this.bindWake(canvas);
        this.walker = new FirstPersonControls(canvas, this.camera, (x,y,modifiers)=>this.interactAt(x,y,modifiers), text=>this.options.onInput(text), text=>this.options.onMessage(text), this.options.onPaste, {
            start: (x,y,unit) => this.startTerminalSelection(x,y,unit), move: (x,y) => this.extendTerminalSelection(x,y),
            end: () => this.options.onMessage('Selected visible terminal text · Ctrl+Shift+C to copy.'),
            clear: () => this.clearTerminalSelection(), copy: () => this.copyTerminalSelection()
        }, this.options.layout ?? 'classic', shortcut => this.options.onShortcut?.(shortcut));
        this.setNavigation(this.options.walk ? 'walk' : 'overview');
        this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(this.host);
        this.resize(); this.positionCamera(); this.draw(); this.options.onReady();
    }
    /** Static room geometry never moves: skip its per-frame matrix work. */
    private freeze(nodes: THREE.Object3D[]): void {
        for (const node of nodes) { node.updateMatrixWorld(true); node.traverse(child => { child.matrixAutoUpdate = false; child.matrixWorldAutoUpdate = false; }); }
    }
    /** Request one frame. Safe to call many times per frame. */
    invalidate(render = true): void {
        if (render) this.needsRender = true;
        if (this.disposed || this.scheduled || !this.renderer) return;
        this.scheduled = true; this.frame = requestAnimationFrame(this.draw);
    }
    /** Input on the room wakes the loop. Registered before the walker, which stops propagation. */
    private bindWake(canvas: HTMLCanvasElement): void {
        // Wake only: the tick renders if the pose or view actually changed.
        const wake = (): void => this.invalidate(false);
        const key = (event: Event): void => { if (event.target === canvas || document.activeElement === canvas) this.invalidate(false); };
        for (const name of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'blur'] as const) canvas.addEventListener(name, wake, true);
        for (const name of ['keydown', 'keyup'] as const) window.addEventListener(name, key, true);
        window.addEventListener('blur', wake);
        // Agent avatars are added by another module without telling the room. While the loop is stopped,
        // a cheap 4 Hz check notices them appear (once present, the loop itself keeps watching them).
        const watch = window.setInterval(() => { if (!this.scheduled && this.ambient().key !== this.ambientKey) this.invalidate(false); }, 250);
        this.cleanup.push(() => window.clearInterval(watch));
        this.cleanup.push(() => {
            for (const name of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'blur'] as const) canvas.removeEventListener(name, wake, true);
            for (const name of ['keydown', 'keyup'] as const) window.removeEventListener(name, key, true);
            window.removeEventListener('blur', wake);
        });
    }
    private setData(key: string, value: string): void {
        if (this.data.get(key) === value) return;
        this.data.set(key, value); this.renderer.domElement.dataset[key] = value;
    }
    getPlayerPose():PlayerPose { return {...(this.walker?.pose ?? PLAYER_HOME)}; }
    // --- omo focus lane: the one public read focus mode needs (walker + a station's screen mesh). ---
    focusTarget(station?: Workstation): { controls?: FirstPersonControls; screen?: THREE.Mesh } { return { controls: this.walker, screen: station ? this.screens.get(station) : undefined }; }
    setPeers(members:RoomMember[]):void {
        const ids=new Set(members.map(m=>m.id));
        for(const [id,avatar] of this.peerAvatars)if(!ids.has(id)||members.find(m=>m.id===id)?.name!==avatar.member.name){
            this.scene.remove(avatar.root);avatar.root.traverse(node=>{
                if(node instanceof THREE.Mesh){node.geometry.dispose();(node.material as THREE.Material).dispose();}
                if(node instanceof THREE.Sprite){node.material.map?.dispose();node.material.dispose();}
            });this.peerAvatars.delete(id);
        }
        for(const member of members){
            let avatar=this.peerAvatars.get(member.id);
            if(!avatar){
                const root=new THREE.Group();
                this.box(root,[.42,.75,.28],[0,1,0],0xff56c8);
                this.box(root,[.35,.35,.35],[0,1.55,0],0xff56c8);
                this.box(root,[.14,.5,.16],[-.12,.38,0],0x75438b);
                this.box(root,[.14,.5,.16],[.12,.38,0],0x75438b);
                const label=document.createElement('canvas');label.width=512;label.height=96;
                const ctx=label.getContext('2d')!;ctx.fillStyle='#101622e8';ctx.fillRect(0,0,512,96);ctx.font='32px sans-serif';ctx.textAlign='center';ctx.fillStyle='#ffe3f6';ctx.fillText(member.name,256,60,490);
                const tag=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(label),depthTest:true}));tag.position.y=2.05;tag.scale.set(1.7,.32,1);root.add(tag);
                avatar={root,member};this.peerAvatars.set(member.id,avatar);this.scene.add(root);
            }
            avatar.member=member;avatar.root.position.set(member.pose.x,0,member.pose.z);avatar.root.rotation.y=member.pose.yaw;
        }
        this.peerVersion++;
        if (this.renderer) { this.renderer.shadowMap.needsUpdate = true; this.invalidate(); }
    }
    private material(color: THREE.ColorRepresentation, metalness = 0.1): THREE.MeshStandardMaterial {
        return new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness });
    }
    private box(parent: THREE.Object3D, dimensions: number[], at: number[], color: THREE.ColorRepresentation, metalness = 0.1): THREE.Mesh {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions as [number, number, number]), this.material(color, metalness));
        mesh.position.set(...at as [number, number, number]); mesh.castShadow = true; mesh.receiveShadow = true;
        parent.add(mesh); return mesh;
    }
    private cylinder(parent: THREE.Object3D, radius: number, height: number, at: number[], color: THREE.ColorRepresentation, radiusBottom = radius, segments = 24): THREE.Mesh {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radiusBottom, height, segments), this.material(color));
        mesh.position.set(...at as [number, number, number]); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
    }
    private glow(parent: THREE.Object3D, dimensions: number[], at: number[], color: number): THREE.Mesh {
        const mesh = this.box(parent, dimensions, at, color);
        (mesh.material as THREE.MeshStandardMaterial).emissive.set(color);
        (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.5;
        return mesh;
    }
    private buildRoom(jungle: boolean): void {
        const root = new THREE.Group(); this.scene.add(root);
        this.box(root, [13, 0.55, 10], [0, -0.42, 0], jungle ? 0x34453a : 0x303c50);
        this.box(root, [12.6, 0.12, 9.6], [0, -0.08, 0], jungle ? 0x76907b : 0x647889);
        const grid = new THREE.GridHelper(12, 12, jungle ? 0x91a98b : 0x8b9fac, jungle ? 0x718b76 : 0x718391);
        grid.position.set(0, 0.005, 0); (grid.material as THREE.Material).transparent = true;
        (grid.material as THREE.Material).opacity = 0.24; root.add(grid);
        // Cutaway architecture preserves legibility and keeps the workstations visible.
        this.box(root, [12.7, 3.4, 0.22], [0, 1.65, -4.65], jungle ? 0x526b59 : 0x28374b);
        this.box(root, [0.22, 2, 8.8], [-6.25, 0.95, -0.3], jungle ? 0x526b59 : 0x34475b);
        this.glow(root, [11.8, 0.055, 0.06], [0, 3.16, -4.49], jungle ? 0xc6e5a7 : 0x77deef);
        this.box(root, [7.4, 2.1, 0.08], [0.1, 1.8, -4.49], jungle ? 0x284c41 : 0x101c32);
        if (jungle) {
            for (let i = 0; i < 7; i++) this.tree(root, -5.1 + i * 1.67, -4.1, 1 + (i % 3) * 0.3);
            this.box(root, [3, 0.04, 2.8], [3.7, 0.02, 2.8], 0x2f7775);
            for (let i = 0; i < 5; i++) {
                this.cylinder(root, 0.28, 0.1, [2.4 + i * 0.55, 0.1, 2.4 + Math.sin(i) * 0.35], 0xbac1a4, 0.35, 7);
            }
            this.tree(root, -5, 2.6, 1.2); this.tree(root, 5.25, -0.7, 1.35);
            this.fern(root, -4.5, 3.6); this.fern(root, 5.1, 3.9); this.fern(root, 0.1, -3.6);
        } else {
            const globe = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 32), this.material(0x568eb1, 0.5));
            globe.position.set(0.8, 2, -4.2); globe.scale.z = 0.22; root.add(globe);
            const ring = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.025, 12, 64), this.material(0x8ce3ec));
            ring.position.set(0.8, 2, -4.1); ring.rotation.z = -0.4; root.add(ring);
            for (let i = 0; i < 24; i++) {
                const star = new THREE.Mesh(new THREE.SphereGeometry(0.018 + (i % 3) * 0.007, 6, 6), new THREE.MeshBasicMaterial({ color: 0xb1d9f7 }));
                star.position.set(-3.2 + ((i * 37) % 67) / 10, 0.9 + ((i * 13) % 19) / 10, -4.38); root.add(star);
            }
            for (const x of [-5.7, 5.7]) {
                this.box(root, [0.32, 3.6, 0.5], [x, 1.75, -4.1], 0x728896);
                this.glow(root, [0.065, 2.7, 0.07], [x, 1.8, -3.8], 0x98dce9);
            }
            this.plant(root, -5, 2.9); this.plant(root, 5.2, 2.8);
            this.box(root, [2.5, 0.5, 1], [-3.5, 0.25, -3.5], 0xa39c8c);
            this.box(root, [2.5, 0.65, 0.3], [-3.5, 0.65, -3.85], 0xa39c8c);
        }
        const desks = ROOM_LAYOUTS[this.options.layout ?? 'classic'].desks;
        this.desk(root, desks.terminal.x, desks.terminal.z, 'terminal', jungle);
        this.desk(root, desks['terminal-2'].x, desks['terminal-2'].z, 'terminal-2', jungle);
        if (ROOM_KITS[this.options.kit ?? 'hermes-desk'].webWall) this.webWall(root);
        if (ROOM_KITS[this.options.kit ?? 'hermes-desk'].mirror) this.mirrorWall(root);
        this.codeWall(root);
        this.cylinder(root, 0.7, 0.15, [0.2, 0.06, 3], jungle ? 0xb9ba91 : 0x8398a5, 0.75);
        const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 0), this.material(jungle ? 0xd6e7a4 : 0x7cdae2, 0.6));
        core.position.set(0.2, 0.65, 3); root.add(core);
        const landing = new THREE.Mesh(new THREE.PlaneGeometry(130, 130), this.material(jungle ? 0x101c1a : 0x101622));
        landing.rotation.x = -Math.PI / 2; landing.position.y = -1.05; landing.receiveShadow = true; this.scene.add(landing);
    }
    private codeWall(parent:THREE.Object3D):void {
        const group=new THREE.Group();group.position.set(-4.8,0,-3.9);group.userData.workstation='code';group.userData.labelHeight=2.8;parent.add(group);this.roots.push(group);
        this.box(group,[2.12,1.22,.12],[0,1.99,-.08],0x17222e);
        const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=576;
        const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;this.codeSurface={canvas,texture};
        const screen=new THREE.Mesh(new THREE.PlaneGeometry(1.98,1.08),new THREE.MeshBasicMaterial({map:texture}));screen.position.set(0,1.99,0);group.add(screen);this.screens.set('code',screen);
        const label=document.createElement('button');label.className='omo-scene-label';label.dataset.workstation='code';label.textContent='04  Code review ↗';label.setAttribute('aria-label','Review project changes');
        label.addEventListener('click',()=>{if(this.navigation==='walk'&&this.camera.position.distanceTo(screen.getWorldPosition(new THREE.Vector3()))>3.2){this.options.onMessage('Walk closer to the code screen.');return;}this.releaseTyping();this.options.onSelect('code');});
        this.host.appendChild(label);this.labels.push(label);
        this.setCodeReview({title:'PROJECT CHANGES',lines:['Open this screen to read real Git changes.','Patches are read only. Files stay in your editor.'],status:'No Git contents read yet'});
    }
    setCodeReview(frame:CodeReviewFrame):void {
        const surface=this.codeSurface;if(!surface)return;
        frame=codeReviewPreview(frame);
        const ctx=surface.canvas.getContext('2d')!;ctx.fillStyle='#101c27';ctx.fillRect(0,0,1024,576);ctx.font='bold 22px monospace';ctx.fillStyle='#b9e3d5';ctx.fillText(frame.title.slice(0,75),24,32);ctx.font='17px monospace';
        frame.lines.forEach((line,i)=>{ctx.fillStyle=line.startsWith('+')?'#91e4ac':line.startsWith('-')?'#f1a49c':'#d7e3df';ctx.fillText(line,24,70+i*21,976);});ctx.fillStyle='#8ea5aa';ctx.font='14px monospace';ctx.fillText(frame.status.slice(0,110),24,564,976);surface.texture.needsUpdate=true;this.invalidate();
        this.renderer.domElement.dataset.codeReviewText=frame.lines.join('\n');
        this.renderer.domElement.dataset.codeReviewStatus=frame.status;
    }
    private desk(parent: THREE.Object3D, x: number, z: number, action: TerminalWorkstation, jungle: boolean): void {
        const group = new THREE.Group(); group.position.set(x, 0, z); group.userData.workstation = action; parent.add(group); this.roots.push(group);
        this.box(group, [3.2, 0.15, 1.55], [0, 1.15, 0], jungle ? 0xc0aa7b : 0xd2c9b5);
        for (const leg of [-1.28, 1.28]) this.box(group, [0.13, 1.1, 1.25], [leg, 0.54, 0], jungle ? 0x394e42 : 0x374656);
        this.box(group, [0.65, 0.06, 0.48], [0, 1.26, -0.25], 0x293645);
        this.box(group, [0.1, 0.35, 0.1], [0, 1.43, -0.35], 0x435664);
        this.box(group, [1.72, 1.04, 0.11], [0, 1.99, -0.36], 0x17222e);
        const texture = this.screenTexture(action);
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.58, 0.9), new THREE.MeshBasicMaterial({map:texture}));
        screen.position.set(0, 1.99, -0.296); group.add(screen);
        this.screens.set(action, screen);
        this.box(group, [0.9, 0.045, 0.3], [-0.15, 1.26, 0.28], 0x344353);
        for(let i=0;i<3;i++) this.box(group,[0.72,0.008,0.012],[-0.15,1.285,0.2+i*0.075],0x71808c);
        this.cylinder(group, 0.11, 0.25, [1.15, 1.32, 0.3], jungle ? 0xd3d3a8 : 0xc9a478);
        const lamp = this.glow(group, [0.3, 0.025, 0.025], [-0.6, 1.42, -0.265], 0x6d7c86);
        if (action === 'terminal' || action === 'terminal-2') this.lamps.set(action, lamp);
        // Chair and footrest. These are navigation landmarks, not pretend agents.
        this.cylinder(group, 0.15, 0.5, [0, 0.3, 1.35], 0x374656);
        this.box(group, [0.9, 0.16, 0.85], [0, 0.62, 1.35], jungle ? 0x758968 : 0x648697);
        this.box(group, [0.9, 0.85, 0.14], [0, 1.03, 1.72], jungle ? 0x758968 : 0x648697);
        const label = document.createElement('button'); label.className = 'omo-scene-label'; label.dataset.workstation = action;
        label.textContent = action === 'terminal' ? '01  Desk one ↗' : '02  Desk two ↗';
        label.setAttribute('aria-label', action === 'terminal' ? 'Open project terminal' : 'Open second project terminal');
        label.addEventListener('click', () => {
            if(this.navigation==='walk'){const center = screen.getWorldPosition(new THREE.Vector3());if(this.camera.position.distanceTo(center)>3.2){this.options.onMessage('Walk closer to the terminal monitor.');return;}this.walker?.focusTerminal();}
            this.options.onSelect(action);
        });
        this.host.appendChild(label); this.labels.push(label); this.deskLabels.set(action, label);
    }
    private screenTexture(action: Workstation): THREE.CanvasTexture {
        if(action==='terminal' || action==='terminal-2'){
            const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=576;
            const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
            // Unflipped upload so a changed row band maps 1:1 to a sub-rectangle; flip in the UV transform instead.
            texture.flipY=false;texture.repeat.set(1,-1);texture.offset.set(0,1);
            const source=new THREE.CanvasTexture(canvas);source.flipY=false;
            this.terminalSurfaces.set(action, { canvas, texture, source, ctx: canvas.getContext('2d') ?? undefined });
            this.setTerminalFrame(this.terminalFrames[action], action);return texture;
        }
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const c = canvas.getContext('2d')!;
        c.fillStyle='#111d2a'; c.fillRect(0,0,640,360);
        c.fillStyle='#a4c6ed'; c.font='24px monospace';
        c.fillText('PROJECT FILES',36,55);
        c.fillStyle='#d2dce6'; c.font='21px monospace';
        const lines=['README.md','src/','', 'Open in the editor →'];
        lines.forEach((line,i)=>c.fillText(line,36,115+i*43));
        c.fillStyle='#526c7c'; c.font='16px monospace'; c.fillText('OMO / WORKSTATION',36,330);
        const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
    }
    private mirrorWall(parent: THREE.Object3D): void {
        const group = new THREE.Group(); group.position.set(4.7, 0, -3.98); group.userData.workstation = 'mirror'; group.userData.labelHeight = 3.25; parent.add(group); this.roots.push(group);
        this.box(group, [2.55, 2.0, .14], [0, 1.75, 0], 0x17222e);
        this.mirrorSurface = document.createElement('canvas'); this.mirrorSurface.width = 1024; this.mirrorSurface.height = 576;
        this.mirrorTexture = new THREE.CanvasTexture(this.mirrorSurface); this.mirrorTexture.colorSpace = THREE.SRGBColorSpace;
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.36, 1.8), new THREE.MeshBasicMaterial({ map: this.mirrorTexture, toneMapped: false }));
        screen.position.set(0, 1.75, .08); group.add(screen); this.screens.set('mirror', screen);
        const label = document.createElement('button'); label.className = 'omo-scene-label'; label.dataset.workstation = 'mirror'; label.textContent = '04  Mirror · Desk one ↗'; label.setAttribute('aria-label', 'Use linked monitor mirror');
        label.addEventListener('click', () => { this.options.onSelect('mirror'); });
        this.host.appendChild(label); this.labels.push(label); this.mirrorLabel = label;
        this.setMirrorFrame({ lines: [], title: 'LINKED MONITOR', status: 'Link this screen to a desk above.' });
    }
    private mirrorKey = '';
    setMirrorFrame(frame: MonitorFrame | undefined): void {
        this.mirrorFrame = frame ?? { lines: [], title: 'LINKED MONITOR', status: 'No mirror attached.' };
        if (!this.mirrorSurface || !this.mirrorTexture) return;
        const key = `${this.mirrorFrame.title}\u0000${this.mirrorFrame.status}\u0000${this.mirrorFrame.lines.slice(-22).join('\n')}`;
        if (key === this.mirrorKey) return;
        this.mirrorKey = key;
        const c = this.mirrorSurface.getContext('2d')!; c.fillStyle = '#091119'; c.fillRect(0, 0, 1024, 576);
        c.fillStyle = '#87cdb4'; c.font = '17px monospace'; c.fillText((this.mirrorFrame.title ?? 'LINKED MONITOR').slice(0, 52), 24, 29);
        c.fillStyle = '#283e48'; c.fillRect(20, 42, 984, 1); c.font = '20px monospace';
        const lines = this.mirrorFrame.lines.slice(-22);
        lines.forEach((line, i) => { c.fillStyle = line.includes('$') ? '#b8e6ca' : '#e0e8eb'; c.fillText(line.slice(0, 80), 24, 70 + i * 22); });
        if (!lines.length) { c.fillStyle = '#c7ded4'; c.fillText((this.mirrorFrame.status ?? 'Link this monitor to a desk.').slice(0, 80), 24, 105); }
        this.mirrorTexture.needsUpdate = true;
        if (this.renderer) { this.renderer.domElement.dataset.mirrorText = this.mirrorFrame.lines.join('\\n'); this.invalidate(); }
    }
    private webWall(parent: THREE.Object3D): void {
        const group = new THREE.Group(); group.position.set(0, 0, -4.12); group.userData.workstation = 'web'; group.userData.labelHeight = 3.43;
        parent.add(group); this.roots.push(group);
        this.box(group, [4.12, 2.6, .14], [0, 1.9, 0], 0x17222e);
        this.webSurface = document.createElement('canvas'); this.webSurface.width = 960; this.webSurface.height = 600;
        this.webTexture = new THREE.CanvasTexture(this.webSurface); this.webTexture.colorSpace = THREE.SRGBColorSpace;
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 2.44), new THREE.MeshBasicMaterial({ map: this.webTexture, toneMapped: false }));
        screen.position.set(0, 1.9, .08); group.add(screen); this.screens.set('web', screen);
        this.setWebPlaceholder('Click the web wall, then open an address.');
        const label = document.createElement('button'); label.className = 'omo-scene-label'; label.dataset.workstation = 'web'; label.textContent = '03  Web wall ↗';
        label.setAttribute('aria-label', 'Use physical web wall');
        label.addEventListener('click', () => {
            if (this.navigation === 'walk' && this.camera.position.distanceTo(screen.getWorldPosition(new THREE.Vector3())) > 3.2) { this.options.onMessage('Walk closer to the web wall.'); return; }
            this.options.onSelect('web'); this.walker?.focusTerminal();
        });
        this.host.appendChild(label); this.labels.push(label);
    }
    setWebPlaceholder(message: string): void {
        this.webEpoch++;
        if (!this.webSurface || !this.webTexture) return;
        const c = this.webSurface.getContext('2d')!;
        c.fillStyle = '#091119'; c.fillRect(0, 0, this.webSurface.width, this.webSurface.height);
        c.fillStyle = '#87cdb4'; c.font = '30px monospace'; c.fillText('OMO / WEB WALL', 40, 75);
        c.fillStyle = '#c7ded4'; c.font = '24px monospace'; c.fillText(message.slice(0, 62), 40, 140);
        this.webTexture.needsUpdate = true; this.invalidate();
    }
    setWebFrame(frame: WebSurfaceFrame): void {
        const epoch = ++this.webEpoch;
        this.webSize = { width: frame.surface.width, height: frame.surface.height };
        const image = new Image();
        image.onload = () => {
            if (this.disposed || epoch !== this.webEpoch || !this.webSurface || !this.webTexture) return;
            const c = this.webSurface.getContext('2d')!;
            c.drawImage(image, 0, 0, this.webSurface.width, this.webSurface.height);
            this.webTexture.needsUpdate = true; this.invalidate();
            this.renderer.domElement.dataset.webFrameSequence = String(frame.sequence);
        };
        image.onerror = () => { if (epoch === this.webEpoch) this.options.onMessage('The browser frame could not be decoded.'); };
        image.src = `data:${frame.mime};base64,${frame.data}`;
    }
    clearWebFrame(): void {
        ++this.webEpoch;
        this.setWebPlaceholder('Open a page above to use this wall.');
        delete this.renderer.domElement.dataset.webFrameSequence;
    }
    private plant(parent: THREE.Object3D, x: number, z: number): void {
        this.cylinder(parent, 0.35, 0.5, [x, 0.25, z], 0xd1c7af, 0.25);
        this.fern(parent,x,z,0.5);
    }
    private fern(parent: THREE.Object3D, x: number, z: number, lift=0): void {
        for (let i=0;i<7;i++) {
            const a=i*Math.PI*2/7;
            const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.26,8,6), this.material(i%2?0x6d9b71:0x4c7e62));
            leaf.scale.set(0.5,2.5,0.35); leaf.rotation.z=-Math.sin(a)*0.8; leaf.rotation.x=Math.cos(a)*0.8;
            leaf.position.set(x+Math.sin(a)*0.2,0.65+lift,z+Math.cos(a)*0.2); leaf.castShadow=true; parent.add(leaf);
        }
    }
    private tree(parent: THREE.Object3D, x: number, z: number, scale: number): void {
        const trunk=this.cylinder(parent,0.1*scale,2.6*scale,[x,1.3*scale,z],0x675940,0.16*scale,8);
        trunk.rotation.z=0.1;
        for(let i=0;i<4;i++) {
            const crown=new THREE.Mesh(new THREE.IcosahedronGeometry(0.75*scale,1),this.material(i%2?0x5c8661:0x466e55));
            crown.position.set(x+Math.sin(i*2.4)*0.5,2.4*scale+(i%2)*0.3,z+Math.cos(i*2.4)*0.4); crown.scale.y=0.8; crown.castShadow=true;parent.add(crown);
        }
    }
    private bindControls(canvas: HTMLCanvasElement): void {
        const down=(event:PointerEvent)=> {if(event.button!==0)return;this.pointer={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,dragged:false};canvas.setPointerCapture(event.pointerId);};
        const move=(event:PointerEvent)=>{
            if(!this.pointer)return;
            if(Math.hypot(event.clientX-this.pointer.startX,event.clientY-this.pointer.startY)>5)this.pointer.dragged=true;
            if(this.pointer.dragged){this.state.azimuth-=(event.clientX-this.pointer.x)*0.006;this.state.elevation=Math.max(0.15,Math.min(1.4,this.state.elevation+(event.clientY-this.pointer.y)*0.004));this.positionCamera();}
            this.pointer.x=event.clientX;this.pointer.y=event.clientY;
        };
        const up=(event:PointerEvent)=>{
            if(!this.pointer)return;const dragged=this.pointer.dragged;this.pointer=undefined;
            if(dragged){this.options.onCameraChange({...this.state});return;}
            const rect=canvas.getBoundingClientRect();const p=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
            const ray=new THREE.Raycaster();ray.setFromCamera(p,this.camera);const hits=ray.intersectObjects(this.roots,true);
            for(const hit of hits){let node:THREE.Object3D|null=hit.object;while(node&&!node.userData.workstation)node=node.parent;if(node?.userData.workstation){this.options.onSelect(node.userData.workstation);break;}}
        };
        const wheel=(event:WheelEvent)=>{event.preventDefault();if(this.navigation==='walk'){if(this.walker?.typing)this.options.onScroll?.(event.deltaY);return;}this.state.distance=Math.max(10,Math.min(30,this.state.distance+event.deltaY*0.01));this.positionCamera();this.options.onCameraChange({...this.state});};
        const key=(event:KeyboardEvent)=>{
            if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(event.key))return;event.preventDefault();
            if(event.key==='ArrowLeft')this.state.azimuth-=0.12;if(event.key==='ArrowRight')this.state.azimuth+=0.12;
            if(event.key==='ArrowUp')this.state.elevation=Math.min(1.4,this.state.elevation+0.08);if(event.key==='ArrowDown')this.state.elevation=Math.max(0.15,this.state.elevation-0.08);
            if(event.key==='+')this.state.distance=Math.max(10,this.state.distance-1);if(event.key==='-')this.state.distance=Math.min(30,this.state.distance+1);
            this.positionCamera();this.options.onCameraChange({...this.state});
        };
        canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('keydown',key);
        this.cleanup.push(()=>{canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('keydown',key);});
    }
    setNavigation(mode: 'walk' | 'overview'): void {
        this.navigation = mode; this.camera.fov = mode === 'walk' ? 65 : 38; this.camera.updateProjectionMatrix();
        this.walker?.setEnabled(mode === 'walk');
        if (this.walker) this.smoother.snap(this.walker.pose);
        if (this.renderer) { this.renderer.domElement.dataset.navigation = mode; }
        this.labels.forEach(label => label.classList.toggle('is-walk', mode === 'walk'));
        this.positionCamera(); this.invalidate();
    }
    setTerminalLines(lines: string[]): void { this.setTerminalFrame({ ...this.terminalFrames.terminal, lines, cells: undefined, foreground: undefined, background: undefined, cursor: undefined }); }
    setTerminalFrames(frames: Record<TerminalWorkstation, MonitorFrame>): void {
        this.setTerminalFrame(frames.terminal, 'terminal'); this.setTerminalFrame(frames['terminal-2'], 'terminal-2');
    }
    setTerminalFrame(frame: MonitorFrame, station: TerminalWorkstation = 'terminal'): void {
        const previous = this.terminalFrames[station];
        if (this.terminalSelection?.station === station && (!this.terminalSelection.model.refresh(frame.lines,frame.cells) || previous.title !== frame.title || previous.status !== frame.status)) this.terminalSelection = undefined;
        this.terminalFrames[station] = frame;
        const workspaceName = frame.title?.split(' / ')[0]?.trim();
        const deskLabel = this.deskLabels.get(station);
        const deskText = workspaceName ? `${station === 'terminal' ? '01' : '02'}  ${workspaceName.slice(0, 36)} ↗` : undefined;
        if (deskText && deskLabel && deskLabel.textContent !== deskText) deskLabel.textContent = deskText;
        const surface = this.terminalSurfaces.get(station);
        if (!surface) return;
        const selection = this.terminalSelection?.station === station ? this.terminalSelection.model : undefined;
        const spans = selection ? selection.spans() : [];
        const selectionKey = selection ? JSON.stringify(spans) : '';
        // Same frame object and same selection: the monitor already shows it (the other desk on every update).
        if (surface.frame === frame && surface.selection === selectionKey) return;
        const frameChanged = surface.frame !== frame;
        surface.frame = frame; surface.selection = selectionKey;
        if (this.paintTerminal(surface, frame, spans)) this.invalidate();
        const lamp = this.lamps.get(station);
        if (lamp) {
            const color = /interrupted|exited|error/i.test(frame.status ?? '') ? 0xd26464 : frame.unreadBells ? 0xff9e4a : /process active|working/i.test(frame.status ?? '') ? 0xe8bd60 : /live|running|idle/i.test(frame.status ?? '') ? 0x87cdb4 : 0x6d7c86;
            const material = lamp.material as THREE.MeshStandardMaterial;
            if (material.color.getHex() !== color || material.emissive.getHex() !== color) { material.color.setHex(color); material.emissive.setHex(color); this.invalidate(); }
        }
        if (!this.renderer) return;
        this.setData('terminalSelection', this.terminalSelection?.model.text() ?? '');
        this.setData('terminalSelectionStation', this.terminalSelection?.station ?? '');
        this.setData('stationLamps', JSON.stringify(Object.fromEntries([...this.lamps].map(([id,mesh]) => [id,(mesh.material as THREE.MeshStandardMaterial).color.getHexString()]))));
        if (!frameChanged) return;
        this.setData('terminalMetrics', JSON.stringify(Object.fromEntries([...this.terminalSurfaces].map(([id,s]) => [id,{ cellWidth:s.cellWidth ?? 12 }]))));
        if (station === 'terminal') { this.setData('terminalText', frame.lines.join('\n')); this.setData('terminalCursor', frame.cursor?`${frame.cursor.x},${frame.cursor.y},${frame.cursor.visible}`:''); }
        this.setData('stationText', JSON.stringify({ terminal: this.terminalFrames.terminal.lines, 'terminal-2': this.terminalFrames['terminal-2'].lines }));
        this.setData('stationCells', JSON.stringify({ terminal:this.terminalFrames.terminal.cells,'terminal-2':this.terminalFrames['terminal-2'].cells }));
        this.setData('stationBells', JSON.stringify({ terminal: this.terminalFrames.terminal.unreadBells ?? 0, 'terminal-2': this.terminalFrames['terminal-2'].unreadBells ?? 0 }));
    }
    /**
     * Paint a terminal frame into its canvas. Only the header and the rows whose content changed are
     * repainted, clipped to their band; the band is then the only part uploaded to the GPU.
     * Returns whether any pixel changed.
     */
    private paintTerminal(surface: ScreenSurface, frame: MonitorFrame, spans: Array<{ row: number; from: number; to: number }>): boolean {
        const c = surface.ctx ?? surface.canvas.getContext('2d')!;
        const base = '#091119';
        const rows = visibleMonitorCells(frame.lines,frame.cells), lines = rows.map(row=>row.join(''));
        const offset = frame.lines.length - lines.length;
        if (frame.truecolor !== surface.truecolorSource) { surface.truecolorSource = frame.truecolor; surface.truecolor = safeTruecolor(frame.truecolor); }
        const truecolor = surface.truecolor;
        // The frame's most common background is the terminal's own background; the monitor keeps its accepted base colour for it.
        const plainBg = lines.length && frame.background ? frame.palette?.[dominantKey(frame.background) ?? ''] : undefined;
        const skip = plainBg ? (plainBg.startsWith('#') ? plainBg : `#${plainBg}`).toLowerCase() : base;
        const header = `${frame.title ?? ''}\u0000${frame.status ?? ''}\u0000${frame.unreadBells ?? 0}`;
        const layout = lines.length ? `${skip}\u0000${!!frame.foreground}\u0000${frame.cells !== undefined}\u0000${JSON.stringify(frame.palette ?? null)}` : `empty\u0000${frame.status ?? ''}`;
        const cursor = frame.cursor?.visible && frame.cursor.y - offset >= 0 && frame.cursor.y - offset < MONITOR_ROWS && frame.cursor.x >= 0 && frame.cursor.x < MONITOR_COLS ? frame.cursor : undefined;
        const keys: string[] = [];
        for (let i = 0; i < MONITOR_ROWS; i++) {
            if (i >= lines.length) { keys.push(''); continue; }
            let key = lines[i];
            if (frame.cells !== undefined) key += `\u0001${rows[i].join('\u0002')}`;
            key += `\u0001${frame.foreground?.[offset+i] ?? ''}\u0001${frame.background?.[offset+i] ?? ''}`;
            if (truecolor) key += `\u0001${truecolor.foreground[offset+i]?.join('')}${truecolor.background[offset+i]?.join('')}`;
            if (cursor && cursor.y - offset === i) key += `\u0001C${cursor.x}`;
            for (const span of spans) if (span.row === i) key += `\u0001S${span.from}:${span.to}`;
            keys.push(key);
        }
        const full = !surface.rows || surface.layout !== layout || typeof c.save !== 'function';
        const headerDirty = full || surface.header !== header;
        let from = -1, to = -1;
        if (!full && lines.length) for (let i = 0; i < MONITOR_ROWS; i++) if (keys[i] !== surface.rows![i]) { if (from < 0) from = i; to = i; }
        surface.rows = keys; surface.header = header; surface.layout = layout;
        if (!full && !headerDirty && from < 0) return false;
        if (full) { c.fillStyle = base; c.fillRect(0,0,SURFACE_W,SURFACE_H); }
        if (headerDirty) {
            if (!full) { c.fillStyle = base; c.fillRect(0,0,SURFACE_W,49); }
            c.fillStyle = '#87cdb4'; c.font = '17px monospace'; c.fillText((frame.title ?? 'OMO / LIVE PROJECT TERMINAL').slice(0,52),24,29);
            if (frame.status || frame.unreadBells) { c.fillStyle = frame.unreadBells ? '#ff9e4a' : '#7e9a9e'; c.textAlign = 'right'; c.fillText((frame.unreadBells ? `BELL (${frame.unreadBells})` : frame.status ?? '').slice(0,38),1000,29); c.textAlign = 'left'; }
            c.fillStyle = '#283e48'; c.fillRect(20,42,984,1);
        }
        c.font = '20px monospace'; c.textBaseline = 'alphabetic';
        if (!lines.length) {
            if (full) { c.fillStyle='#c7ded4';c.fillText('Walk up and click this screen.',24,104); c.fillStyle='#7e9a9e';c.fillText((frame.status ?? '').slice(0,MONITOR_COLS),24,140); }
            this.markDirty(surface, full, 0, headerDirty ? 49 : 0);
            return true;
        }
        const cell = Math.min(12.3, c.measureText('M').width || 12);
        surface.cellWidth = cell;
        // Rows tile in 22px bands from y=53. Glyphs reach 4px into the row above and 1px into the row below,
        // so a changed band repaints its neighbours too, clipped to the band, in the full-paint order.
        const top = full ? 49 : from === 0 ? 49 : 53 + from*22, bottom = full ? SURFACE_H : to === MONITOR_ROWS-1 ? SURFACE_H : 75 + to*22;
        if (from >= 0 || full) {
            const first = full ? 0 : Math.max(0, from-1), last = full ? lines.length-1 : Math.min(lines.length-1, to+1);
            c.save(); c.beginPath(); c.rect(0, top, SURFACE_W, bottom-top); c.clip();
            if (!full) { c.fillStyle = base; c.fillRect(0, top, SURFACE_W, bottom-top); }
            for (let i = first; i <= last; i++) {
                const y = 70 + i*22, line = lines[i];
                const fallback = { fg: frame.foreground ? '#e0e8eb' : line.includes('$') ? '#b8e6ca' : '#e0e8eb', bg: base };
                const direct = truecolor ? { fg: truecolor.foreground[offset+i], bg: truecolor.background[offset+i] } : undefined;
                const runs = cellRuns(line, frame.foreground?.[offset+i], frame.background?.[offset+i], frame.palette, fallback, frame.cells === undefined ? undefined : rows[i], direct);
                // Paint all cell backgrounds BEFORE glyphs, so a continuation does not erase its leading glyph.
                for (const run of runs) {
                    const x = 24 + run.x*cell;
                    if (run.bg.toLowerCase() !== skip && run.bg !== base) { c.fillStyle = run.bg; c.fillRect(x, y-17, (run.columns ?? Array.from(run.text).length)*cell, 22); }
                }
                for (const run of runs) {
                    if (!run.text.trim()) continue;
                    const x = 24+run.x*cell, width = (run.glyphColumns ?? Array.from(run.text).length)*cell;
                    c.save(); c.beginPath(); c.rect(x,y-21,width,27); c.clip();
                    c.fillStyle = run.fg; c.fillText(run.text,x,y,width); c.restore();
                }
            }
            if (cursor) {
                const row = rows[cursor.y-offset] ?? [], span = monitorCellSpan(row,cursor.x);
                const x = 24+span.from*cell, y = 70+(cursor.y-offset)*22, width = (span.to-span.from)*cell;
                c.fillStyle = '#b8e6ca'; c.fillRect(x,y-17,width,22);
                const ch = row[span.from];
                if (ch && ch !== ' ') { c.fillStyle = base; c.fillText(ch,x,y,width); }
            }
            if (spans.length) {
                c.fillStyle = 'rgba(65,150,240,0.45)';
                for (const span of spans) c.fillRect(24 + span.from*cell, 53 + span.row*22, (span.to-span.from)*cell, 22);
            }
            c.restore();
        }
        this.markDirty(surface, full, headerDirty ? 0 : top, from >= 0 ? bottom : 49);
        return true;
    }
    /** Queue a GPU upload: the whole canvas, or the union of changed pixel bands (flushed once per rendered frame). */
    private markDirty(surface: ScreenSurface, full: boolean, top: number, bottom: number): void {
        if (full || !surface.source) { surface.texture.needsUpdate = true; surface.dirty = undefined; return; }
        if (bottom <= top) return;
        surface.dirty = surface.dirty ? { from: Math.min(surface.dirty.from, top), to: Math.max(surface.dirty.to, bottom) } : { from: top, to: bottom };
    }
    private uploadDirty(): void {
        for (const surface of this.terminalSurfaces.values()) {
            const dirty = surface.dirty; if (!dirty || !surface.source) continue;
            surface.dirty = undefined;
            // A full upload is already queued and will include these pixels.
            if (surface.texture.version === 0 || (this.renderer.properties.get(surface.texture) as { __version?: number }).__version !== surface.texture.version) continue;
            const { region, at } = this.tmp;
            region.min.set(0, dirty.from); region.max.set(SURFACE_W, dirty.to); at.set(0, dirty.from);
            this.renderer.copyTextureToTexture(surface.source, surface.texture, region, at);
        }
    }
    /** Pointer moved to an overlay control: stop typing into the monitor so keys go to that control. */
    releaseTyping(): void { this.clearTerminalSelection(); this.walker?.releaseTyping(); }
    private terminalCellAt(x: number, y: number, clamp = false): { station: TerminalWorkstation; cell: {row:number;col:number} } | undefined {
        const rect = this.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1), this.camera);
        // Only the frontmost actual screen counts. Never select through another object or workstation.
        const hit = ray.intersectObjects(this.roots,true)[0]; if (!hit?.uv) return undefined;
        for (const station of ['terminal','terminal-2'] as const) {
            const screen = this.screens.get(station);
            if (!screen || hit.object !== screen || this.camera.position.distanceTo(screen.getWorldPosition(new THREE.Vector3())) > 3.2) continue;
            const point = monitorCell(hit.uv.x, hit.uv.y, this.terminalSurfaces.get(station)?.cellWidth ?? 12, clamp);
            if (point) return {station,cell:point};
        }
        return undefined;
    }
    private startTerminalSelection(x: number, y: number, unit: SelectionUnit = 'char'): boolean {
        this.clearTerminalSelection(); const hit = this.terminalCellAt(x,y); if (!hit) return false;
        // Selecting text changes the active desk locally; it must not bind/revive a runtime.
        this.options.onTextSelect(hit.station);
        this.terminalSelection = { station:hit.station,model:new MonitorSelection(this.terminalFrames[hit.station].lines,hit.cell,unit,this.terminalFrames[hit.station].cells) };
        this.setTerminalFrame(this.terminalFrames[hit.station],hit.station); return true;
    }
    private extendTerminalSelection(x: number, y: number): void {
        const selected = this.terminalSelection, hit = this.terminalCellAt(x,y,true);
        if (!selected || hit?.station !== selected.station) return;
        selected.model.extend(hit.cell); this.setTerminalFrame(this.terminalFrames[selected.station],selected.station);
    }
    private clearTerminalSelection(): void {
        const selected = this.terminalSelection; if (!selected) return;
        this.terminalSelection = undefined; this.setTerminalFrame(this.terminalFrames[selected.station],selected.station);
    }
    private copyTerminalSelection(): void {
        const text = this.terminalSelection?.model.text();
        if (!text) { this.options.onMessage('Shift+drag on a terminal screen to select text first.'); return; }
        // Explicit user gesture only. No clipboard reads, terminal input or permission bypass fallback.
        if (!navigator.clipboard?.writeText) { this.options.onMessage('Clipboard unavailable. Use a secure browser context. Nothing was sent to the terminal.'); return; }
        void navigator.clipboard.writeText(text).then(() => { if (!this.disposed) this.options.onMessage('Selected terminal text copied.'); }, () => {
            if (!this.disposed) this.options.onMessage('Clipboard copy failed. Check browser permissions. Nothing was sent to the terminal.');
        });
    }
    private terminalLinkAt(station: TerminalWorkstation, hit: THREE.Intersection): string | undefined {
        if (!hit.uv) return undefined;
        const frame = this.terminalFrames[station];
        const visible = frame.lines.slice(-MONITOR_ROWS);
        const row = Math.max(0, Math.min(MONITOR_ROWS - 1, Math.floor((1 - hit.uv.y) * MONITOR_ROWS)));
        const line = visible[row] ?? '';
        const col = Math.floor(hit.uv.x * MONITOR_COLS);
        for (const link of terminalLinks(visible, frame.cells)) {
            const start = line.indexOf(link.text);
            if (start >= 0 && col >= start && col < start + link.text.length) return link.url;
        }
        return undefined;
    }
    private interactAt(x: number, y: number, modifiers?: { ctrlKey: boolean; metaKey: boolean }): 'terminal' | 'code' | undefined {
        const rect=this.renderer.domElement.getBoundingClientRect();
        const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1),this.camera);
        for(const hit of ray.intersectObjects(this.roots,true)){
            let node:THREE.Object3D|null=hit.object;while(node&&!node.userData.workstation)node=node.parent;
            const action=node?.userData.workstation as Workstation|undefined;
            if(!action)continue;
            const screen = this.screens.get(action); if (!screen) continue;
            const center = screen.getWorldPosition(new THREE.Vector3());
            if(this.camera.position.distanceTo(center)>3.2){this.options.onMessage('Walk closer to the workstation.');return;}
            if ((modifiers?.ctrlKey || modifiers?.metaKey) && (action === 'terminal' || action === 'terminal-2') && hit.object === screen) {
                const link = this.terminalLinkAt(action, hit);
                if (link) { this.options.onOpenLink?.(link); return 'terminal'; }
                this.options.onMessage('Ctrl-click a complete safe HTTP(S) link on this monitor.'); return 'terminal';
            }
            const point = action === 'web' && hit.object === screen && hit.uv ? { x: Math.min(this.webSize.width-1, Math.max(0, hit.uv.x*this.webSize.width)), y: Math.min(this.webSize.height-1, Math.max(0, (1-hit.uv.y)*this.webSize.height)) } : undefined;
            this.options.onSelect(action, point); return action === 'code' ? 'code' : action === 'mirror' ? undefined : 'terminal';
        }
        return undefined;
    }
    private positionCamera(): void {
        this.invalidate();
        if (this.navigation === 'walk') { this.walker?.step(0); return; }
        const {azimuth:a,elevation:e,distance:d}=this.state;
        const fit = Math.max(1, 1.28 / this.camera.aspect);
        this.camera.position.set(Math.sin(a)*Math.cos(e)*d*fit,Math.sin(e)*d*fit,Math.cos(a)*Math.cos(e)*d*fit);
        this.camera.lookAt(0,0.7,0);
    }
    private resize():void {
        const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;
        this.renderer.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.lastView='';this.positionCamera();
    }
    /**
     * The only animation loop. Each tick advances the walker and the view smoothing, then renders only
     * when something visible changed. It reschedules itself while the player moves, the view is still
     * settling, or agent avatars are present (their ambient motion is checked cheaply each tick and
     * rendered only when it changes). Otherwise it stops; input, resize and content updates restart it.
     */
    private draw=():void=>{
        if(this.scheduled){cancelAnimationFrame(this.frame);this.scheduled=false;}
        this.frame=0;
        if(this.disposed||!this.renderer)return;
        const now=performance.now();
        // After an idle gap the elapsed time is not motion time: advance one nominal frame.
        const delta=this.idle?1/60:Math.min((now-this.lastFrame)/1000,0.1);this.lastFrame=now;this.idle=false;
        const w=this.host.clientWidth,h=this.host.clientHeight;
        if(!w||!h){this.idle=true;return;}
        let moving=false;
        if(this.navigation==='walk'&&this.walker){
            const before=this.walker.pose;const bx=before.x,bz=before.z,byaw=before.yaw,bpitch=before.pitch;
            this.walker.step(delta);
            const pose=this.walker.pose;
            moving=pose.x!==bx||pose.z!==bz||pose.yaw!==byaw||pose.pitch!==bpitch;
            if(this.walker.cameraOwned){
                // Focus mode drives the camera (eased flight to/from a screen); keep drawing while it flies.
                this.smoother.snap(pose);
                if(this.walker.flying)moving=true;
                if(this.walker.cameraOwned!==this.focusDrawn){this.focusDrawn=this.walker.cameraOwned;moving=true;}
            }else{
                if(this.focusDrawn){this.focusDrawn=false;moving=true;}
                const view=this.smoother.step(pose,delta);
                this.camera.position.set(view.x,1.75,view.z);this.camera.rotation.set(view.pitch,view.yaw,0,'YXZ');
            }
            const key=`${pose.x},${pose.z},${pose.yaw},${pose.pitch}`;
            if(key!==this.lastPose){this.lastPose=key;this.options.onPose?.(pose);}
            if(!this.smoother.settled(pose))moving=true;
        }
        const ambient=this.ambient();
        if(ambient.key!==this.ambientKey){this.ambientKey=ambient.key;this.needsRender=true;}
        if(ambient.layout!==this.ambientLayout){this.ambientLayout=ambient.layout;this.renderer.shadowMap.needsUpdate=true;}
        if(moving||this.needsRender){
            this.needsRender=false;
            this.uploadDirty();
            this.renderer.render(this.scene,this.camera);this.renders++;
            this.updateOverlays(w,h);
        }
        if(moving||ambient.present)this.invalidate(false);else this.idle=true;
    };
    /** Agent avatars (owned by agent-avatars.ts) animate themselves; fingerprint them so idle rooms skip rendering. */
    private ambient():{present:boolean;key:number;layout:number}{
        const group=this.scene.children.find(child=>child.name==='omo-agent-avatars');
        if(!group||!group.children.length)return{present:false,key:0,layout:0};
        let key=17,layout=group.children.length;
        const mix=(h:number,v:number):number=>(Math.imul(h,31)+Math.round(v*1000))|0;
        group.traverse(node=>{
            layout=mix(mix(mix(layout,node.position.x),node.position.z),node.visible?1:0);
            key=mix(mix(mix(mix(mix(key,node.position.y),node.rotation.x),node.rotation.y),node.scale.x),node.visible?1:0);
            if(node instanceof THREE.Sprite)key=mix(key,node.material.map?.id??-1);
        });
        return{present:true,key:mix(key,layout),layout};
    }
    /** Screen-space labels and test/inspection data. Recomputed only when the view or the peers changed. */
    private updateOverlays(w:number,h:number):void{
        const e=this.camera.matrixWorld.elements;
        const view=`${w},${h},${this.navigation},${this.peerVersion},${e[0]},${e[1]},${e[2]},${e[4]},${e[5]},${e[6]},${e[8]},${e[9]},${e[10]},${e[12]},${e[13]},${e[14]}`;
        if(view===this.lastView)return;
        this.lastView=view;
        const {a,b}=this.tmp;
        const toScreen=(v:THREE.Vector3):{x:number;y:number}=>({x:(v.x*.5+.5)*w,y:(-v.y*.5+.5)*h});
        this.setData('peerPositions',JSON.stringify(Object.fromEntries([...this.peerAvatars].map(([id,avatar])=>{
            const p=avatar.root.localToWorld(a.set(0,1.55,0)).project(this.camera);
            return [id,{name:avatar.member.name,...avatar.member.pose,screenX:(p.x*.5+.5)*w,screenY:(-p.y*.5+.5)*h,visible:p.z>=-1&&p.z<=1&&Math.abs(p.x)<1&&Math.abs(p.y)<1}];
        }))));
        const targets: Record<string, { x: number; y: number; visible: boolean }> = {};
        for(const label of this.labels){
            const action = label.dataset.workstation as Workstation;
            const root = this.roots.find(candidate => candidate.userData.workstation === action);
            if (!root) continue;
            const p=a.copy(root.position).add(b.set(0,root.userData.labelHeight ?? (this.navigation==='walk'?2.55:2.9),-.3)).project(this.camera);
            const mesh = this.screens.get(action);
            const distance = mesh ? this.camera.position.distanceTo(mesh.getWorldPosition(b)) : undefined;
            const left=`${Math.round((p.x*0.5+0.5)*w*2)/2}px`,top=`${Math.round((-p.y*0.5+0.5)*h*2)/2}px`;
            const visibility=workstationLabelVisible(this.navigation, p.z, distance) ? 'visible' : 'hidden';
            const placed=`${left} ${top} ${visibility}`;
            // Only touch the style when it changed: every write invalidates style and layout for the page.
            if(this.labelPos.get(label)!==placed){this.labelPos.set(label,placed);label.style.left=left;label.style.top=top;label.style.visibility=visibility;}
            if (mesh) {
                const projected = mesh.getWorldPosition(a).project(this.camera);
                targets[action] = { ...toScreen(projected), visible: projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 };
            }
        }
        if(targets.terminal){this.setData('terminalX',String(targets.terminal.x));this.setData('terminalY',String(targets.terminal.y));}
        this.setData('stationTargets',JSON.stringify(targets));
        const quad=(mesh:THREE.Mesh,x:number,y:number)=>[[-x,y],[x,y],[x,-y],[-x,-y]].map(([qx,qy])=>toScreen(mesh.localToWorld(a.set(qx,qy,0)).project(this.camera)));
        this.setData('terminalQuads',JSON.stringify(Object.fromEntries((['terminal','terminal-2'] as const).map(id => [id,quad(this.screens.get(id)!,.79,.45)]))));
        const code=this.screens.get('code');if(code)this.setData('codeReviewQuad',JSON.stringify(quad(code,.99,.54)));
        const web=this.screens.get('web');if(web)this.setData('webQuad',JSON.stringify(quad(web,1.95,1.22)));
    }
    resetCamera():void{if(this.navigation==='walk'){this.walker?.reset();this.invalidate();return;}this.state={azimuth:0.56,elevation:0.61,distance:24};this.positionCamera();this.options.onCameraChange({...this.state});}
    dispose():void{
        this.setPeers([]);
        this.disposed=true;this.walker?.dispose();cancelAnimationFrame(this.frame);this.scheduled=false;this.observer?.disconnect();this.cleanup.forEach(fn=>fn());this.labels.forEach(label=>label.remove());
        this.scene.traverse(node=>{if(node instanceof THREE.Mesh){node.geometry.dispose();const ms=Array.isArray(node.material)?node.material:[node.material];ms.forEach(m=>{(m as THREE.MeshStandardMaterial).map?.dispose();m.dispose();});}});
        if(this.renderer){this.renderer.dispose();this.renderer.domElement.remove();}
    }
}

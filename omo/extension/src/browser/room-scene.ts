import * as THREE from 'three';
import type { RoomState, RoomTheme } from '../common/room-state';
import { FirstPersonControls } from './first-person-controls';
import { cellRuns, dominantKey, MONITOR_COLS, MONITOR_ROWS } from './runtime-console-controller';
import type { WebSurfaceFrame } from '../common/web-runtime-protocol';
import { MonitorSelection, monitorCell, monitorCellSpan, visibleMonitorCells } from '../common/monitor-selection';
import type { SelectionUnit } from '../common/monitor-selection';
import type { RoomMember } from '../common/presence-protocol';
import { PLAYER_HOME, PlayerPose } from '../common/player-state';
import { CodeReviewFrame, codeReviewPreview } from '../common/code-review-preview';
export type { CodeReviewFrame } from '../common/code-review-preview';

/** What the physical terminal monitor shows: runtime frame rows plus optional per-cell colour keys and cursor. */
export interface MonitorFrame {
    lines: string[];
    cells?: string[][];
    unreadBells?: number;
    foreground?: string[];
    background?: string[];
    palette?: Record<string, string>;
    cursor?: { x: number; y: number; visible: boolean };
    title?: string;
    status?: string;
}

export type Workstation = 'terminal' | 'terminal-2' | 'code' | 'web';
export type TerminalWorkstation = 'terminal' | 'terminal-2';
export interface ScreenPoint { x: number; y: number }

export interface RoomSceneOptions {
    theme: RoomTheme;
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
}

/** Original, asset-free scene. The IDE remains the authority for all real work. */
export class RoomScene {
    private renderer!: THREE.WebGLRenderer;
    private scene = new THREE.Scene();
    private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 150);
    private state: RoomState['camera'];
    private frame = 0;
    private observer?: ResizeObserver;
    private disposed = false;
    private roots: THREE.Object3D[] = [];
    private labels: HTMLButtonElement[] = [];
    private walker?: FirstPersonControls;
    private navigation: 'walk' | 'overview' = 'overview';
    private lastFrame = performance.now();
    private terminalSurfaces = new Map<TerminalWorkstation, { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; cellWidth?: number }>();
    private terminalSelection?: { station: TerminalWorkstation; model: MonitorSelection };
    private terminalFrames: Record<TerminalWorkstation, MonitorFrame> = { terminal: { lines: [] }, 'terminal-2': { lines: [] } };
    private screens = new Map<Workstation, THREE.Mesh>();
    private lamps = new Map<TerminalWorkstation, THREE.Mesh>();
    private webSurface?: HTMLCanvasElement;
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
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
        this.bindControls(canvas);
        this.walker = new FirstPersonControls(canvas, this.camera, (x,y)=>this.interactAt(x,y), text=>this.options.onInput(text), text=>this.options.onMessage(text), this.options.onPaste, {
            start: (x,y,unit) => this.startTerminalSelection(x,y,unit), move: (x,y) => this.extendTerminalSelection(x,y),
            end: () => this.options.onMessage('Selected visible terminal text · Ctrl+Shift+C to copy. Esc to clear.'),
            clear: () => this.clearTerminalSelection(), copy: () => this.copyTerminalSelection()
        });
        this.setNavigation(this.options.walk ? 'walk' : 'overview');
        this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(this.host);
        this.resize(); this.positionCamera(); this.draw(); this.options.onReady();
    }
    getPlayerPose():PlayerPose { return {...(this.walker?.pose ?? PLAYER_HOME)}; }
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
        this.desk(root, -2.65, 0.5, 'terminal', jungle);
        this.desk(root, 2.25, -0.45, 'terminal-2', jungle);
        this.webWall(root);
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
        frame.lines.forEach((line,i)=>{ctx.fillStyle=line.startsWith('+')?'#91e4ac':line.startsWith('-')?'#f1a49c':'#d7e3df';ctx.fillText(line,24,70+i*21,976);});ctx.fillStyle='#8ea5aa';ctx.font='14px monospace';ctx.fillText(frame.status.slice(0,110),24,564,976);surface.texture.needsUpdate=true;
        this.renderer.domElement.dataset.codeReviewText=frame.lines.join('\n');
        this.renderer.domElement.dataset.codeReviewStatus=frame.status;
    }
    private desk(parent: THREE.Object3D, x: number, z: number, action: Workstation, jungle: boolean): void {
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
        this.host.appendChild(label); this.labels.push(label);
    }
    private screenTexture(action: Workstation): THREE.CanvasTexture {
        if(action==='terminal' || action==='terminal-2'){
            const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=576;
            const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
            this.terminalSurfaces.set(action, { canvas, texture });
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
        this.webTexture.needsUpdate = true;
    }
    setWebFrame(frame: WebSurfaceFrame): void {
        const epoch = ++this.webEpoch;
        this.webSize = { width: frame.surface.width, height: frame.surface.height };
        const image = new Image();
        image.onload = () => {
            if (this.disposed || epoch !== this.webEpoch || !this.webSurface || !this.webTexture) return;
            const c = this.webSurface.getContext('2d')!;
            c.drawImage(image, 0, 0, this.webSurface.width, this.webSurface.height);
            this.webTexture.needsUpdate = true;
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
        if (this.renderer) { this.renderer.domElement.dataset.navigation = mode; }
        this.labels.forEach(label => label.classList.toggle('is-walk', mode === 'walk'));
        this.positionCamera();
    }
    setTerminalLines(lines: string[]): void { this.setTerminalFrame({ ...this.terminalFrames.terminal, lines, cells: undefined, foreground: undefined, background: undefined, cursor: undefined }); }
    setTerminalFrames(frames: Record<TerminalWorkstation, MonitorFrame>): void {
        this.setTerminalFrame(frames.terminal, 'terminal'); this.setTerminalFrame(frames['terminal-2'], 'terminal-2');
    }
    setTerminalFrame(frame: MonitorFrame, station: TerminalWorkstation = 'terminal'): void {
        const previous = this.terminalFrames[station];
        if (this.terminalSelection?.station === station && (!this.terminalSelection.model.refresh(frame.lines,frame.cells) || previous.title !== frame.title || previous.status !== frame.status)) this.terminalSelection = undefined;
        this.terminalFrames[station] = frame;
        const surface = this.terminalSurfaces.get(station);
        if (!surface) return;
        const c = surface.canvas.getContext('2d')!;
        const base = '#091119';
        c.fillStyle = base; c.fillRect(0,0,1024,576);
        c.fillStyle = '#87cdb4'; c.font = '17px monospace'; c.fillText((frame.title ?? 'OMO / LIVE PROJECT TERMINAL').slice(0,52),24,29);
        if (frame.status || frame.unreadBells) { c.fillStyle = frame.unreadBells ? '#ff9e4a' : '#7e9a9e'; c.textAlign = 'right'; c.fillText((frame.unreadBells ? `BELL (${frame.unreadBells})` : frame.status ?? '').slice(0,38),1000,29); c.textAlign = 'left'; }
        c.fillStyle = '#283e48'; c.fillRect(20,42,984,1);
        c.font = '20px monospace'; c.textBaseline = 'alphabetic';
        const rows = visibleMonitorCells(frame.lines,frame.cells), lines = rows.map(row=>row.join(''));
        if (!lines.length) {
            c.fillStyle='#c7ded4';c.fillText('Walk up and click this screen.',24,104);
            c.fillStyle='#7e9a9e';c.fillText((frame.status ?? '').slice(0,MONITOR_COLS),24,140);
        } else {
            const offset = frame.lines.length - lines.length;
            const cell = Math.min(12.3, c.measureText('M').width || 12);
            surface.cellWidth = cell;
            // The frame's most common background is the terminal's own background; the monitor keeps its accepted base colour for it.
            const plainBg = frame.background ? frame.palette?.[dominantKey(frame.background) ?? ''] : undefined;
            const skip = plainBg ? (plainBg.startsWith('#') ? plainBg : `#${plainBg}`).toLowerCase() : base;
            lines.forEach((line,i) => {
                const y = 70 + i*22; const text = line;
                const fallback = { fg: frame.foreground ? '#e0e8eb' : line.includes('$') ? '#b8e6ca' : '#e0e8eb', bg: base };
                const runs = cellRuns(text, frame.foreground?.[offset+i], frame.background?.[offset+i], frame.palette, fallback, frame.cells === undefined ? undefined : rows[i]);
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
            });
            const cursor = frame.cursor;
            if (cursor?.visible && cursor.y - offset >= 0 && cursor.y - offset < MONITOR_ROWS && cursor.x >= 0 && cursor.x < MONITOR_COLS) {
                const row = rows[cursor.y-offset] ?? [], span = monitorCellSpan(row,cursor.x);
                const x = 24+span.from*cell, y = 70+(cursor.y-offset)*22, width = (span.to-span.from)*cell;
                c.fillStyle = '#b8e6ca'; c.fillRect(x,y-17,width,22);
                const ch = row[span.from];
                if (ch && ch !== ' ') { c.fillStyle = base; c.fillText(ch,x,y,width); }
            }
            if (this.terminalSelection?.station === station) {
                c.fillStyle = 'rgba(65,150,240,0.45)';
                for (const span of this.terminalSelection.model.spans()) c.fillRect(24 + span.from*cell, 53 + span.row*22, (span.to-span.from)*cell, 22);
            }
        }
        surface.texture.needsUpdate = true;
        const lamp = this.lamps.get(station);
        if (lamp) {
            const color = /interrupted|exited|error/i.test(frame.status ?? '') ? 0xd26464 : frame.unreadBells ? 0xff9e4a : /working/i.test(frame.status ?? '') ? 0xe8bd60 : /live|running/i.test(frame.status ?? '') ? 0x87cdb4 : 0x6d7c86;
            const material = lamp.material as THREE.MeshStandardMaterial; material.color.setHex(color); material.emissive.setHex(color);
        }
        if(this.renderer){
            this.renderer.domElement.dataset.terminalSelection = this.terminalSelection?.model.text() ?? '';
            this.renderer.domElement.dataset.terminalSelectionStation = this.terminalSelection?.station ?? '';
            this.renderer.domElement.dataset.terminalMetrics = JSON.stringify(Object.fromEntries([...this.terminalSurfaces].map(([id,s]) => [id,{ cellWidth:s.cellWidth ?? 12 }])));
            if (station === 'terminal') { this.renderer.domElement.dataset.terminalText=frame.lines.join('\n');this.renderer.domElement.dataset.terminalCursor=frame.cursor?`${frame.cursor.x},${frame.cursor.y},${frame.cursor.visible}`:''; }
            this.renderer.domElement.dataset.stationText = JSON.stringify({ terminal: this.terminalFrames.terminal.lines, 'terminal-2': this.terminalFrames['terminal-2'].lines });
            this.renderer.domElement.dataset.stationCells = JSON.stringify({ terminal:this.terminalFrames.terminal.cells,'terminal-2':this.terminalFrames['terminal-2'].cells });
            this.renderer.domElement.dataset.stationBells = JSON.stringify({ terminal: this.terminalFrames.terminal.unreadBells ?? 0, 'terminal-2': this.terminalFrames['terminal-2'].unreadBells ?? 0 });
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
    private interactAt(x: number, y: number): 'terminal' | 'code' | undefined {
        const rect=this.renderer.domElement.getBoundingClientRect();
        const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1),this.camera);
        for(const hit of ray.intersectObjects(this.roots,true)){
            let node:THREE.Object3D|null=hit.object;while(node&&!node.userData.workstation)node=node.parent;
            const action=node?.userData.workstation as Workstation|undefined;
            if(!action)continue;
            const screen = this.screens.get(action); if (!screen) continue;
            const center = screen.getWorldPosition(new THREE.Vector3());
            if(this.camera.position.distanceTo(center)>3.2){this.options.onMessage('Walk closer to the workstation.');return;}
            const point = action === 'web' && hit.object === screen && hit.uv ? { x: Math.min(this.webSize.width-1, Math.max(0, hit.uv.x*this.webSize.width)), y: Math.min(this.webSize.height-1, Math.max(0, (1-hit.uv.y)*this.webSize.height)) } : undefined;
            this.options.onSelect(action, point);return action === 'code' ? 'code' : 'terminal';
        }
        return undefined;
    }
    private positionCamera(): void {
        if (this.navigation === 'walk') { this.walker?.step(0); return; }
        const {azimuth:a,elevation:e,distance:d}=this.state;
        const fit = Math.max(1, 1.28 / this.camera.aspect);
        this.camera.position.set(Math.sin(a)*Math.cos(e)*d*fit,Math.sin(e)*d*fit,Math.cos(a)*Math.cos(e)*d*fit);
        this.camera.lookAt(0,0.7,0);
    }
    private resize():void {
        const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;
        this.renderer.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.positionCamera();
    }
    private draw=():void=>{
        if(this.disposed)return;
        const now=performance.now();const delta=(now-this.lastFrame)/1000;this.lastFrame=now;
        if(this.host.clientWidth&&this.host.clientHeight){
            this.walker?.step(delta);
            this.renderer.render(this.scene,this.camera);
            this.renderer.domElement.dataset.peerPositions=JSON.stringify(Object.fromEntries([...this.peerAvatars].map(([id,avatar])=>{
                const p=avatar.root.localToWorld(new THREE.Vector3(0,1.55,0)).project(this.camera);
                return [id,{name:avatar.member.name,...avatar.member.pose,screenX:(p.x*.5+.5)*this.host.clientWidth,screenY:(-p.y*.5+.5)*this.host.clientHeight,visible:p.z>=-1&&p.z<=1&&Math.abs(p.x)<1&&Math.abs(p.y)<1}];
            })));
            const targets: Record<string, { x: number; y: number; visible: boolean }> = {};
            this.labels.forEach((label,i)=>{
                const root = this.roots[i], action = root.userData.workstation as Workstation;
                const p=new THREE.Vector3().copy(root.position).add(new THREE.Vector3(0,root.userData.labelHeight ?? (this.navigation==='walk'?2.55:2.9),-.3)).project(this.camera);
                label.style.left=`${(p.x*0.5+0.5)*this.host.clientWidth}px`;label.style.top=`${(-p.y*0.5+0.5)*this.host.clientHeight}px`;
                const mesh = this.screens.get(action);
                // A distant HTML label has no 3D depth test: it can otherwise sit on
                // foreground terminal text and steal selection from the canvas.
                const codeOutOfReach=action==='code'&&this.navigation==='walk'&&(!mesh||this.camera.position.distanceTo(mesh.getWorldPosition(new THREE.Vector3()))>3.2);
                label.style.visibility=p.z>1||p.z< -1||codeOutOfReach?'hidden':'visible';
                if (mesh) {
                    const projected = mesh.getWorldPosition(new THREE.Vector3()).project(this.camera);
                    const point = { x: (projected.x*.5+.5)*this.host.clientWidth, y: (-projected.y*.5+.5)*this.host.clientHeight, visible: projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 };
                    targets[action] = point;
                    if (action === 'terminal') { this.renderer.domElement.dataset.terminalX = String(point.x); this.renderer.domElement.dataset.terminalY = String(point.y); }
                }
            });
            this.renderer.domElement.dataset.stationTargets = JSON.stringify(targets);
            this.renderer.domElement.dataset.terminalQuads = JSON.stringify(Object.fromEntries((['terminal','terminal-2'] as const).map(id => {
                const screen = this.screens.get(id)!;
                return [id,[[-.79,.45],[.79,.45],[.79,-.45],[-.79,-.45]].map(([x,y]) => { const p=screen.localToWorld(new THREE.Vector3(x,y,0)).project(this.camera); return {x:(p.x*.5+.5)*this.host.clientWidth,y:(-p.y*.5+.5)*this.host.clientHeight}; })];
            })));
            const web = this.screens.get('web');
            const code=this.screens.get('code');
            if(code)this.renderer.domElement.dataset.codeReviewQuad=JSON.stringify([[-.99,.54],[.99,.54],[.99,-.54],[-.99,-.54]].map(([x,y])=>{const p=code.localToWorld(new THREE.Vector3(x,y,0)).project(this.camera);return{x:(p.x*.5+.5)*this.host.clientWidth,y:(-p.y*.5+.5)*this.host.clientHeight};}));
            if (web) this.renderer.domElement.dataset.webQuad = JSON.stringify([[-1.95,1.22],[1.95,1.22],[1.95,-1.22],[-1.95,-1.22]].map(([x,y]) => { const p = web.localToWorld(new THREE.Vector3(x,y,0)).project(this.camera); return { x: (p.x*.5+.5)*this.host.clientWidth, y: (-p.y*.5+.5)*this.host.clientHeight }; }));
            this.renderer.domElement.dataset.stationLamps = JSON.stringify(Object.fromEntries([...this.lamps].map(([id,mesh]) => [id,(mesh.material as THREE.MeshStandardMaterial).color.getHexString()])));
        }
        this.frame=requestAnimationFrame(this.draw);
    };
    resetCamera():void{if(this.navigation==='walk'){this.walker?.reset();return;}this.state={azimuth:0.56,elevation:0.61,distance:24};this.positionCamera();this.options.onCameraChange({...this.state});}
    dispose():void{
        this.setPeers([]);
        this.disposed=true;this.walker?.dispose();cancelAnimationFrame(this.frame);this.observer?.disconnect();this.cleanup.forEach(fn=>fn());this.labels.forEach(label=>label.remove());
        this.scene.traverse(node=>{if(node instanceof THREE.Mesh){node.geometry.dispose();const ms=Array.isArray(node.material)?node.material:[node.material];ms.forEach(m=>{(m as THREE.MeshStandardMaterial).map?.dispose();m.dispose();});}});
        if(this.renderer){this.renderer.dispose();this.renderer.domElement.remove();}
    }
}

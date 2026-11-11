import * as THREE from 'three';
import type { RoomState, RoomTheme } from '../common/room-state';
import { FirstPersonControls } from './first-person-controls';
import { cellRuns, dominantKey, MONITOR_COLS, MONITOR_ROWS } from './runtime-console-controller';
import type { WebSurfaceFrame } from '../common/web-runtime-protocol';
import { MonitorSelection, monitorCell, monitorCellSpan, visibleMonitorCells } from '../common/monitor-selection';
import type { SelectionUnit } from '../common/monitor-selection';
import type { RoomMember } from '../common/presence-protocol';
import { PLAYER_HOME, PlayerPose } from '../common/player-state';
import type { RoomLayoutId, RoomKitId } from '../common/player-state';
import type { RuntimeColorMetadata } from '../common/runtime-protocol';
import { terminalLinks } from '../common/terminal-links';
import { CodeReviewFrame, codeReviewPreview } from '../common/code-review-preview';
import { workstationLabelVisible, layoutLabels, declutterLabels, chipText } from './workstation-label-visibility'; // t3:polish2 layoutLabels; w3:look declutter + chips
import { PoseSmoother } from './movement-smoothing';
// w2:render — the room is built from a WorldSpec (shared contract) by the world scene builders.
import type { WorldEntity, WorldSpec } from '../common/world-model';
import { validateWorld } from '../common/world-model';
import { buildShell, nearWall, shellColors } from './world-scene-shell';
import type { OrbSpot } from './world-scene-shell';
import { BuiltEntity, placeRoot, buildDecorEntity, buildMirror, buildMonitorWall, buildReviewScreen, buildStation, buildWebWall, entityTitle, legacyRoomWorld } from './world-scene-entities';
import { disposeTree, freeze as freezeTree, refreeze } from './world-scene-kit';
import { footprints, roomFootprints, worldHome, worldMover } from './world-scene-collision';
import { buildRoom, setRoomCutaway } from './world-scene-rooms'; // w3:render
import { openSky } from './world-scene-open'; // w3:render
import { cameraClip, overviewFrame, shadowFrame, terminalFar, worldFog, worldScale, V1_SUN } from './world-scene-scale'; // w3:render; w3:look overviewFrame
import { refreeze as refreezeNode } from './world-scene-kit'; // w3:render
import { MonitorPaintBudget } from './monitor-paint-budget'; // w3:perf
import { buildPaths, pathsKey } from './world-scene-paths'; // w3:look (7)
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
/**
 * The physical monitor's 80 x 22 window of a frame. A desk attached in focus mode can have a larger
 * real grid (e.g. 160 x 45); the monitor then shows the first 80 columns of the 22 rows around the
 * cursor (the last 22 when there is no cursor). A frame that already fits is returned as is.
 * Malformed metadata is dropped, never trusted: the monitor only crops, it never crashes.
 */
export function monitorWindow(frame: MonitorFrame): MonitorFrame {
    const lines = Array.isArray(frame.lines) ? frame.lines : [];
    const wide = (row: unknown): boolean => typeof row === 'string' ? Array.from(row).length > MONITOR_COLS : Array.isArray(row) && row.length > MONITOR_COLS;
    if (lines === frame.lines && lines.length <= MONITOR_ROWS && !lines.some(wide) && !frame.cells?.some(wide)
        && !frame.truecolor?.foreground.some(wide) && !frame.truecolor?.background.some(wide)) return frame;
    const cursorY = frame.cursor && Number.isSafeInteger(frame.cursor.y) ? frame.cursor.y : lines.length - 1;
    const end = Math.max(Math.min(MONITOR_ROWS, lines.length), Math.min(lines.length, cursorY + 1)), start = Math.max(0, end - MONITOR_ROWS);
    const rows = <T,>(list: readonly T[] | undefined): T[] | undefined => Array.isArray(list) ? list.slice(start, end) : undefined;
    const cut = (row: unknown): string => typeof row === 'string' ? Array.from(row).slice(0, MONITOR_COLS).join('') : '';
    const cells = frame.cells === undefined ? undefined : rows(frame.cells)!.map(row => Array.isArray(row) ? row.slice(0, MONITOR_COLS) : []);
    const truecolor = frame.truecolor && Array.isArray(frame.truecolor.foreground) && Array.isArray(frame.truecolor.background)
        ? { foreground: rows(frame.truecolor.foreground)!.map(row => Array.isArray(row) ? row.slice(0, MONITOR_COLS) : []), background: rows(frame.truecolor.background)!.map(row => Array.isArray(row) ? row.slice(0, MONITOR_COLS) : []) }
        : undefined;
    const cursor = frame.cursor ? { ...frame.cursor, y: frame.cursor.y - start, visible: frame.cursor.visible && frame.cursor.y >= start && frame.cursor.y < end && frame.cursor.x < MONITOR_COLS } : undefined;
    return { ...frame, lines: lines.slice(start, end).map(cut), cells, foreground: rows(frame.foreground)?.map(cut), background: rows(frame.background)?.map(cut), truecolor, cursor };
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

/**
 * v1 workstation ids. w2:render: a WorldSpec can hold any number of stations, monitor walls and mirrors;
 * their ids (lowercase, stable) are passed through these types by cast, as the runtime lane does.
 */
export type Workstation = 'terminal' | 'terminal-2' | 'code' | 'web' | 'mirror';
export type TerminalWorkstation = 'terminal' | 'terminal-2';
/** w2:render — v1 ids keep their exact v1 labels (tests and muscle memory rely on them). */
const LEGACY_LABELS: Record<string, { text: string; aria: string }> = {
    terminal: { text: '01  Desk one ↗', aria: 'Open project terminal' },
    'terminal-2': { text: '02  Desk two ↗', aria: 'Open second project terminal' },
    web: { text: '03  Web wall ↗', aria: 'Use physical web wall' },
    code: { text: '04  Code review ↗', aria: 'Review project changes' },
    mirror: { text: '05  Mirror · Desk one ↗', aria: 'Use linked monitor mirror' } // t3:polish2 — was a second '04' (code review owns 04)
};
/** One built entity: its THREE root, label and the key it was built from (rebuilt only when the key changes). */
interface SceneEntity { entity: WorldEntity; key: string; built: BuiltEntity; label?: HTMLButtonElement }
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
    /** w2:render — empty-screen hint (linked walls) and the last painted linked input. */
    hint?: string;
    linkSource?: unknown;
    /** w3:render — far from the player: keeps its last painted frame until the player comes nearer. */
    parked?: boolean;
}
const SURFACE_W = 1024, SURFACE_H = 576;
/**
 * The station theme's back-wall orb (globe + ring), v1 room coordinates. Data-driven so a lane that moves
 * it changes only this constant (the shell builder applies it to any shell size).
 */
const ORB: OrbSpot = { x: -2.9, y: 2.2, z: -4.2, ringZ: -4.1, scale: 0.62 }; // w2:polish — clear of the web wall
/** Cap fill-rate cost on HiDPI screens. The room is mostly flat colour, so 1.5x is visually equal. */
const MAX_PIXEL_RATIO = 1.5;
/**
 * Dynamic resolution while the view moves. Frame cost on slow machines scales with canvas pixels, so
 * when sustained motion misses the frame budget the drawing buffer steps down (never below 0.75x CSS px)
 * and steps back up after a long clean run. A still view is always redrawn at full resolution.
 */
const SCALE_STEPS = [1, 0.85, 0.72, 0.6, 0.5];
/** Never below this many drawing-buffer pixels per CSS pixel, even at the lowest step. */
const MIN_PIXEL_RATIO = 0.75;
/** A still view is redrawn sharp after this pause (a short stop between keys keeps the reduced step). */
const SHARPEN_DELAY_MS = 350;
/** A rendered interval above SLOW_FRAME_MS missed a 60 Hz vsync. SLOW_LIMIT misses in a window step down. */
const SLOW_FRAME_MS = 25, SLOW_LIMIT = 2, SCALE_WINDOW = 30, SCALE_DOWN_COOLDOWN_MS = 500, SCALE_UP_COOLDOWN_MS = 4000;
/** Inspection data (dataset JSON) while the view moves: at most this often; always once when it settles. */
const DATA_INTERVAL_MS = 150;
/** onPose (React-side consumers) while walking: at most this often; always once when movement stops. */
const POSE_INTERVAL_MS = 200;
/** Ambient-only motion (avatars bobbing while the player stands still) draws at ~30 fps. */
const AMBIENT_FRAME_MS = 32;

export interface RoomSceneOptions {
    theme: RoomTheme;
    layout?: RoomLayoutId;
    kit?: RoomKitId;
    /** w2:render — the world to draw. Omitted = the v1 room of theme/layout/kit (looks exactly like v1). */
    world?: WorldSpec;
    camera: RoomState['camera'];
    onSelect: (station: Workstation, point?: ScreenPoint) => void;
    onTextSelect: (station: TerminalWorkstation) => void;
    onCameraChange: (camera: RoomState['camera']) => void;
    onReady: () => void;
    walk?: boolean;
    onInput: (text: string) => void;
    onPaste?: (text: string) => void;
    onScroll?: (deltaY: number) => void;
    /** omo webscroll lane: wheel over the web wall, at the page pixel under the pointer. */
    onWebScroll?: (point: ScreenPoint, deltaY: number, deltaX: number) => void;
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
    private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400); // w3:render — far >= 400 (was 150); scaled per world in applyScaleView()
    private state: RoomState['camera'];
    private frame = 0;
    /** Render on demand: one rAF at most is ever pending; idle rooms render nothing. */
    private scheduled = false;
    private idle = true;
    private needsRender = true;
    private focusDrawn = false;
    private lastPose = { x: NaN, z: NaN, yaw: NaN, pitch: NaN, at: 0, pending: false };
    private readonly lastView = new Float64Array(19).fill(NaN);
    private lastData = 0;
    private dataPending = false;
    private lastAmbientRender = 0;
    private readonly ambientTicks = new Set<(seconds: number) => boolean>();
    private scaleStep = 0;
    private scaleChangedAt = 0;
    private frameCount = 0;
    private slowFrames = 0;
    /** The reduced step in use before the view settled; restored when motion resumes. */
    private sharpStep = 0;
    private sharpTimer?: number;
    private lastRenderAt = 0;
    /** Opt out with localStorage 'omo.dynamicResolution' = '0'. */
    private readonly dynamicResolution = (() => { try { return localStorage.getItem('omo.dynamicResolution') !== '0'; } catch { return true; } })();
    private peerVersion = 0;
    private readonly smoother = new PoseSmoother();
    private data = new Map<string, string>();
    private labelPos = new WeakMap<HTMLElement, number>();
    private labelSize = new WeakMap<HTMLElement, { w: number; h: number }>(); // t3:polish2 — measured once per text
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
    // w2:render — everything below is keyed by station / entity id (v1 ids 'terminal', 'terminal-2', 'web', 'code', 'mirror').
    private terminalSurfaces = new Map<string, ScreenSurface>();
    private terminalSelection?: { station: string; model: MonitorSelection };
    private terminalFrames: Record<string, MonitorFrame> = { terminal: { lines: [] }, 'terminal-2': { lines: [] } };
    private screens = new Map<string, THREE.Mesh>();
    private lamps = new Map<string, THREE.Mesh>();
    /** The WorldSpec on screen, its built entities, the shell group and its key. */
    private world!: WorldSpec;
    private entities = new Map<string, SceneEntity>();
    private worldRoot = new THREE.Group();
    private shellRoot?: THREE.Group;
    private shellKey = '';
    /** Screens of linked monitor walls / extra mirrors: own canvas each, painted with the linked station's frame. */
    private linkedSurfaces = new Map<string, ScreenSurface>();
    private linkedFrames = new Map<string, MonitorFrame>();
    private stationNumbers = new Map<string, number>();
    private lights?: { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight; accent: THREE.PointLight };
    /** Overview camera distance scale for shells larger than the v1 12 x 10 room. */
    private roomScale = 1;
    private webSurface?: HTMLCanvasElement;
    private mirrorSurface?: HTMLCanvasElement;
    private mirrorTexture?: THREE.CanvasTexture;
    private paintBudget?: MonitorPaintBudget;
    private homeKey?: string; // w3:look (6)
    /** w3:fps — optional frame counter: add ?fps=1 to the app URL or run localStorage.setItem('omo.fps','1'). */
    private fpsEl?: HTMLElement | null; private fpsFrames = 0; private fpsT0 = 0;
    private fpsTick(): void {
        if (this.fpsEl === undefined) {
            let on = false; try { on = /[?&]fps=1/.test(location.search) || localStorage.getItem('omo.fps') === '1'; } catch { /* no storage */ }
            this.fpsEl = on ? Object.assign(document.createElement('div'), { className: 'omo-fps' }) : null;
            if (this.fpsEl) { this.fpsEl.dataset.testid = 'omo-fps'; this.fpsEl.style.cssText = 'position:absolute;left:8px;top:8px;z-index:20;padding:2px 8px;border-radius:6px;background:rgba(10,16,24,.72);color:#9ff0c8;font:600 12px ui-monospace,monospace;pointer-events:none'; this.host.appendChild(this.fpsEl); }
        }
        if (!this.fpsEl) return;
        const now = performance.now(); if (!this.fpsT0) this.fpsT0 = now; this.fpsFrames++;
        if (now - this.fpsT0 >= 1000) { const fps = this.fpsFrames * 1000 / (now - this.fpsT0); this.fpsEl.textContent = `${fps.toFixed(0)} fps · ${this.world?.entities.filter(e => e.kind === 'station').length ?? 0} desks`; this.fpsEl.dataset.fps = fps.toFixed(1); this.fpsFrames = 0; this.fpsT0 = now; }
    }
    private pathsKey = ''; private pathsRoot?: THREE.Group; // w3:look (7)
    private mirrorFrame: MonitorFrame = { lines: [] };
    /** Last full-size frame per desk and its 80 x 22 monitor window, so a re-render reuses the same object. */
    private terminalSources?: Map<string, { input: MonitorFrame; frame: MonitorFrame }>;
    private deskLabels = new Map<string, HTMLButtonElement>();
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
        // w2:render — the world to draw: the given WorldSpec, else the v1 room (same look as before).
        const given = this.options.world ? validateWorld(this.options.world) : undefined;
        if (given && !given.ok) this.options.onError(`This world could not be drawn: ${given.error} Showing the classic room.`);
        const world = given?.ok ? given.world : legacyRoomWorld({ theme: this.options.theme, layout: this.options.layout, kit: this.options.kit });
        const colors = shellColors(world.shell.theme === 'jungle');
        this.scene.background = new THREE.Color(colors.background);
        this.scene.fog = new THREE.Fog(colors.background, 33, 65);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(this.pixelRatio());
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
        const hemi = new THREE.HemisphereLight(colors.hemiSky, 0x283136, 2.3); this.scene.add(hemi);
        const sun = new THREE.DirectionalLight(colors.sun, 4);
        sun.position.set(-5, 12, 8); sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
        sun.shadow.bias = -0.001; sun.shadow.normalBias = 0.025;
        this.scene.add(sun);
        const accent = new THREE.PointLight(colors.accent, 25, 18);
        accent.position.set(0, 4, -2); this.scene.add(accent);
        this.lights = { hemi, sun, accent };
        this.freeze(this.scene.children);
        // Shared surfaces outlive world rebuilds: the web wall page, the classic mirror and the code review screen.
        this.createSurfaces();
        this.worldRoot.name = 'omo-world'; this.scene.add(this.worldRoot); freezeTree(this.worldRoot);
        // Ambient modules (agent avatars) join this loop through scene.userData instead of running their own rAF.
        this.scene.userData.omoAmbient = {
            add: (tick: (seconds: number) => boolean): (() => void) => { this.ambientTicks.add(tick); this.invalidate(); return () => { this.ambientTicks.delete(tick); this.invalidate(); }; },
            invalidate: (shadows = false): void => { if (shadows && this.renderer) this.renderer.shadowMap.needsUpdate = true; this.invalidate(); }
        };
        canvas.dataset.roomLayout = this.options.layout ?? 'classic';
        this.bindControls(canvas);
        this.bindWake(canvas);
        this.walker = new FirstPersonControls(canvas, this.camera, (x,y,modifiers)=>this.interactAt(x,y,modifiers), text=>this.options.onInput(text), text=>this.options.onMessage(text), this.options.onPaste, {
            start: (x,y,unit) => this.startTerminalSelection(x,y,unit), move: (x,y) => this.extendTerminalSelection(x,y),
            end: () => this.options.onMessage('Selected visible terminal text · Ctrl+Shift+C to copy.'),
            clear: () => this.clearTerminalSelection(), copy: () => this.copyTerminalSelection()
        }, this.options.layout ?? 'classic', shortcut => this.options.onShortcut?.(shortcut));
        this.applyWorld(world);
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
    // ------------------------------------------------------------------ w2:render — world from a WorldSpec
    /** Surfaces shared by every world: the web page, the classic mirror and the code review screen. */
    private createSurfaces(): void {
        const code = document.createElement('canvas'); code.width = 1024; code.height = 576;
        const codeTexture = new THREE.CanvasTexture(code); codeTexture.colorSpace = THREE.SRGBColorSpace; this.codeSurface = { canvas: code, texture: codeTexture };
        this.webSurface = document.createElement('canvas'); this.webSurface.width = 960; this.webSurface.height = 600;
        this.webTexture = new THREE.CanvasTexture(this.webSurface); this.webTexture.colorSpace = THREE.SRGBColorSpace;
        this.mirrorSurface = document.createElement('canvas'); this.mirrorSurface.width = 1024; this.mirrorSurface.height = 576;
        this.mirrorTexture = new THREE.CanvasTexture(this.mirrorSurface); this.mirrorTexture.colorSpace = THREE.SRGBColorSpace;
        this.setCodeReview({ title: 'PROJECT CHANGES', lines: ['Open this screen to read real Git changes.', 'Patches are read only. Files stay in your editor.'], status: 'No Git contents read yet' });
        this.setWebPlaceholder('Click the web wall, then open an address.');
        this.setMirrorFrame({ lines: [], title: 'LINKED MONITOR', status: 'Link this screen to a desk above.' });
    }
    /** A terminal-style monitor surface (unflipped upload, so a changed row band maps 1:1 to a sub-rectangle). */
    private terminalSurface(hint?: string): ScreenSurface {
        const canvas = document.createElement('canvas'); canvas.width = SURFACE_W; canvas.height = SURFACE_H;
        const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false; texture.repeat.set(1, -1); texture.offset.set(0, 1);
        const source = new THREE.CanvasTexture(canvas); source.flipY = false;
        return { canvas, texture, source, ctx: canvas.getContext('2d') ?? undefined, hint };
    }
    private disposeSurface(surface: ScreenSurface | undefined): void { surface?.texture.dispose(); surface?.source?.dispose(); }
    /** The WorldSpec on screen (a copy). */
    getWorld(): WorldSpec { return JSON.parse(JSON.stringify(this.world)); }
    /**
     * Draw a new WorldSpec. Incremental by entity id: unchanged entities stay, moved ones are moved,
     * changed ones are rebuilt, removed ones are disposed. Station screens keep their live frames.
     * Throws on an invalid world (the room keeps the previous one).
     */
    setWorld(world: WorldSpec): void {
        if (this.disposed || !this.renderer) return;
        const result = validateWorld(world);
        if (!result.ok) throw new Error(result.error);
        this.applyWorld(JSON.parse(JSON.stringify(result.world)));
    }
    private applyWorld(world: WorldSpec): void {
        const previous = this.world; this.world = world;
        const jungle = world.shell.theme === 'jungle';
        if (previous && previous.shell.theme !== world.shell.theme) this.applyTheme(jungle);
        this.applySky(world); // w3:render — open worlds: sky/horizon colour instead of the dark room backdrop
        const stations = world.entities.filter(e => e.kind === 'station');
        this.stationNumbers = new Map(stations.map((e, i) => [e.id, i + 1]));
        const blocks = [...footprints(world), ...roomFootprints(world)]; // w3:render — no ambient props inside rooms
        // Shell: rebuilt only when its size/theme or the footprints that hide ambient props change.
        const shellKey = JSON.stringify([world.shell, blocks]);
        if (shellKey !== this.shellKey) {
            if (this.shellRoot) { this.worldRoot.remove(this.shellRoot); disposeTree(this.shellRoot); }
            this.shellRoot = buildShell(world.shell, blocks, ORB); this.worldRoot.add(this.shellRoot); freezeTree(this.shellRoot); this.shellKey = shellKey;
        }
        const pk = pathsKey(world.shell, world.entities); // w3:look (7) — plaza, paths, lamps (open worlds)
        if (pk !== this.pathsKey) {
            if (this.pathsRoot) { this.worldRoot.remove(this.pathsRoot); disposeTree(this.pathsRoot); this.pathsRoot = undefined; }
            const built = buildPaths(world.shell, world.entities);
            if (built) { this.pathsRoot = built; this.worldRoot.add(built); freezeTree(built); }
            this.pathsKey = pk;
        }
        const ids = new Set(world.entities.map(e => e.id));
        for (const [id, item] of this.entities) if (!ids.has(id)) this.removeEntity(id, item);
        for (const entity of world.entities) {
            const standing = entity.kind !== 'station' && entity.kind !== 'decor' && !nearWall(world.shell, entity.transform.x, entity.transform.z, 0.8);
            const key = JSON.stringify([{ ...entity, transform: undefined }, world.shell.theme, standing]);
            const item = this.entities.get(entity.id);
            if (item && item.key === key) {
                if (JSON.stringify(item.entity.transform) !== JSON.stringify(entity.transform)) { placeRoot(item.built.root, entity); refreeze(item.built.root); }
                item.entity = entity;
                continue;
            }
            if (item) { this.worldRoot.remove(item.built.root); disposeTree(item.built.root); this.screens.delete(entity.id); this.lamps.delete(entity.id); }
            const built = this.buildEntity(entity, jungle, standing);
            this.worldRoot.add(built.root); freezeTree(built.root);
            this.entities.set(entity.id, { entity, key, built, label: item?.label });
            if (built.screen) { built.screen.userData.screenOf = entity.id; built.screen.userData.screenKind = entity.kind; this.screens.set(entity.id, built.screen); }
            if (built.lamp) { this.lamps.set(entity.id, built.lamp); this.paintLamp(entity.id); }
        }
        // Keep the world's order (labels and data follow it).
        this.entities = new Map(world.entities.map(e => [e.id, this.entities.get(e.id)!]));
        this.roots = [...this.entities.values()].map(item => item.built.root);
        for (const item of this.entities.values()) this.syncLabel(item);
        this.labels = [...this.entities.values()].flatMap(item => item.label ? [item.label] : []);
        this.labels.forEach(label => label.classList.toggle('is-walk', this.navigation === 'walk'));
        for (const label of this.labels) this.labelPos.delete(label);
        this.paintLinked();
        // Walking: footprint collision, bounds and reset spot of this world.
        if (this.walker) {
            const firstOpen = world.shell.open && (!previous || !previous.shell.open || this.homeKey !== world.name); // w3:look (6): a newly loaded open world starts in its plaza
            this.walker.mover = worldMover(world); this.walker.home = worldHome(world.shell, world.entities);
            if (firstOpen) { this.homeKey = world.name; this.walker.pose = { ...this.walker.home }; }
        }
        this.roomScale = worldScale(world.shell);
        this.shadowKey = ''; this.applyScaleView(); // w3:render — fog, clip planes and the sun's shadow box for this world size
        const canvas = this.renderer.domElement;
        canvas.dataset.worldName = world.name;
        canvas.dataset.worldRevision = String(world.revision);
        canvas.dataset.worldEntities = JSON.stringify(world.entities.map(e => e.id));
        canvas.dataset.worldStations = JSON.stringify(stations.map(e => e.id));
        canvas.dataset.worldShell = JSON.stringify({ width: world.shell.width, depth: world.shell.depth, open: !!world.shell.open }); // w3:test
        canvas.dataset.worldRooms = JSON.stringify(world.entities.filter(e => e.kind === 'room').map(e => e.id)); // w3:test
        canvas.dataset.deskPositions = JSON.stringify(Object.fromEntries(stations.map(e => [e.id, { x: e.transform.x, z: e.transform.z }])));
        this.lastView[0] = NaN; this.renderer.shadowMap.needsUpdate = true;
        if (previous) this.positionCamera();
        this.invalidate();
    }
    /** w3:render — background + fog colour: the classic room backdrop, or the open world's sky. */
    private applySky(world: WorldSpec): void {
        const jungle = world.shell.theme === 'jungle', color = world.shell.open ? openSky(jungle) : shellColors(jungle).background;
        (this.scene.background as THREE.Color).set(color); (this.scene.fog as THREE.Fog).color.set(color);
    }
    private applyTheme(jungle: boolean): void {
        const colors = shellColors(jungle);
        (this.scene.background as THREE.Color).set(colors.background); (this.scene.fog as THREE.Fog).color.set(colors.background);
        if (this.lights) { this.lights.hemi.color.setHex(colors.hemiSky); this.lights.sun.color.setHex(colors.sun); this.lights.accent.color.setHex(colors.accent); }
    }
    private buildEntity(entity: WorldEntity, jungle: boolean, standing: boolean): BuiltEntity {
        switch (entity.kind) {
            case 'station': {
                let surface = this.terminalSurfaces.get(entity.id);
                if (!surface) { surface = this.terminalSurface(); this.terminalSurfaces.set(entity.id, surface); }
                const built = buildStation(entity, jungle, surface.texture);
                if (!surface.frame) { this.terminalFrames[entity.id] ??= { lines: [] }; queueMicrotask(() => { if (!this.disposed && this.terminalSurfaces.get(entity.id) === surface) this.setTerminalFrame(this.terminalFrames[entity.id] ?? { lines: [] }, entity.id as TerminalWorkstation); }); }
                return built;
            }
            case 'web-wall': return buildWebWall(entity, this.webTexture!, standing);
            case 'review-screen': return buildReviewScreen(entity, this.codeSurface!.texture, standing);
            case 'mirror': return buildMirror(entity, entity.id === 'mirror' ? this.mirrorTexture! : this.linkedSurface(entity.id).texture, standing);
            case 'monitor-wall': return buildMonitorWall(entity, this.linkedSurface(entity.id).texture, standing);
            case 'decor': return buildDecorEntity(entity, jungle);
            case 'room': { const built = buildRoom(entity, jungle); setRoomCutaway(built.root, this.navigation !== 'walk', false); return built; } // w3:render — real rooms (world-scene-rooms.ts)
        }
    }
    private linkedSurface(id: string): ScreenSurface {
        let surface = this.linkedSurfaces.get(id);
        if (!surface) { surface = this.terminalSurface(); this.linkedSurfaces.set(id, surface); }
        return surface;
    }
    private removeEntity(id: string, item: SceneEntity): void {
        this.worldRoot.remove(item.built.root); disposeTree(item.built.root);
        item.label?.remove(); this.labelPos.delete(item.label!);
        this.screens.delete(id); this.lamps.delete(id); this.deskLabels.delete(id); this.entities.delete(id);
        if (item.entity.kind === 'station') {
            this.disposeSurface(this.terminalSurfaces.get(id)); this.terminalSurfaces.delete(id); this.terminalSources?.delete(id);
            if (id !== 'terminal' && id !== 'terminal-2') delete this.terminalFrames[id];
            if (this.terminalSelection?.station === id) this.terminalSelection = undefined;
        }
        if (this.linkedSurfaces.has(id)) { this.disposeSurface(this.linkedSurfaces.get(id)); this.linkedSurfaces.delete(id); }
    }
    /** What a click on an entity selects: web walls drive the one web runtime, review screens the code review. */
    private selectId(id: string): Workstation {
        const kind = this.entities.get(id)?.entity.kind;
        return (kind === 'web-wall' ? 'web' : kind === 'review-screen' ? 'code' : id) as Workstation;
    }
    private labelText(item: SceneEntity): { text: string; aria: string } {
        const { entity } = item, stations = this.stationNumbers.size;
        const legacy = LEGACY_LABELS[entity.id];
        const defaultTitle = legacy?.text.replace(/^\d+\s+/, '').replace(/ ↗$/, '');
        if (legacy && stations <= 2 && (entity.label === undefined || entity.label === defaultTitle)) return legacy;
        const title = entityTitle(entity, this.world).slice(0, 40), n = this.stationNumbers.get(entity.id);
        const text = n ? `${String(n).padStart(2, '0')}  ${title} ↗` : `${title} ↗`;
        const aria = entity.kind === 'station' ? `Open ${title} terminal` : entity.kind === 'web-wall' ? `Use ${title}` : entity.kind === 'review-screen' ? 'Review project changes' : `Use ${title}`;
        return { text, aria };
    }
    private syncLabel(item: SceneEntity): void {
        if (item.entity.kind === 'decor' || item.entity.kind === 'room') { item.label?.remove(); item.label = undefined; return; } // w3:render — rooms are places, not workstations
        const id = item.entity.id;
        if (!item.label) {
            const label = document.createElement('button'); label.className = 'omo-scene-label'; label.dataset.workstation = id;
            label.addEventListener('click', () => this.labelClicked(id));
            this.host.appendChild(label); item.label = label;
        }
        const { text, aria } = this.labelText(item);
        if (item.label.dataset.baseText !== text) { item.label.dataset.baseText = text; this.labelSize.delete(item.label); } // t3:polish2: re-measure
        this.showLabelText(item.label);
        item.label.setAttribute('aria-label', aria);
        if (item.entity.kind === 'station') this.deskLabels.set(id, item.label);
    }
    /** w3:look — open-world overview shows short chips ("03"); walking and classic rooms show the full title. */
    private chipLabels(): boolean { return this.navigation === 'overview' && !!this.world?.shell.open; }
    private showLabelText(label: HTMLButtonElement): void {
        const base = label.dataset.baseText ?? '', chip = this.chipLabels(), text = chip ? chipText(base) : base;
        if (label.textContent !== text) { label.textContent = text; this.labelSize.delete(label); }
        label.classList.toggle('is-chip', chip);
        if (chip) label.title = base.replace(/\s*↗$/, ''); else label.removeAttribute('title');
    }
    private labelClicked(id: string): void {
        const item = this.entities.get(id); if (!item) return;
        const screen = item.built.screen, kind = item.entity.kind;
        const far = (): boolean => this.navigation === 'walk' && !!screen && this.camera.position.distanceTo(screen.getWorldPosition(new THREE.Vector3())) > 3.2;
        if (kind === 'station') {
            if (this.navigation === 'walk') { if (far()) { this.options.onMessage('Walk closer to the terminal monitor.'); return; } this.walker?.focusTerminal(); }
            this.options.onSelect(id as Workstation); return;
        }
        if (kind === 'web-wall') { if (far()) { this.options.onMessage('Walk closer to the web wall.'); return; } this.options.onSelect('web'); this.walker?.focusTerminal(); return; }
        if (kind === 'review-screen') { if (far()) { this.options.onMessage('Walk closer to the code screen.'); return; } this.releaseTyping(); this.options.onSelect('code'); return; }
        this.options.onSelect(id as Workstation);
    }
    /** Station lamp colour from its frame status. */
    private paintLamp(station: string): void {
        const lamp = this.lamps.get(station), frame = this.terminalFrames[station]; if (!lamp || !frame) return;
        const color = /interrupted|exited|error/i.test(frame.status ?? '') ? 0xd26464 : frame.unreadBells ? 0xff9e4a : /process active|working/i.test(frame.status ?? '') ? 0xe8bd60 : /live|running|idle/i.test(frame.status ?? '') ? 0x87cdb4 : 0x6d7c86;
        const material = lamp.material as THREE.MeshStandardMaterial;
        if (material.color.getHex() !== color || material.emissive.getHex() !== color) { material.color.setHex(color); material.emissive.setHex(color); this.invalidate(); }
    }
    /** Monitor frames for every station, keyed by station id (runtime lane hook). */
    setStationFrames(frames: Record<string, MonitorFrame>): void {
        for (const [id, frame] of Object.entries(frames)) if (frame) this.setTerminalFrame(frame, id as TerminalWorkstation);
    }
    /** Frames for linked monitor walls / mirrors, keyed by entity id: each shows its linked station's frame (runtime lane hook). */
    setLinkedFrames(frames: Record<string, MonitorFrame>): void {
        this.linkedFrames = new Map(Object.entries(frames).filter(([, f]) => !!f));
        this.paintLinked();
    }
    private paintLinked(): void {
        if (!this.renderer) return;
        let changed = false;
        for (const [id, surface] of this.linkedSurfaces) {
            const item = this.entities.get(id); if (!item) continue;
            const link = item.entity.kind === 'monitor-wall' || item.entity.kind === 'mirror' ? item.entity.link : undefined;
            const input = this.linkedFrames.get(id);
            const linkName = link ? entityTitle(this.world.entities.find(e => e.id === link) ?? item.entity, this.world) : undefined;
            surface.hint = link ? `Linked to ${linkName}. Waiting for its screen.` : 'Link this wall to a desk in build mode.';
            const source = input ?? `${surface.hint}\u0000${linkName ?? ''}`;
            if (surface.linkSource === source) continue;
            if (this.farScreen(id, surface)) { surface.parked = true; continue; } // w3:render — far: keep the last frame (linkSource not updated, so it repaints when near)
            surface.parked = false;
            surface.linkSource = source;
            const frame: MonitorFrame = input ? monitorWindow(input) : { lines: [], title: link ? `LINKED · ${String(linkName).toUpperCase()}` : 'MONITOR WALL', status: link ? 'No frame yet' : 'Not linked' };
            surface.frame = frame; surface.selection = '';
            if (this.paintTerminal(surface, frame, [])) changed = true;
        }
        if (changed) this.invalidate();
        this.publishParked(); // w3:render
        this.setData('linkedFrames', JSON.stringify(Object.fromEntries([...this.linkedSurfaces].map(([id, s]) => [id, s.frame?.lines.length ?? 0]))));
    }
    /** The entity under a client (CSS pixel) point: the frontmost hit, any kind (build lane hook). */
    entityAt(clientX: number, clientY: number): string | undefined {
        if (!this.renderer) return undefined;
        const rect = this.renderer.domElement.getBoundingClientRect(); if (!rect.width || !rect.height) return undefined;
        const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((clientX-rect.left)/rect.width*2-1, -(clientY-rect.top)/rect.height*2+1), this.camera);
        // The frontmost hit decides: a wall or the floor in front of an entity hides it.
        const hit = ray.intersectObjects(this.shellRoot ? [this.shellRoot, ...this.roots] : this.roots, true)[0];
        let node: THREE.Object3D | null = hit?.object ?? null;
        while (node && node.userData.entity === undefined) node = node.parent;
        return node ? node.userData.entity as string : undefined;
    }
    setCodeReview(frame:CodeReviewFrame):void {
        const surface=this.codeSurface;if(!surface)return;
        frame=codeReviewPreview(frame);
        const ctx=surface.canvas.getContext('2d')!;ctx.fillStyle='#101c27';ctx.fillRect(0,0,1024,576);ctx.font='bold 22px monospace';ctx.fillStyle='#b9e3d5';ctx.fillText(frame.title.slice(0,75),24,32);ctx.font='17px monospace';
        frame.lines.forEach((line,i)=>{ctx.fillStyle=line.startsWith('+')?'#91e4ac':line.startsWith('-')?'#f1a49c':'#d7e3df';ctx.fillText(line,24,70+i*21,976);});ctx.fillStyle='#8ea5aa';ctx.font='14px monospace';ctx.fillText(frame.status.slice(0,110),24,564,976);surface.texture.needsUpdate=true;this.invalidate();
        this.renderer.domElement.dataset.codeReviewText=frame.lines.join('\n');
        this.renderer.domElement.dataset.codeReviewStatus=frame.status;
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
            for(const hit of hits){let node:THREE.Object3D|null=hit.object;while(node&&!node.userData.workstation)node=node.parent;if(node?.userData.workstation){this.options.onSelect(this.selectId(node.userData.workstation));break;}}
        };
        // omo webscroll lane: in walk mode the wheel scrolls the web page under the pointer (within reach), clicked or not.
        const wheel=(event:WheelEvent)=>{event.preventDefault();if(this.navigation==='walk'){
            const unit=event.deltaMode===1?40:event.deltaMode===2?600:1, dy=event.deltaY*unit, dx=event.deltaX*unit;
            const at=this.walker?.locked?this.canvasCentre():{x:event.clientX,y:event.clientY};
            const web=this.options.onWebScroll?this.webPointAt(at.x,at.y):undefined;
            if(web){this.options.onWebScroll!(web,dy,dx);return;}
            if(this.walker?.typing)this.options.onScroll?.(dy);return;}this.state.distance=Math.max(10,Math.min(30,this.state.distance+event.deltaY*0.01));this.positionCamera();this.options.onCameraChange({...this.state});};
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
    // ------------------------------------------------------------------ w3:render — big worlds
    private shadowKey = '';
    private parkCheck = { x: NaN, z: NaN };
    /** Fog and camera clip planes for the world size and navigation mode, then the sun's shadow box. */
    private applyScaleView(): void {
        const mode = this.navigation, fog = worldFog(this.world.shell, mode), clip = cameraClip(this.world.shell, mode);
        const f = this.scene.fog as THREE.Fog | null; if (f) { f.near = fog.near; f.far = fog.far; }
        if (this.camera.near !== clip.near || this.camera.far !== clip.far) { this.camera.near = clip.near; this.camera.far = clip.far; this.camera.updateProjectionMatrix(); }
        this.followSun();
    }
    /**
     * The sun's shadow box: fixed v1 box for classic rooms, a ±30 m box following the player (in 4 m steps) in big
     * worlds. The shadow map is redrawn only when the box moves; the map size stays capped at 2048.
     */
    private followSun(): void {
        if (!this.lights || !this.world) return;
        const pose = this.walker?.pose ?? PLAYER_HOME, frame = shadowFrame(this.world.shell, this.navigation, pose);
        const key = `${frame.cx},${frame.cz},${frame.extent}`; if (key === this.shadowKey) return;
        this.shadowKey = key;
        const { sun } = this.lights, k = Math.max(1, frame.extent / V1_SUN.extent);
        sun.position.set(frame.cx + V1_SUN.x * k, V1_SUN.y * k, frame.cz + V1_SUN.z * k); refreezeNode(sun);
        sun.target.position.set(frame.cx, 0, frame.cz); sun.target.updateMatrixWorld(true);
        Object.assign(sun.shadow.camera, { left: -frame.extent, right: frame.extent, top: frame.extent, bottom: -frame.extent, near: 1, far: 40 * k });
        sun.shadow.camera.updateProjectionMatrix();
        if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
        this.setData('shadowFrame', key);
    }
    /** Is a station / linked screen far from the player (keep its last frame)? Never parks a screen that was never painted. */
    private farScreen(id: string, surface: ScreenSurface): boolean {
        if (!surface.rows || this.navigation !== 'walk') return false; // the overview shows every screen live
        const entity = this.entities?.get(id)?.entity; if (!entity) return false;
        return terminalFar(this.walker?.pose ?? PLAYER_HOME, entity.transform, !!surface.parked);
    }
    /** After the player walked >= 1 m: move the sun's shadow box and repaint parked screens that are near again. No work (or allocation) in between. */
    private walked(pose: PlayerPose): void {
        if (Math.hypot(pose.x - this.parkCheck.x, pose.z - this.parkCheck.z) < 1) return;
        this.parkCheck.x = pose.x; this.parkCheck.z = pose.z;
        this.followSun();
        let linked = false;
        for (const [id, surface] of this.terminalSurfaces) if (surface.parked && !this.farScreen(id, surface)) { surface.parked = false; this.setTerminalFrame(this.terminalFrames[id] ?? { lines: [] }, id as TerminalWorkstation); }
        for (const [id, surface] of this.linkedSurfaces) if (surface.parked && !this.farScreen(id, surface)) { surface.parked = false; linked = true; }
        if (linked) this.paintLinked();
        this.publishParked();
    }
    private publishParked(): void {
        this.setData('parkedScreens', JSON.stringify([...this.terminalSurfaces, ...this.linkedSurfaces].filter(([, s]) => s.parked).map(([id]) => id)));
    }
    /** w3:render — overview shows rooms as a cutaway (low walls, no lintels); walking shows full walls. */
    private cutRooms(): void {
        let changed = false;
        for (const item of this.entities.values()) if (item.entity.kind === 'room' && setRoomCutaway(item.built.root, this.navigation !== 'walk')) changed = true;
        if (changed && this.renderer) this.renderer.shadowMap.needsUpdate = true;
    }
    setNavigation(mode: 'walk' | 'overview'): void {
        this.navigation = mode; this.camera.fov = mode === 'walk' ? 65 : 38; this.camera.updateProjectionMatrix();
        this.walker?.setEnabled(mode === 'walk');
        this.cutRooms(); // w3:render — rooms: full walls when walking, low cutaway walls in the overview
        if (this.world) { this.applyScaleView(); this.parkCheck.x = NaN; this.walked(this.walker?.pose ?? PLAYER_HOME); } // w3:render — overview: parked screens resume
        if (this.walker) this.smoother.snap(this.walker.pose);
        if (this.renderer) { this.renderer.domElement.dataset.navigation = mode; }
        this.labels.forEach(label => { label.classList.toggle('is-walk', mode === 'walk'); this.labelSize.delete(label); this.labelPos.delete(label); this.showLabelText(label); }); // t3:polish2: re-measure; w3:look chips
        this.positionCamera(); this.invalidate();
    }
    setTerminalLines(lines: string[]): void { this.setTerminalFrame({ ...this.terminalFrames.terminal, lines, cells: undefined, foreground: undefined, background: undefined, cursor: undefined }); }
    setTerminalFrames(frames: Record<TerminalWorkstation, MonitorFrame>): void {
        if (frames.terminal) this.setTerminalFrame(frames.terminal, 'terminal'); if (frames['terminal-2']) this.setTerminalFrame(frames['terminal-2'], 'terminal-2');
    }
    /** w2:render — `station` may be any station id of the world (cast), not only the two v1 desks. */
    setTerminalFrame(input: MonitorFrame, station: TerminalWorkstation = 'terminal'): void {
        // Larger focus-mode grids are cropped to the monitor's 80 x 22 (the same object when it already fits).
        const previous = this.terminalFrames[station] ?? { lines: [] }, sources = this.terminalSources ??= new Map();
        const cached = sources.get(station);
        const frame = input === previous ? previous : cached?.input === input ? cached.frame : monitorWindow(input);
        if (input !== previous) { if (frame !== input) sources.set(station, { input, frame }); else sources.delete(station); }
        if (this.terminalSelection?.station === station && (!this.terminalSelection.model.refresh(frame.lines,frame.cells) || previous.title !== frame.title || previous.status !== frame.status)) this.terminalSelection = undefined;
        this.terminalFrames[station] = frame;
        // t3:polish2 — a connected desk keeps its short desk name on the label; the workspace name goes to the tooltip.
        const workspaceName = frame.title?.split(' / ')[0]?.trim();
        const deskLabel = this.deskLabels.get(station);
        if (deskLabel) { const tip = workspaceName ? `Workspace: ${workspaceName.slice(0, 80)}` : ''; if ((deskLabel.title || '') !== tip) { deskLabel.title = tip; deskLabel.dataset.workspace = workspaceName ?? ''; } }
        const surface = this.terminalSurfaces.get(station);
        if (!surface) return;
        const selection = this.terminalSelection?.station === station ? this.terminalSelection.model : undefined;
        const spans = selection ? selection.spans() : [];
        const selectionKey = selection ? JSON.stringify(spans) : '';
        // Same frame object and same selection: the monitor already shows it (the other desk on every update).
        if (surface.frame === frame && surface.selection === selectionKey) return;
        const frameChanged = surface.frame !== frame;
        if (!selection && this.farScreen(station, surface)) { if (!surface.parked) { surface.parked = true; this.publishParked(); } } // w3:render — far monitor keeps its last frame
        else {
            surface.parked = false; surface.frame = frame; surface.selection = selectionKey;
            if ((this.paintBudget ??= new MonitorPaintBudget({ alive: () => !this.disposed, onPainted: () => this.invalidate() })).request(station, () => this.terminalSurfaces.get(station) === surface && surface.frame === frame && this.paintTerminal(surface, frame, spans))) this.invalidate(); // w3:perf: active desk at once; near/far max 6 per frame round-robin; hidden waits
        }
        this.paintLamp(station);
        if (!this.renderer) return;
        this.setData('terminalSelection', this.terminalSelection?.model.text() ?? '');
        this.setData('terminalSelectionStation', this.terminalSelection?.station ?? '');
        this.setData('stationLamps', JSON.stringify(Object.fromEntries([...this.lamps].map(([id,mesh]) => [id,(mesh.material as THREE.MeshStandardMaterial).color.getHexString()]))));
        if (!frameChanged) return;
        this.setData('terminalMetrics', JSON.stringify(Object.fromEntries([...this.terminalSurfaces].map(([id,s]) => [id,{ cellWidth:s.cellWidth ?? 12 }]))));
        if (station === 'terminal') { this.setData('terminalText', frame.lines.join('\n')); this.setData('terminalCursor', frame.cursor?`${frame.cursor.x},${frame.cursor.y},${frame.cursor.visible}`:''); }
        // Keyed by station id: v1 keys 'terminal' / 'terminal-2' always present, plus every world station.
        const frames = Object.entries(this.terminalFrames);
        this.setData('stationText', JSON.stringify(Object.fromEntries(frames.map(([id, f]) => [id, f.lines]))));
        this.setData('stationCells', JSON.stringify(Object.fromEntries(frames.map(([id, f]) => [id, f.cells]))));
        this.setData('stationBells', JSON.stringify(Object.fromEntries(frames.map(([id, f]) => [id, f.unreadBells ?? 0]))));
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
        const layout = lines.length ? `${skip}\u0000${!!frame.foreground}\u0000${frame.cells !== undefined}\u0000${JSON.stringify(frame.palette ?? null)}` : `empty\u0000${frame.status ?? ''}\u0000${surface.hint ?? ''}`;
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
            if (full) { c.fillStyle='#c7ded4';c.fillText((surface.hint ?? 'Walk up and click this screen.').slice(0,MONITOR_COLS),24,104); c.fillStyle='#7e9a9e';c.fillText((frame.status ?? '').slice(0,MONITOR_COLS),24,140); }
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
        for (const surface of [...this.terminalSurfaces.values(), ...this.linkedSurfaces.values()]) {
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
    private terminalCellAt(x: number, y: number, clamp = false): { station: string; cell: {row:number;col:number} } | undefined {
        const rect = this.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1), this.camera);
        // Only the frontmost actual screen counts. Never select through another object or workstation.
        const hit = ray.intersectObjects(this.roots,true)[0]; if (!hit?.uv) return undefined;
        for (const station of this.terminalSurfaces.keys()) {
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
        this.options.onTextSelect(hit.station as TerminalWorkstation);
        this.terminalSelection = { station:hit.station,model:new MonitorSelection(this.terminalFrames[hit.station].lines,hit.cell,unit,this.terminalFrames[hit.station].cells) };
        this.setTerminalFrame(this.terminalFrames[hit.station],hit.station as TerminalWorkstation); return true;
    }
    private extendTerminalSelection(x: number, y: number): void {
        const selected = this.terminalSelection, hit = this.terminalCellAt(x,y,true);
        if (!selected || hit?.station !== selected.station) return;
        selected.model.extend(hit.cell); this.setTerminalFrame(this.terminalFrames[selected.station],selected.station as TerminalWorkstation);
    }
    private clearTerminalSelection(): void {
        const selected = this.terminalSelection; if (!selected) return;
        this.terminalSelection = undefined; if (this.terminalFrames[selected.station]) this.setTerminalFrame(this.terminalFrames[selected.station],selected.station as TerminalWorkstation);
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
    private terminalLinkAt(station: string, hit: THREE.Intersection): string | undefined {
        if (!hit.uv) return undefined;
        const frame = this.terminalFrames[station]; if (!frame) return undefined;
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
    /** omo webscroll lane: the web page pixel under a canvas point, when the web wall is the frontmost hit and within reach. */
    private webPointAt(x: number, y: number): ScreenPoint | undefined {
        if (!this.renderer) return undefined;
        const rect = this.renderer.domElement.getBoundingClientRect(); if (!rect.width || !rect.height) return undefined;
        const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1), this.camera);
        const hit = ray.intersectObjects(this.roots,true)[0];
        const screen = hit?.object as THREE.Mesh | undefined;
        if (!hit?.uv || !screen || screen.userData.screenKind !== 'web-wall' || this.camera.position.distanceTo(screen.getWorldPosition(new THREE.Vector3())) > 3.2) return undefined;
        const { width, height } = this.webSize;
        return { x: Math.min(width-1, Math.max(0, hit.uv.x*width)), y: Math.min(height-1, Math.max(0, (1-hit.uv.y)*height)) };
    }
    private canvasCentre(): { x: number; y: number } { const r = this.renderer.domElement.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; }
    private interactAt(x: number, y: number, modifiers?: { ctrlKey: boolean; metaKey: boolean }): 'terminal' | 'code' | undefined {
        const rect=this.renderer.domElement.getBoundingClientRect();
        const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1),this.camera);
        for(const hit of ray.intersectObjects(this.roots,true)){
            let node:THREE.Object3D|null=hit.object;while(node&&!node.userData.workstation)node=node.parent;
            const id=node?.userData.workstation as string|undefined;
            if(!id)continue;
            const screen = this.screens.get(id); if (!screen) continue;
            const kind = this.entities.get(id)?.entity.kind, action = this.selectId(id);
            const center = screen.getWorldPosition(new THREE.Vector3());
            if(this.camera.position.distanceTo(center)>3.2){this.options.onMessage('Walk closer to the workstation.');return;}
            if ((modifiers?.ctrlKey || modifiers?.metaKey) && kind === 'station' && hit.object === screen) {
                const link = this.terminalLinkAt(id, hit);
                if (link) { this.options.onOpenLink?.(link); return 'terminal'; }
                this.options.onMessage('Ctrl-click a complete safe HTTP(S) link on this monitor.'); return 'terminal';
            }
            const point = action === 'web' && hit.object === screen && hit.uv ? { x: Math.min(this.webSize.width-1, Math.max(0, hit.uv.x*this.webSize.width)), y: Math.min(this.webSize.height-1, Math.max(0, (1-hit.uv.y)*this.webSize.height)) } : undefined;
            this.options.onSelect(action, point); return action === 'code' ? 'code' : kind === 'mirror' || kind === 'monitor-wall' ? undefined : 'terminal';
        }
        return undefined;
    }
    private positionCamera(): void {
        this.invalidate();
        if (this.navigation === 'walk') { this.walker?.step(0); return; }
        const {azimuth:a,elevation:e,distance:d}=this.state;
        // w3:look — open worlds: frame the rooms and entities (zoom scales the fitted distance; 24 = default zoom).
        const content = this.world ? overviewFrame(this.world, { azimuth: a, elevation: e, aspect: this.camera.aspect, fov: this.camera.fov }) : undefined;
        if (content) {
            const k = content.distance * d / 24, t = content.target;
            this.camera.position.set(t.x+Math.sin(a)*Math.cos(e)*k,t.y+Math.sin(e)*k,t.z+Math.cos(a)*Math.cos(e)*k);
            this.camera.lookAt(t.x,t.y,t.z); return;
        }
        const fit = Math.max(1, 1.28 / this.camera.aspect) * this.roomScale;
        this.camera.position.set(Math.sin(a)*Math.cos(e)*d*fit,Math.sin(e)*d*fit,Math.cos(a)*Math.cos(e)*d*fit);
        this.camera.lookAt(0,0.7,0);
    }
    private resize():void {
        const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;
        this.renderer.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.lastView[0]=NaN;this.positionCamera();
    }
    /** Device pixel ratio for the drawing buffer: capped, then scaled by the dynamic-resolution step. */
    private pixelRatio(): number {
        const base = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        return Math.max(Math.min(base, MIN_PIXEL_RATIO), base * SCALE_STEPS[this.scaleStep]);
    }
    /**
     * Track consecutive rendered frame intervals while moving. Missed vsyncs step the resolution down;
     * a long clean run steps it back up one notch at a time. Only continuous motion counts (no idle gaps).
     */
    private governResolution(now: number, continuous: boolean): void {
        if (!this.dynamicResolution) return;
        const interval = now - this.lastRenderAt; this.lastRenderAt = now;
        if (!continuous || interval > 100) { this.frameCount = 0; this.slowFrames = 0; return; }
        this.frameCount++;
        if (interval > SLOW_FRAME_MS) this.slowFrames++;
        const since = now - this.scaleChangedAt;
        let next = this.scaleStep;
        if (this.slowFrames >= SLOW_LIMIT && since >= SCALE_DOWN_COOLDOWN_MS && next < SCALE_STEPS.length - 1) next++;
        else if (this.frameCount >= SCALE_WINDOW) {
            if (this.slowFrames === 0 && since >= SCALE_UP_COOLDOWN_MS && next > 0) next--;
            this.frameCount = 0; this.slowFrames = 0;
        }
        if (next === this.scaleStep) return;
        this.frameCount = 0; this.slowFrames = 0; this.scaleChangedAt = now;
        this.applyScale(next);
    }
    private applyScale(step: number): void {
        const before = this.pixelRatio(); this.scaleStep = step; const after = this.pixelRatio();
        if (after !== before) { this.renderer.setPixelRatio(after); this.renderer.setSize(this.host.clientWidth, this.host.clientHeight); this.lastView[0] = NaN; }
        this.setData('renderScale', String(SCALE_STEPS[step]));
    }
    /**
     * The only animation loop. Each tick advances the walker, the view smoothing and any ambient modules
     * (agent avatars), then renders only when something visible changed. It reschedules itself while the
     * player moves, the view is still settling, or an ambient module still animates. Otherwise it stops;
     * input, resize and content updates restart it. No allocations on the steady walking path.
     */
    private draw=():void=>{
        if(this.scheduled){cancelAnimationFrame(this.frame);this.scheduled=false;}
        this.frame=0;
        if(this.disposed||!this.renderer)return;
        const now=performance.now();
        const wasIdle=this.idle;
        // After an idle gap the elapsed time is not motion time: advance one nominal frame.
        const delta=this.idle?1/60:Math.min((now-this.lastFrame)/1000,0.1);this.lastFrame=now;this.idle=false;
        const w=this.host.clientWidth,h=this.host.clientHeight;
        if(!w||!h){this.idle=true;return;}
        let moving=false,coasting=false;
        if(this.navigation==='walk'&&this.walker){
            const before=this.walker.pose;const bx=before.x,bz=before.z,byaw=before.yaw,bpitch=before.pitch;
            this.walker.step(delta);
            const pose=this.walker.pose;
            moving=pose.x!==bx||pose.z!==bz||pose.yaw!==byaw||pose.pitch!==bpitch;
            // Keys held against a wall: keep ticking (velocity may change) but nothing to draw.
            if(this.walker.coasting)coasting=true;
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
            if(!this.smoother.settled(pose))moving=true;
            this.emitPose(pose,now,moving);
            if(moving)this.walked(pose); // w3:render — shadow box follows the player; near screens resume (checked per metre walked)
        }
        if(moving){
            if(this.sharpTimer!==undefined){window.clearTimeout(this.sharpTimer);this.sharpTimer=undefined;}
            if(this.sharpStep){if(this.scaleStep===0){this.applyScale(this.sharpStep);this.scaleChangedAt=now;}this.sharpStep=0;}
        }
        let animating=false;
        if(this.ambientTicks.size){const t=now/1000;for(const tick of this.ambientTicks)if(tick(t))animating=true;}
        const ambientFrame=animating&&now-this.lastAmbientRender>=AMBIENT_FRAME_MS;
        if(moving||this.needsRender||ambientFrame){
            this.needsRender=false;
            if(ambientFrame||!moving)this.lastAmbientRender=now;
            this.uploadDirty();
            this.renderer.render(this.scene,this.camera);this.renders++;this.fpsTick(); // w3:fps
            this.updateOverlays(w,h,now,moving);
            this.governResolution(now,moving&&!wasIdle);
        }
        if(moving||animating||coasting)this.invalidate(false);
        else{
            this.idle=true;
            // Settled: flush throttled inspection data and give the resolution back.
            if(this.dataPending)this.updateOverlays(w,h,now,false);
            // A still view is redrawn at full resolution after a short pause. The step is remembered for the next walk.
            if(this.scaleStep&&this.sharpTimer===undefined)this.sharpTimer=window.setTimeout(()=>{
                this.sharpTimer=undefined;if(this.disposed||!this.idle||!this.scaleStep)return;
                this.sharpStep=this.scaleStep;this.applyScale(0);this.invalidate();
            },SHARPEN_DELAY_MS);
        }
    };
    /** Tell the host about the pose: throttled while walking, always once when it stops. No allocation. */
    private emitPose(pose:PlayerPose,now:number,moving:boolean):void{
        const l=this.lastPose;
        if(pose.x!==l.x||pose.z!==l.z||pose.yaw!==l.yaw||pose.pitch!==l.pitch){l.x=pose.x;l.z=pose.z;l.yaw=pose.yaw;l.pitch=pose.pitch;l.pending=true;}
        if(l.pending&&(!moving||now-l.at>=POSE_INTERVAL_MS)){l.pending=false;l.at=now;this.options.onPose?.(pose);}
    }
    /**
     * Screen-space labels follow the view every rendered frame (transform only: no layout). Test/inspection
     * data (dataset JSON) is throttled while moving and written once more when the view settles.
     */
    private updateOverlays(w:number,h:number,now:number,moving:boolean):void{
        const e=this.camera.matrixWorld.elements,v=this.lastView;
        let same=v[16]===w&&v[17]===h&&v[18]===this.peerVersion;
        for(let i=0;i<16&&same;i++)if(v[i]!==e[i])same=false;
        if(same&&!this.dataPending)return;
        if(!same){
            for(let i=0;i<16;i++)v[i]=e[i];v[16]=w;v[17]=h;v[18]=this.peerVersion;
            this.placeLabels(w,h);
        }
        if(moving&&now-this.lastData<DATA_INTERVAL_MS){this.dataPending=true;return;}
        this.dataPending=false;this.lastData=now;
        this.publishView(w,h);
    }
    private placeLabels(w:number,h:number):void{
        const {a,b}=this.tmp;
        // t3:polish2 — project every label, then lay the visible ones out in screen space so they never pile up.
        // w3:look — open-world overview: short chips anchored just above their object; overlapping ones hide (no stacking).
        const chips=this.chipLabels();
        const items:Array<{label:HTMLButtonElement;x:number;y:number;w:number;h:number;priority:number}>=[];
        for(const label of this.labels){
            const action = label.dataset.workstation as string;
            const root = this.rootFor(action);
            if (!root) continue;
            const kind = this.entities.get(action)?.entity.kind;
            const lift = chips ? (kind==='station' ? 2.25 : (root.userData.labelHeight ?? 2.9) * 0.9) : root.userData.labelHeight ?? (this.navigation==='walk'?2.55:2.9);
            const p=a.copy(root.position).add(b.set(0,lift,chips&&kind==='station'?-.36:-.3).applyAxisAngle(THREE.Object3D.DEFAULT_UP,root.rotation.y)).project(this.camera);
            const mesh = this.screens.get(action);
            const distance = mesh ? this.camera.position.distanceTo(mesh.getWorldPosition(b)) : undefined;
            const x=Math.round((p.x*0.5+0.5)*w*2)/2,y=Math.round((-p.y*0.5+0.5)*h*2)/2;
            if(!workstationLabelVisible(this.navigation, p.z, distance)){ if(this.labelPos.get(label)!==-1){this.labelPos.set(label,-1);label.style.visibility='hidden';} continue; }
            let size=this.labelSize.get(label);
            if(!size||!size.w){size={w:label.offsetWidth||100,h:label.offsetHeight||26};this.labelSize.set(label,size);}
            items.push({label,x,y,w:size.w,h:size.h,priority:kind==='station'?1:2});
        }
        if(chips){
            for(const item of declutterLabels(items)){
                if(!item.hidden){this.applyLabel(item.label,item.x,item.y);continue;}
                if(this.labelPos.get(item.label)!==-1){this.labelPos.set(item.label,-1);item.label.style.visibility='hidden';}
            }
            return;
        }
        for(const item of layoutLabels(items))this.applyLabel(item.label,item.x,item.y);
    }
    private applyLabel(label:HTMLButtonElement,x:number,y:number):void{
        const placed=x*65536+y;
        // Only touch the style when it changed. left/top stay fixed; the move is a compositor-only transform.
        if(this.labelPos.get(label)!==placed){
            this.labelPos.set(label,placed);
            label.style.left='0px';label.style.top='0px';label.style.transform=`translate(${x}px, ${y}px) translate(-50%, -50%)`;label.style.visibility='visible';
        }
    }
    private rootFor(action:string):THREE.Object3D|undefined{return this.entities.get(action)?.built.root;}
    private publishView(w:number,h:number):void{
        const {a}=this.tmp;
        const toScreen=(v:THREE.Vector3):{x:number;y:number}=>({x:(v.x*.5+.5)*w,y:(-v.y*.5+.5)*h});
        this.setData('peerPositions',JSON.stringify(Object.fromEntries([...this.peerAvatars].map(([id,avatar])=>{
            const p=avatar.root.localToWorld(a.set(0,1.55,0)).project(this.camera);
            return [id,{name:avatar.member.name,...avatar.member.pose,screenX:(p.x*.5+.5)*w,screenY:(-p.y*.5+.5)*h,visible:p.z>=-1&&p.z<=1&&Math.abs(p.x)<1&&Math.abs(p.y)<1}];
        }))));
        const targets: Record<string, { x: number; y: number; visible: boolean }> = {};
        for(const label of this.labels){
            const action = label.dataset.workstation as string;
            const mesh = this.screens.get(action);
            if (!mesh || !this.rootFor(action)) continue;
            const projected = mesh.getWorldPosition(a).project(this.camera);
            targets[action] = { ...toScreen(projected), visible: projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 };
        }
        // Old keys: terminalX/Y follow 'terminal', else the world's first station.
        const first=targets.terminal??targets[[...this.stationNumbers.keys()][0]??''];
        if(first){this.setData('terminalX',String(first.x));this.setData('terminalY',String(first.y));}
        this.setData('stationTargets',JSON.stringify(targets));
        const quad=(mesh:THREE.Mesh,x:number,y:number)=>[[-x,y],[x,y],[x,-y],[-x,-y]].map(([qx,qy])=>toScreen(mesh.localToWorld(a.set(qx,qy,0)).project(this.camera)));
        const half=(mesh:THREE.Mesh)=>{const g=(mesh.geometry as THREE.PlaneGeometry).parameters;return [g.width/2,g.height/2] as const;};
        const of=(kind:WorldEntity['kind'])=>[...this.entities.values()].filter(item=>item.entity.kind===kind&&item.built.screen);
        this.setData('terminalQuads',JSON.stringify(Object.fromEntries(of('station').map(item=>[item.entity.id,quad(item.built.screen!,...half(item.built.screen!))]))));
        const code=this.screens.get('code')??of('review-screen')[0]?.built.screen;if(code)this.setData('codeReviewQuad',JSON.stringify(quad(code,...half(code))));
        const web=this.screens.get('web')??of('web-wall')[0]?.built.screen;if(web)this.setData('webQuad',JSON.stringify(quad(web,...half(web))));
    }
    resetCamera():void{if(this.navigation==='walk'){this.walker?.reset();this.invalidate();return;}this.state={azimuth:0.56,elevation:0.61,distance:24};this.positionCamera();this.options.onCameraChange({...this.state});}
    dispose():void{
        this.setPeers([]);
        this.disposed=true;for(const s of [...this.terminalSurfaces.values(),...this.linkedSurfaces.values()])s.source?.dispose();this.walker?.dispose();cancelAnimationFrame(this.frame);if(this.sharpTimer!==undefined)window.clearTimeout(this.sharpTimer);this.scheduled=false;this.observer?.disconnect();this.cleanup.forEach(fn=>fn());this.labels.forEach(label=>label.remove());
        this.scene.traverse(node=>{if(node instanceof THREE.Mesh){node.geometry.dispose();const ms=Array.isArray(node.material)?node.material:[node.material];ms.forEach(m=>{(m as THREE.MeshStandardMaterial).map?.dispose();m.dispose();});}});
        if(this.renderer){this.renderer.dispose();this.renderer.domElement.remove();}
    }
}

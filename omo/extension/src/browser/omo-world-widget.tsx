import * as React from 'react';
import { injectable, inject, postConstruct, optional } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import type { Message } from '@theia/core/shared/@lumino/messaging';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';
import URI from '@theia/core/lib/common/uri';
import { RoomScene, Workstation, TerminalWorkstation, ScreenPoint, MonitorFrame, CodeReviewFrame } from './room-scene';
import { RoomState, RoomTheme, parseRoomState } from '../common/room-state';
import { exportRoomPreset, parseRoomPreset, ROOM_PRESET_FILENAME, ROOM_PRESET_MAX_BYTES } from '../common/room-preset';
import { ROOM_LAYOUTS, ROOM_KITS } from '../common/player-state';
import type { RoomLayoutId, RoomKitId, PlayerPose } from '../common/player-state';
import { OmoRuntimeService } from '../common/runtime-protocol';
import type { RuntimeFrame } from '../common/runtime-protocol';
import { RuntimeConsoleController, RuntimeConsoleState, StationBinding } from './runtime-console-controller';
import { RuntimeConsoleStrip } from './runtime-console-strip';
import { OmoWebService, WebSurfaceFrame } from '../common/web-runtime-protocol';
import { WebSurfaceController, WebWallState } from './web-surface-controller';
import { WebSurfaceStrip } from './web-surface-strip';
import { normalizeWebUrl } from '../common/web-url';
import { OmoPresenceService, PresenceJoin, presenceStation } from '../common/presence-protocol';
import { PresenceController, PresenceState } from './presence-controller';
import { PresenceStrip } from './presence-strip';
import { PLAYER_HOME } from '../common/player-state';
import { GitReviewService } from '../common/git-review-protocol';
import type { GitReviewSnapshot } from '../common/git-review-protocol';
import { GitReviewController, GitReviewState } from './git-review-controller';
import { GitReviewPanel } from './git-review-panel';
import { TaskOverviewPanel } from './task-overview-panel';
import { TaskWorkspaceService } from '../common/task-workspace-protocol';
import { TaskWorkspacePanel } from './task-workspace-panel';
import { scopeTaskWorkspaceService } from './task-workspace-controller';
import { AgentWorkflowPanel } from './agent-workflow-panel';
import type { TaskWorkspaceAuthority } from './task-handoff';
import { readStationRecipes, writeStationRecipes, makeStationRecipe, readStationLocks, writeStationLocks } from './station-recipe';
import type { StationLocks } from './station-recipe';
import type { StationRecipe } from './station-recipe';
import { StationRecipePanel } from './station-recipe-panel';
import { defaultStationLink, readStationLink, writeStationLink, webWallDistance } from './station-link';
import type { StationLink } from './station-link';
// --- omo voice lane (mount hook): room voice, talk-to-agent dictation, agent avatars ---
import { VoiceHub } from './voice-hub';
import { VoicePanel } from './voice-panel';
// --- end omo voice lane ---
// --- omo parity2 lane (mount hook): room chat, agent notifications, follow/teleport, name colours, speaking HUD ---
import { HudHub } from './hud-hub';
import { HudOverlay } from './hud-overlay';
// --- end omo parity2 lane ---
// --- omo focus lane (mount hook): attach-to-screen + full-screen terminal ---
import { FocusMode } from './focus-mode';
import { FocusOverlay } from './focus-overlay';
import { ShortcutsLane } from './shortcuts-lane'; // omo keys6 lane
import { OmoImmersiveService } from './immersive-service'; // omo immersive lane
import { ImmersivePill } from './immersive-hud'; // omo immersive lane
import { Icon } from './icons'; // omo immersive lane
// --- end omo focus lane ---
// --- w2:onboard (mount hook): prompt-to-world onboarding; see onboarding-flow.tsx ---
import { OnboardingFlow } from './onboarding-flow';
import { OnboardingPlanBackend } from './onboarding-admin';
import { OnboardingWorldSink, saveOnboardingWorld, readLocalWorld } from './onboarding-store';
import { v1RoomFor } from './onboarding-planner';
import type { WorldSpec } from '../common/world-model';
// --- end w2:onboard ---

export const TERMINAL_STATION_ID = 'terminal-1';
const TERMINAL_STATIONS: TerminalWorkstation[] = ['terminal', 'terminal-2'];

const CAMERA = { azimuth: 0.56, elevation: 0.61, distance: 24 };
const THEMES = {
    station: { title: 'Space station', eyebrow: 'ORBITAL / 01', description: 'A quiet observatory for your next big idea.', symbol: '◉' },
    jungle: { title: 'Prehistoric jungle', eyebrow: 'EXPEDITION / 02', description: 'A green retreat. Room to think, space to build.', symbol: '✳' }
};

function SceneView(props: { theme: RoomTheme; layout: RoomLayoutId; kit: RoomKitId; camera: RoomState['camera']; onSelect: (station: Workstation, point?: ScreenPoint) => void; onTextSelect: (station: TerminalWorkstation) => void; onCamera: (camera: RoomState['camera']) => void; walk: boolean; terminalFrames: Record<TerminalWorkstation, MonitorFrame>; webFrame?: WebSurfaceFrame; onInstance?: (scene: RoomScene | undefined) => void; onInput: (text: string) => void; onPaste: (text: string) => void; onScroll?: (delta: number) => void; onWebScroll?: (point: ScreenPoint, deltaY: number, deltaX: number) => void; onMessage: (text: string) => void; onShortcut?: (shortcut: 'new-shell' | 'select-tab-2' | 'workspace-picker') => void; onOpenLink?: (url: string) => void; onPose?: (pose: PlayerPose) => void; children?: React.ReactNode }): React.ReactElement {
    const host = React.useRef<HTMLDivElement>(null);
    const instance = React.useRef<RoomScene>();
    const callbacks = React.useRef(props); callbacks.current = props;
    const [error, setError] = React.useState('');
    const [ready, setReady] = React.useState(false);
    const [mode,setMode]=React.useState<'walk'|'overview'>(props.walk?'walk':'overview');
    React.useEffect(()=>{setMode(props.walk?'walk':'overview');},[props.walk]);
    React.useEffect(()=>{instance.current?.setNavigation(mode);},[mode]);
    React.useEffect(()=>{instance.current?.setTerminalFrames(props.terminalFrames);},[props.terminalFrames]);
    React.useEffect(()=>{if(props.webFrame)instance.current?.setWebFrame(props.webFrame);else instance.current?.clearWebFrame();},[props.webFrame]);
    React.useEffect(() => {
        if (!host.current) return;
        setError(''); setReady(false);
        const scene = new RoomScene(host.current, { theme: props.theme, layout: props.layout, kit: props.kit, camera: props.camera, walk: mode==='walk',
            onInput: text=>callbacks.current.onInput(text),onPaste:text=>callbacks.current.onPaste(text),onScroll:delta=>callbacks.current.onScroll?.(delta),onWebScroll:(point,dy,dx)=>callbacks.current.onWebScroll?.(point,dy,dx),onMessage:text=>callbacks.current.onMessage(text),
            onShortcut: shortcut=>callbacks.current.onShortcut?.(shortcut), onOpenLink:url=>callbacks.current.onOpenLink?.(url), onPose:pose=>callbacks.current.onPose?.(pose),
            onSelect: (action,point) => callbacks.current.onSelect(action,point), onCameraChange: camera => callbacks.current.onCamera(camera),
            onTextSelect: station => callbacks.current.onTextSelect(station),
            onReady: () => setReady(true), onError: message => setError(message) });
        instance.current = scene;scene.setTerminalFrames(callbacks.current.terminalFrames);if(callbacks.current.webFrame)scene.setWebFrame(callbacks.current.webFrame);callbacks.current.onInstance?.(scene);
        return () => { scene.dispose(); instance.current = undefined; callbacks.current.onInstance?.(undefined); };
    }, [props.theme, props.layout, props.kit]);
    return <div className={`omo-scene-wrap ${mode==='walk'?'omo-walking':''}`} data-theme={props.theme} data-navigation={mode}>
        <div ref={host} className="omo-scene" data-testid="omo-scene" data-ready={ready ? 'true' : 'false'} />
        {error && <div className="omo-render-error" role="alert"><strong>3D rendering could not start.</strong><p>{error}</p><p>The project terminal and editor are still available from the toolbar.</p></div>}
        {mode==='walk'&&<div className="omo-crosshair" aria-hidden="true">+</div>}
        {props.walk&&<div className="omo-navigation-switch"><button data-testid="walk-mode" aria-pressed={mode==='walk'} onClick={()=>setMode('walk')}>First person</button><button data-testid="overview-mode" aria-pressed={mode==='overview'} onClick={()=>setMode('overview')}>Overview</button></div>}

        <div className="omo-scene-controls"><span>{mode==='walk'?'WASD · Drag to look · Shift+drag text · Shift+double/triple-click word/line · Ctrl+Shift+C copy · Esc':'Drag to orbit · Scroll to zoom'}</span><button aria-label="Reset room camera" onClick={() => instance.current?.resetCamera()}>↺ Reset view</button></div>
        {props.children}
    </div>;
}

function safeStorage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }

@injectable()
export class OmoWorldWidget extends ReactWidget {
    static readonly ID = 'omo-world';
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(OmoRuntimeService) protected readonly runtime!: OmoRuntimeService;
    @inject(OmoWebService) protected readonly webRuntime!: OmoWebService;
    @inject(OmoPresenceService) protected readonly presenceService!: OmoPresenceService;
    @inject(GitReviewService) protected readonly gitReviewService!: GitReviewService;
    @inject(TaskWorkspaceService) protected readonly taskWorkspaceService!: TaskWorkspaceService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(OmoImmersiveService) protected readonly immersive!: OmoImmersiveService; // omo immersive lane
    // --- w2:onboard: optional admin planner + WorldStore sink (unbound = offline planner + localStorage) ---
    @inject(OnboardingPlanBackend) @optional() protected readonly onboardingPlanner?: OnboardingPlanBackend;
    @inject(OnboardingWorldSink) @optional() protected readonly onboardingSink?: OnboardingWorldSink;
    private onboardingClassic = false;
    private onboardingSaved?: { key: string; world?: WorldSpec };
    private savedOnboardingWorld(): WorldSpec | undefined {
        if (!this.project) return undefined;
        const key = `${this.project.toString()}:${this.onboardingEpoch}`;
        if (this.onboardingSaved?.key !== key) this.onboardingSaved = { key, world: readLocalWorld(safeStorage(), this.project.toString()) };
        return this.onboardingSaved.world;
    }
    private onboardingEpoch = 0;
    private onboardingWorld?: WorldSpec;
    private onboardingPreview = (world: WorldSpec): void => {
        this.onboardingWorld = world;
        const v1 = v1RoomFor(world);
        const scene = this.worldScene as unknown as { setWorld?: (w: WorldSpec) => void } | undefined;
        if (v1.theme !== this.draftTheme || v1.layout !== this.draftLayout || v1.kit !== this.draftKit) {
            if (this.anyStationLocked && v1.layout !== (this.room?.layout ?? 'classic')) v1.layout = this.room?.layout ?? 'classic';
            this.draftTheme = v1.theme; this.draftLayout = v1.layout; this.draftKit = v1.kit; this.update();
        }
        scene?.setWorld?.(world);
    };
    private onboardingCreate = async (world: WorldSpec): Promise<void> => {
        if (!this.project) throw new Error('Choose a project folder first.');
        const saved = await saveOnboardingWorld(world, this.project.toString(), this.onboardingSink, safeStorage());
        this.onboardingPreview(world); this.draftName = world.name;
        this.createRoom();
        if (this.configuring) throw new Error(this.error || 'The room could not be saved.');
        this.feedback = `World saved on this device${saved.via === 'local-storage' ? '' : ' (world store)'}. Nothing was started. Click a desk to open it.`; this.update();
    };
    // --- end w2:onboard ---
    private project?: URI;
    private room?: RoomState;
    private draftTheme: RoomTheme = 'station';
    private draftLayout: RoomLayoutId = 'classic';
    private draftKit: RoomKitId = 'hermes-desk';
    private draftName = '';
    private draftCamera?: RoomState['camera'];
    private presetRevision = 0;
    private presetReadEpoch = 0;
    private presetLoading = false;
    private presetStatus = '';
    private configuring = true;
    private error = '';
    private feedback = '';
    private busy = false;
    private initialized = false;
    private console?: RuntimeConsoleController;
    private consoleState: RuntimeConsoleState = RuntimeConsoleController.initial();
    private consoles = new Map<TerminalWorkstation, RuntimeConsoleController>();
    private consoleStates: Record<TerminalWorkstation, RuntimeConsoleState> = { terminal: RuntimeConsoleController.initial(), 'terminal-2': RuntimeConsoleController.initial() };
    private activeStation: TerminalWorkstation = 'terminal';
    private activeMode: Workstation = 'terminal';
    private monitors: Record<TerminalWorkstation, MonitorFrame> = { terminal: { lines: [] }, 'terminal-2': { lines: [] } };
    private mirrorMonitor?: MonitorFrame;
    private mirrorAttached = false;
    private mirrorAttaching = false;
    private web?: WebSurfaceController;
    private webState: WebWallState = { phase: 'idle', error: '', baseVolume: 1, distance: 0, gain: 1 };
    private savedWebUrl = '';
    private savedWebAudio = { muted: false, baseVolume: 1 };
    private webAudioApplied = false;
    private worldScene?: RoomScene;
    private presence?: PresenceController;
    private presenceState:PresenceState={phase:'solo',error:''};
    private personalRoom?:PresenceJoin;
    private tabIdentity:string=crypto.randomUUID();
    private review?:GitReviewController;
    private reviewState:GitReviewState={phase:'idle',loadingPatch:false,error:''};
    private reviewOpen=false;
    private taskOverviewOpen=false;
    private taskWorkspacesOpen=false;
    private taskWorkflowOpen=false;
    private recipeOpen=false;
    private recipes: StationRecipe[]=[];
    private stationLocks: StationLocks={ terminal: false, 'terminal-2': false };
    private get anyStationLocked(): boolean { return this.stationLocks.terminal || this.stationLocks['terminal-2']; }
    private pushStationLocks(): void { for (const station of TERMINAL_STATIONS) this.consoles.get(station)?.setStationLocked(this.stationLocks[station]); }
    private setStationLock = (station: 'terminal' | 'terminal-2', locked: boolean): void => {
        if (!this.project) return;
        const next = { ...this.stationLocks, [station]: locked };
        if (!writeStationLocks(safeStorage(), this.project.toString(), next)) { this.error = 'The lock could not be saved: browser storage is unavailable.'; this.update(); return; }
        this.stationLocks = next; this.pushStationLocks();
        this.feedback = locked ? `${station === 'terminal' ? 'Desk one' : 'Desk two'} is locked. Nothing running was stopped.` : `${station === 'terminal' ? 'Desk one' : 'Desk two'} is unlocked.`; this.update();
    };
    private stationLink: StationLink=defaultStationLink();
    private taskWorkspaceUiService!:TaskWorkspaceService;
    private reviewRequest=0;
    private codeReviewFrame?:CodeReviewFrame;
    // --- omo voice lane (mount hook) ---
    private voiceHub?: VoiceHub;
    // --- end omo voice lane ---
    private hudHub?: HudHub; // omo parity2 lane
    // --- omo focus lane (mount hook) ---
    private focusMode = new FocusMode({ scene: () => this.worldScene, activeStation: () => this.activeMode,
        select: station => this.selectStation(station), message: text => { this.feedback = text; this.update(); } });
    // --- end omo focus lane ---

    @postConstruct()
    protected init(): void {
        this.taskWorkspaceUiService=scopeTaskWorkspaceService(this.taskWorkspaceService,uri=>this.project?.toString()===uri&&(this.taskWorkspacesOpen||this.taskWorkflowOpen));
        this.id = OmoWorldWidget.ID; this.title.label = 'World'; this.title.caption = 'Omo · Your spatial workspace';
        this.title.closable = false; this.title.iconClass = 'codicon codicon-globe';
        this.addClass('omo-world-widget'); this.node.tabIndex = -1;
        this.toDispose.push({ dispose: () => this.invalidatePresetRead() });
        try {const saved=sessionStorage.getItem('omo.presence.tab.v1');if(saved&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(saved))this.tabIdentity=saved;sessionStorage.setItem('omo.presence.tab.v1',this.tabIdentity);}catch{/* Memory-only identity; never guesses another tab's terminals. */}
        this.presence=new PresenceController({service:this.presenceService,pose:()=>this.worldScene?.getPlayerPose()??{...PLAYER_HOME},schedule:(fn,ms)=>window.setTimeout(fn,ms),cancel:id=>window.clearTimeout(id as number),onChange:state=>this.presenceChanged(state)});
        this.toDispose.push({dispose:()=>{void this.presence?.dispose().catch(()=>undefined);}});
        // --- omo voice lane (mount hook): read-only access to presence, scene and desks. Starts nothing. ---
        this.voiceHub=new VoiceHub({presenceService:this.presenceService,presence:()=>this.presenceState,scene:()=>this.worldScene,layout:()=>this.room?.layout??'classic',
            desk:desk=>({state:this.consoleStates[desk],controller:this.consoles.get(desk)}),activeDesk:()=>this.activeStation,
            onChange:()=>this.update(),message:text=>{this.feedback=text;this.update();}});
        this.toDispose.push({dispose:()=>{this.voiceHub?.dispose();this.voiceHub=undefined;}});
        // --- end omo voice lane ---
        this.toDispose.push({ dispose: () => this.focusMode.dispose() }); // omo focus lane
        // --- omo immersive lane (mount hook): the room fills the window while a saved room shows. ---
        const offImmersive = this.immersive.mode.subscribe(() => this.update());
        this.toDispose.push({ dispose: () => { offImmersive(); this.immersive.mode.setEngaged(false); } });
        // --- end omo immersive lane ---
        // --- omo parity2 lane (mount hook): read-only getters; goToDesk is the same path as clicking the desk. Starts nothing. ---
        this.hudHub=new HudHub({presenceService:this.presenceService,presence:()=>this.presenceState,scene:()=>this.worldScene,layout:()=>this.room?.layout??'classic',
            desk:desk=>({state:this.consoleStates[desk],controller:this.consoles.get(desk)}),activeDesk:()=>this.activeMode,agents:()=>this.voiceHub?.state.agents??[],
            voice:()=>this.voiceHub?.state.voice,goToDesk:desk=>{this.chooseStation(desk);this.focusMode.sync();if(this.consoleStates[desk].phase==='live')this.focusMode.attachActive();else{this.feedback=`${desk==='terminal'?'Desk one':'Desk two'} is not connected. Click its monitor to reconnect. Nothing was started.`;this.update();}},onChange:()=>this.update()});
        this.toDispose.push({dispose:()=>{this.hudHub?.dispose();this.hudHub=undefined;}});
        // --- end omo parity2 lane ---
        this.review=new GitReviewController(this.gitReviewService,state=>{
            this.reviewState=state;
            if(state.phase!=='idle'){
                this.codeReviewFrame={title:state.patch?.path??'PROJECT CHANGES',lines:state.patch?state.patch.patch.split('\n'):state.snapshot?state.snapshot.changes.map(c=>`${c.status} ${c.path}`):[state.error||'Reading project Git status…'],status:state.loadingPatch?'Reading patch…':state.snapshot?.truncated&&!state.patch?'Git list capped at 200 files':'Read-only snapshot'};
                this.worldScene?.setCodeReview(this.codeReviewFrame);
            }
            this.update();
        });
        this.toDispose.push({dispose:()=>{this.reviewRequest++;this.reviewOpen=false;this.taskOverviewOpen=false;this.taskWorkspacesOpen=false;this.taskWorkflowOpen=false;this.review?.close();}});
        for (const station of TERMINAL_STATIONS) this.consoles.set(station, new RuntimeConsoleController({ service: this.runtime, storage: safeStorage(),
            schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: handle => window.clearTimeout(handle as number),
            onChange: state => this.consoleChanged(state, station), onMirrorFrame: frame => { this.mirrorMonitor = frame ? this.toMonitorFrame(frame, station) : undefined; if (!frame) this.mirrorAttached = false; this.worldScene?.setMirrorFrame(this.mirrorMonitor); }, onMirrorError: message => { this.feedback = message; this.update(); } }));
        this.console = this.consoles.get(this.activeStation);
        this.web = new WebSurfaceController({ service: this.webRuntime, schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: handle => window.clearTimeout(handle as number), onChange: state => this.webChanged(state) });
        // Detach only: the runtime keeps every tab and process running.
        this.toDispose.push({ dispose: () => { this.consoles.forEach(controller => controller.dispose()); this.consoles.clear(); this.console = undefined; void this.web?.dispose(); this.web = undefined; } });
        this.toDispose.push(this.workspace.onWorkspaceChanged(roots => this.projectChanged(roots[0]?.resource)));
        this.initialize().catch(error => { this.error = String(error); this.initialized = true; this.update(); });
    }
    // --- omo immersive lane: engaged only while this widget shows a saved room (never during setup). ---
    private syncImmersive(): void { this.immersive.mode.setEngaged(!this.isDisposed && this.isVisible && this.initialized && !!this.room && !this.configuring); }
    protected override onAfterShow(msg: Message): void { super.onAfterShow(msg); this.syncImmersive(); }
    protected override onAfterHide(msg: Message): void { super.onAfterHide(msg); this.syncImmersive(); }
    protected override onBeforeDetach(msg: Message): void { this.immersive.mode.setEngaged(false); super.onBeforeDetach(msg); }
    protected override onUpdateRequest(msg: Message): void { super.onUpdateRequest(msg); this.syncImmersive(); }
    private toggleImmersiveButton = (): void => { this.worldScene?.releaseTyping(); this.immersive.toggleFromButton(); this.focusMode.controls?.element.focus({ preventScroll: true }); };
    private leaveImmersive = (): void => { this.immersive.leave(); this.focusMode.controls?.element.focus({ preventScroll: true }); };
    // --- end omo immersive lane ---
    private storageKey(): string { return `omo.room.v1:${this.project?.toString() ?? ''}`; }
    private async initialize(): Promise<void> {
        const roots = await this.workspace.roots;
        this.project = roots[0]?.resource;
        this.readWebBinding();
        this.readStationSettings();
        this.draftName = this.project?.path.base || 'My workspace';
        if (this.project) {
            try {
                const raw = localStorage.getItem(this.storageKey());
                this.room = parseRoomState(raw, this.project.toString());
                if (raw && !this.room) this.feedback = 'Saved room settings could not be read. Choose a theme to recreate this project’s room.';
                if (this.room) { this.draftTheme = this.room.theme; this.draftLayout = this.room.layout ?? 'classic'; this.draftKit = this.room.kit ?? 'hermes-desk'; this.draftName = this.room.projectName; this.configuring = false; }
            } catch { this.error = 'Browser storage is unavailable. Allow local storage to save your room.'; }
        }
        this.initialized = true; this.update();
        // Reconnect a workspace this room already opened. Never starts anything new.
        if (this.room) for (const station of TERMINAL_STATIONS) { const binding = this.binding(station); if (binding) void this.consoles.get(station)?.reconnect(binding); }
    }
    private binding(station: TerminalWorkstation = this.activeStation): StationBinding | undefined {
        if (!this.project) return undefined;
        const localStation=station === 'terminal' ? TERMINAL_STATION_ID : 'terminal-2';
        return { stationId: this.personalRoom?presenceStation(this.personalRoom,localStation):localStation, projectUri: this.project.toString(), name: `${this.room?.projectName ?? this.draftName ?? this.project.path.base}${this.personalRoom?` · ${this.personalRoom.name}`:''}${station === 'terminal-2' ? ' · Desk two' : ''}` };
    }
    private presenceChanged(state:PresenceState):void {
        const old=this.personalRoom;
        this.presenceState=state;
        // Leave/connection loss removes presence, NOT the participant's current terminal bindings.
        if(state.phase==='joined'&&state.join)this.personalRoom=state.join;
        this.worldScene?.setPeers(state.snapshot?.members.filter(m=>m.id!==state.snapshot?.selfId)??[]);
        if(this.personalRoom&&(old?.roomId!==this.personalRoom.roomId||old?.clientId!==this.personalRoom.clientId)){
            this.worldScene?.releaseTyping();
            for(const station of TERMINAL_STATIONS){const binding=this.binding(station);if(binding)void this.consoles.get(station)?.reconnect(binding);}
        }
        this.update();
    }
    private joinPresence=(roomId:string,name:string):void=>{
        if(!this.room||!this.project)return;
        this.worldScene?.releaseTyping();
        void this.presence?.join({roomId,name,projectUri:this.project.toString(),theme:this.room.theme,layout:this.room.layout??'classic',clientId:this.tabIdentity}).catch(error=>{this.error=String(error);this.update();});
    };
    private leavePresence=():void=>{this.worldScene?.releaseTyping();void this.presence?.leave().catch(error=>{this.error=String(error);this.update();});};
    private projectChanged(next: URI | undefined): void {
        if (next?.toString() === this.project?.toString()) return;
        this.invalidatePresetRead(); this.draftCamera = undefined; this.presetStatus = '';
        this.taskOverviewOpen=false;
        this.taskWorkspacesOpen=false;
        this.closeReview();
        this.taskWorkflowOpen=false;this.codeReviewFrame=undefined;this.worldScene?.setCodeReview({title:'PROJECT CHANGES',lines:['Open review for the selected project.'],status:'No Git contents read yet'});
        this.leavePresence();this.personalRoom=undefined;
        this.project = next;
        this.readWebBinding();
        this.readStationSettings();
        this.onboardingClassic = false; this.onboardingEpoch++; this.onboardingWorld = undefined; // w2:onboard
        this.room = undefined; this.configuring = true; this.draftLayout = 'classic'; this.draftKit = 'hermes-desk'; this.draftName = next?.path.base || 'My workspace';
        if (next) {
            try {
                this.room = parseRoomState(localStorage.getItem(this.storageKey()), next.toString());
                if (this.room) { this.draftTheme = this.room.theme; this.draftLayout = this.room.layout ?? 'classic'; this.draftKit = this.room.kit ?? 'hermes-desk'; this.draftName = this.room.projectName; this.configuring = false; }
            } catch { /* storage errors were reported at start-up */ }
        }
        void this.web?.close();
        for (const station of TERMINAL_STATIONS) { const binding = this.binding(station); if (binding) void this.consoles.get(station)?.reconnect(binding); else this.consoles.get(station)?.release(); }
        this.update();
    }
    private readStationSettings(): void {
        this.recipes = this.project ? readStationRecipes(safeStorage(), this.project.toString()) : [];
        this.stationLocks = this.project ? readStationLocks(safeStorage(), this.project.toString()) : { terminal: false, 'terminal-2': false };
        this.pushStationLocks();
        this.stationLink = this.project ? (readStationLink(safeStorage(), this.project.toString()) ?? defaultStationLink()) : defaultStationLink();
    }
    private readWebBinding(): void {
        this.savedWebUrl = '';
        this.savedWebAudio = { muted: false, baseVolume: 1 };
        this.webAudioApplied = false;
        if (!this.project) return;
        try { const data = JSON.parse(localStorage.getItem(`omo.webwall.v1:${this.project}`) || 'null'); if (typeof data?.url === 'string' && /^https?:\/\//.test(data.url)) this.savedWebUrl = data.url; if (typeof data?.muted === 'boolean' && typeof data?.baseVolume === 'number' && data.baseVolume >= 0 && data.baseVolume <= 1) this.savedWebAudio = { muted: data.muted, baseVolume: data.baseVolume }; } catch { /* a bad local binding is not permission to browse */ }
    }
    private webChanged(state: WebWallState): void {
        this.webState = state;
        if (!state.surface) this.webAudioApplied = false;
        if (state.surface && !this.webAudioApplied) {
            this.webAudioApplied = true;
            void this.web?.setAudio(this.savedWebAudio.muted, this.savedWebAudio.baseVolume);
        }
        const url = state.surface?.url;
        if (this.project && url && /^https?:\/\//.test(url) && url !== this.savedWebUrl) {
            this.savedWebUrl = url;
        }
        if (this.project && state.surface) {
            const prefs = this.web?.audioPreferences ?? { muted: state.surface.muted, baseVolume: state.baseVolume ?? state.surface.volume };
            this.savedWebAudio = prefs;
            try { localStorage.setItem(`omo.webwall.v1:${this.project}`, JSON.stringify({ url: this.savedWebUrl || state.surface.url, muted: prefs.muted, baseVolume: prefs.baseVolume })); } catch { this.feedback = 'The web preferences could not be saved on this device.'; }
        }
        this.update();
    }
    private toMonitorFrame(frame: RuntimeFrame, station: TerminalWorkstation): MonitorFrame {
        const state = this.consoleStates[station];
        const tab = state.workspace?.tabs.find(candidate => candidate.id === state.activeTabId);
        return { lines: frame.lines, cells: frame.cells, foreground: frame.foreground, background: frame.background, truecolor: frame.truecolor, palette: frame.palette, cursor: frame.cursor,
            unreadBells: 0, title: state.workspace ? `${state.workspace.name} / ${tab?.name ?? 'Mirror'}` : 'Linked monitor', status: tab?.busy ? 'Process active' : tab?.state === 'interrupted' ? 'interrupted' : 'live' };
    }
    private consoleChanged(state: RuntimeConsoleState, station: TerminalWorkstation): void {
        const old = this.consoleStates[station];
        const framed = state.lines !== old.lines || state.cursor !== old.cursor || state.truecolor !== old.truecolor || state.statusText !== old.statusText || state.workspace !== old.workspace || state.activeTabId !== old.activeTabId || state.unreadBells !== old.unreadBells;
        this.consoleStates[station] = state;
        if (state.phase === 'live' && station === this.stationLink.targetStationId && !this.mirrorAttached && !this.mirrorAttaching) {
            // attachMirror clears its old frame synchronously. That is not a
            // disconnect and must not allow the next poll to start another attach.
            this.mirrorAttaching = true;
            void this.consoles.get(station)?.attachMirror(this.binding(station)?.stationId).then(ok => {
                if (station !== this.stationLink.targetStationId) {
                    this.consoles.get(station)?.detachMirror();
                    this.mirrorAttached = false;
                } else this.mirrorAttached = ok;
                this.mirrorAttaching = false;
            }, () => { this.mirrorAttached = false; this.mirrorAttaching = false; });
        }
        if (station === this.activeStation) this.consoleState = state;
        if (framed) {
            const tab = state.workspace?.tabs.find(t => t.id === state.activeTabId);
            this.monitors = { ...this.monitors, [station]: { lines: state.lines, cells: state.cells, unreadBells: state.unreadBells, foreground: state.foreground, background: state.background, truecolor: state.truecolor, palette: state.palette, cursor: state.cursor,
                title: tab ? `${state.workspace?.name ?? 'OMO'} / ${tab.name}` : undefined, status: state.phase === 'live' && tab?.state === 'running' ? (tab.busy ? 'Process active' : 'live') : (tab && tab.state !== 'running' ? tab.state : state.statusText) } };
        }
        this.update();
    }
    private save(state: RoomState): boolean {
        try { localStorage.setItem(this.storageKey(), JSON.stringify(state)); this.error = ''; return true; }
        catch { this.error = 'Your room could not be saved. Check browser storage before continuing.'; this.update(); return false; }
    }
    private createRoom = (): void => {
        if (!this.project || !this.draftName.trim() || this.presetLoading) return;
        if (this.anyStationLocked && this.room && this.draftLayout !== (this.room.layout ?? 'classic')) { this.error = 'A desk is locked, so the room layout was not changed. Unlock it in Station recipes first.'; this.update(); return; }
        this.invalidatePresetRead();
        const next: RoomState = { version: 1, theme: this.draftTheme, layout: this.draftLayout, kit: this.draftKit, projectUri: this.project.toString(),
            projectName: this.draftName.trim().slice(0, 120), camera: { ...(this.draftCamera ?? this.room?.camera ?? CAMERA) } };
        if (!this.save(next)) return;
        this.room = next; this.configuring = false; this.feedback = 'Room saved on this device.'; this.update();
    };
    private cameraChanged = (camera: RoomState['camera']): void => {
        if (this.configuring) { this.draftCamera = { ...camera }; return; }
        if (!this.room) return;
        const next = { ...this.room, camera };
        if (this.save(next)) this.room = next;
    };
    private chooseStation = (station: TerminalWorkstation | 'web'): void => {
        this.worldScene?.releaseTyping(); this.activeMode = station;
        if (station !== 'web') { this.activeStation = station; this.console = this.consoles.get(station); this.consoleState = this.consoleStates[station]; }
        this.update();
    };
    private saveStationRecipe = (input: Omit<StationRecipe, 'version' | 'id'>): void => {
        if (!this.project) return;
        if (this.stationLocks[input.stationId]) { this.error = 'This desk is locked, so the recipe was not saved.'; this.update(); return; }
        try {
            const recipe = makeStationRecipe(input);
            const next = [...this.recipes.filter(existing => existing.id !== recipe.id), recipe];
            if (!writeStationRecipes(safeStorage(), this.project.toString(), next)) throw new Error('The recipe is too large or storage is unavailable.');
            this.recipes = next; this.feedback = 'Recipe saved. Saving did not launch a tab.'; this.update();
        } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.update(); }
    };
    private deleteStationRecipe = (recipe: StationRecipe): void => { if (!this.project || this.stationLocks[recipe.stationId]) return; const next = this.recipes.filter(item => item.id !== recipe.id); if (writeStationRecipes(safeStorage(), this.project.toString(), next)) { this.recipes = next; this.update(); } };
    private applyStationRecipe = (recipe: StationRecipe): void => { this.chooseStation(recipe.stationId); this.consoles.get(recipe.stationId)?.requestRecipeApply(recipe); this.recipeOpen = false; this.update(); };
    private linkMirror = (targetStationId: 'terminal' | 'terminal-2'): void => {
        if (!this.project) return;
        const next: StationLink = { version: 1, mirrorId: 'monitor-mirror', targetStationId };
        if (!writeStationLink(safeStorage(), this.project.toString(), next)) { this.error = 'The mirror link could not be saved.'; this.update(); return; }
        this.stationLink = next; void this.consoles.get(targetStationId)?.attachMirror(this.binding(targetStationId)?.stationId); this.feedback = `Mirror linked to ${targetStationId === 'terminal' ? 'Desk one' : 'Desk two'}.`; this.update();
    };
    private monitorShortcut = (shortcut: 'new-shell' | 'select-tab-2' | 'workspace-picker'): void => {
        if (shortcut === 'new-shell') void this.console?.requestNewTab('shell');
        else if (shortcut === 'select-tab-2') { const tab = this.consoleState.workspace?.tabs[1]; if (tab) void this.console?.selectTab(tab.id); else { this.feedback = 'There is no second tab on this desk yet.'; this.update(); } }
        else { this.console?.refreshBoard(); this.feedback = 'Workspace picker opened in Manage. No shell input was sent.'; this.update(); }
    };
    private poseChanged = (pose: PlayerPose): void => { void this.web?.setDistance(webWallDistance(pose)); };

    private selectStation = (station: Workstation, point?: ScreenPoint): void => {
        if (this.configuring) { this.feedback = 'Create your room first, then select a workstation.'; this.update(); return; }
        if (station === 'code') { void this.runAction(() => this.openCode()); return; }
        if (station === 'mirror') {
            const target = this.stationLink.targetStationId;
            this.chooseStation(target);
            const controller = this.consoles.get(target);
            void controller?.attachMirror(this.binding(target)?.stationId).then(ok => { this.feedback = ok ? `Mirror follows ${target === 'terminal' ? 'Desk one' : 'Desk two'} · same station, independent view size.` : 'Mirror is not attached yet. Open the linked desk first.'; this.update(); });
            return;
        }
        this.chooseStation(station);
        if (station === 'web') {
            if (point && this.webState.surface) void this.web?.click(point);
            else if (!this.webState.surface && this.savedWebUrl) void this.web?.open(this.savedWebUrl);
            else { this.feedback = 'Open a web address above. Then click the physical wall to use the page.'; this.update(); }
            return;
        }
        // Each physical computer owns a separate controller; switching desks cannot route keys to a previous desk.
        void this.openTerminal(station).catch(error => { if (this.activeMode === station) { this.error = String(error); this.update(); } });
    };
    private async runAction(action: () => Promise<void>): Promise<void> {
        if (this.busy) return;
        this.busy = true; this.error = ''; this.update();
        try { await action(); } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
        finally { this.busy = false; this.update(); }
    }
    private terminalInput = (text: string): void => { if (this.activeMode === 'web') void this.web?.sendInput(text); else void this.console?.sendInput(text); };
    private openTerminalLink = (url: string): void => {
        try {
            const destination = normalizeWebUrl(url);
            if (!this.web) throw new Error('The web wall is not ready.');
            this.chooseStation('web');
            void this.web.open(destination);
        } catch (error) { this.error = String(error); this.update(); }
    };
    private pasteInput = (text: string): void => { if (this.activeMode === 'web') void this.web?.paste(text); else void this.console?.paste(text); };
    /** omo webscroll lane: wheel over the web wall (within reach) scrolls the page at the pointer. No click needed. */
    private webScroll = (point: ScreenPoint, deltaY: number, deltaX: number): void => { void this.web?.scrollAt(point, deltaY, deltaX); };
    private worldScroll = (deltaY: number): void => { if (this.activeMode === 'web') void this.web?.scroll(deltaY); else void this.console?.wheel(-Math.sign(deltaY) * 3); };
    /** Click on the physical monitor: open (or reconnect) this room's persistent workspace on the runtime. */
    private async openTerminal(station: TerminalWorkstation): Promise<void> {
        const binding = this.binding(station);
        if (!binding) throw new Error('Choose a project folder first.');
        const controller = this.consoles.get(station); await controller?.bind(binding);
        if (this.activeMode === station) { this.feedback = controller?.state.phase === 'live' ? 'Live terminal on this monitor · Type here. Esc to walk away.' : controller?.state.error || controller?.state.statusText || ''; this.update(); }
    }
    private async openReviewSnapshot(): Promise<GitReviewSnapshot | undefined> {
        const request = ++this.reviewRequest;
        const project = this.project?.toString();
        if (!project) throw new Error('Choose a project folder first.');
        this.taskOverviewOpen=false;
        this.taskWorkspacesOpen=false;
        this.worldScene?.releaseTyping();
        this.reviewOpen = true;
        this.update();
        await this.review?.open(project);
        if (request !== this.reviewRequest || !this.reviewOpen || this.project?.toString() !== project) return undefined;
        if (this.reviewState.phase !== 'ready' || this.reviewState.projectUri !== project || !this.reviewState.snapshot || this.reviewState.snapshot.projectUri !== project) return undefined;
        return this.reviewState.snapshot;
    }
    private async openCode(): Promise<void> { await this.openReviewSnapshot(); }
    private openTaskReview=(): Promise<GitReviewSnapshot | undefined> => this.openReviewSnapshot();
    private openTaskOverview=():void=>{
        if(!this.project||!this.room)return;
        this.worldScene?.releaseTyping();
        ++this.reviewRequest;this.reviewOpen=false;this.review?.close();
        this.taskWorkspacesOpen=false;
        this.taskOverviewOpen=true;this.update();
    };
    private closeTaskOverview=():void=>{this.taskOverviewOpen=false;this.update();};
    private openTaskWorkspaces=():void=>{
        if(!this.project||!this.room)return;
        this.worldScene?.releaseTyping();
        ++this.reviewRequest;this.reviewOpen=false;this.review?.close();
        this.taskOverviewOpen=false;this.taskWorkspacesOpen=true;this.update();
    };
    private closeTaskWorkspaces=():void=>{this.taskWorkspacesOpen=false;this.update();};
    private openAgentWorkflow=():void=>{
        if(!this.project||!this.room||this.activeMode==='web')return;
        this.worldScene?.releaseTyping();
        ++this.reviewRequest;this.reviewOpen=false;this.taskOverviewOpen=false;this.taskWorkspacesOpen=false;
        this.taskWorkflowOpen=true;this.update();
    };
    private closeAgentWorkflow=():void=>{this.taskWorkflowOpen=false;this.update();};
    private continueAgentWorkflowDesk=async(stationId:string):Promise<void>=>{
        if(!this.project||!this.room||!this.taskWorkflowOpen)throw new Error('The agent task page is not active.');
        const station=TERMINAL_STATIONS.find(candidate=>this.binding(candidate)?.stationId===stationId);
        if(!station)throw new Error('The saved desk is not available in this room.');
        this.chooseStation(station);
        await this.openTerminal(station);
    };
    private openAgentWorkflowProject=async(uri:string,expectedSourceUri:string|undefined):Promise<void>=>{
        if(!expectedSourceUri||!this.taskWorkflowOpen||this.project?.toString()!==expectedSourceUri)return;
        const authority=this.taskWorkspaceUiService as TaskWorkspaceAuthority;
        const receipt=await authority.getTaskWorkspace(uri);
        if(!receipt||receipt.sourceProjectUri!==expectedSourceUri||receipt.worktreeUri!==uri)throw new Error('The registered task workspace did not match the open request.');
        this.taskWorkflowOpen=false;this.update();
        await this.workspace.open(new URI(uri),{preserveWindow:true});
    };
    private openTaskProject=async(uri:string,expectedSourceUri:string|undefined):Promise<void>=>{
        if(!expectedSourceUri||!this.taskWorkspacesOpen||this.project?.toString()!==expectedSourceUri)return;
        this.closeWorkspacePanels();
        this.workspace.open(new URI(uri),{preserveWindow:true});
    };
    private closeWorkspacePanels=():void=>{++this.reviewRequest;this.reviewOpen=false;this.taskOverviewOpen=false;this.taskWorkspacesOpen=false;this.review?.close();this.update();};
    private closeReview=():void=>{++this.reviewRequest;this.reviewOpen=false;this.review?.close();this.update();};
    private openReviewedFile=(uri:string):void=>{void this.runAction(async()=>{await this.editors.open(new URI(uri),{mode:'activate'});});};
    private async openProjectFile(): Promise<void> {
        if (!this.project) throw new Error('Choose a project folder first.');
        let target = this.project.resolve('README.md');
        if (!await this.files.exists(target)) {
            const folder = await this.files.resolve(this.project);
            const selected = await this.dialogs.showOpenDialog({ title: 'Open a project file', canSelectFiles: true, canSelectFolders: false }, folder);
            if (!selected) return;
            target = selected;
        }
        await this.editors.open(target, { mode: 'activate' });
        this.feedback = 'The same project, in the real editor.';
    }
    private chooseProject = (): void => { void this.runAction(async () => {
        const root = this.project ? await this.files.resolve(this.project) : undefined;
        const selected = await this.dialogs.showOpenDialog({ title: 'Choose your project folder', canSelectFiles: false, canSelectFolders: true }, root);
        if (selected) await this.workspace.open(selected);
    }); };
    private invalidatePresetRead(): void { this.presetReadEpoch++; this.presetLoading = false; }
    private importPreset = async (file: File): Promise<void> => {
        if (!this.project || !this.configuring) return;
        const epoch = ++this.presetReadEpoch;
        const project = this.project.toString();
        const ownsPreview = (): boolean => epoch === this.presetReadEpoch && this.configuring && project === this.project?.toString();
        this.presetLoading = true; this.presetStatus = ''; this.error = '';
        if (file.size > ROOM_PRESET_MAX_BYTES) {
            this.presetLoading = false; this.error = 'Room preset files must be at most 8 KiB (8192 bytes).'; this.update(); return;
        }
        this.update();
        let raw: string;
        try { raw = await file.text(); }
        catch {
            if (ownsPreview()) { this.presetLoading = false; this.error = 'The room preset file could not be read.'; this.update(); }
            return;
        }
        if (!ownsPreview()) return;
        try {
            const preset = parseRoomPreset(raw);
            this.draftTheme = preset.theme; this.draftLayout = preset.layout; this.draftCamera = { ...preset.camera };
            this.presetRevision++; this.presetStatus = 'Appearance loaded into preview. Save room to apply it to this project.';
        } catch { this.error = 'That file is not a valid Omo appearance preset (8 KiB maximum).'; }
        this.presetLoading = false; this.update();
    };
    private exportPreset = (): void => {
        if (!this.room) return;
        try {
            const contents = exportRoomPreset(this.room);
            const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = ROOM_PRESET_FILENAME;
            document.body.appendChild(link);
            try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60000); }
            this.error = ''; this.presetStatus = 'Saved appearance exported. Project paths, names and running sessions are not included.'; this.update();
        } catch { this.error = 'Those saved appearance settings could not be exported.'; this.update(); }
    };
    private cancelConfiguration = (): void => { this.invalidatePresetRead(); this.presetRevision++; this.presetStatus = ''; this.error = ''; this.configuring = false; this.update(); };
    private configure = (): void => { this.invalidatePresetRead(); this.presetStatus = ''; this.error = ''; this.leavePresence();this.draftTheme = this.room?.theme ?? 'station'; this.draftLayout = this.room?.layout ?? 'classic'; this.draftKit = this.room?.kit ?? 'hermes-desk'; this.draftCamera = this.room ? { ...this.room.camera } : undefined; this.draftName = this.room?.projectName ?? this.draftName; this.configuring = true; this.feedback = ''; this.onboardingClassic = false; this.onboardingEpoch++; /* w2:onboard */ this.update(); };

    protected render(): React.ReactNode {
        if (!this.initialized) return <div className="omo-loading">Opening your workspace…</div>;
        const theme = this.configuring ? this.draftTheme : this.room!.theme;
        const layout = this.configuring ? this.draftLayout : this.room?.layout ?? 'classic';
        const taskSourceUri=this.project?.toString();
        return <main className={`omo-root omo-${theme}`} data-testid="omo-world" data-project-uri={this.project?.toString()||''} data-configured={this.room ? 'true' : 'false'} data-active-station={this.activeMode} data-immersive={String(this.immersive.mode.active)}>
            {/* design lane (omo/build-design): header markup + classNames only */}
            <header className="omo-header">
                <div className="omo-brand"><span className="omo-brand-mark">o<span>m</span>o</span><span className="omo-brand-caption">Spatial IDE</span></div>
                <nav className="omo-view-switch" aria-label="Workspace views"><button className={!this.reviewOpen&&!this.taskOverviewOpen&&!this.taskWorkspacesOpen?'active':''} aria-current={!this.reviewOpen&&!this.taskOverviewOpen&&!this.taskWorkspacesOpen?'page':undefined} onClick={this.closeWorkspacePanels}>◈ World</button><button type="button" data-testid="task-overview-toggle" className={this.taskOverviewOpen?'active':''} aria-expanded={this.taskOverviewOpen} disabled={!this.room || !this.project || this.busy} onClick={() => this.taskOverviewOpen ? this.closeTaskOverview() : this.openTaskOverview()}>▤ Task overview</button><button type="button" data-testid="task-workspace-toggle" className={this.taskWorkspacesOpen?'active':''} aria-expanded={this.taskWorkspacesOpen} disabled={!this.room || !this.project || this.busy} onClick={() => this.taskWorkspacesOpen ? this.closeTaskWorkspaces() : this.openTaskWorkspaces()}>⑂ Task workspaces</button><button data-testid="review-action" className={this.reviewOpen?'active':''} disabled={!this.room || this.busy} onClick={() => this.selectStation('code')}>⌘ Code</button></nav>
                <span className="omo-local" title="Runs on this device"><i/> Local workspace</span>
            </header>
            {this.reviewOpen&&<GitReviewPanel state={this.reviewState} onSelect={path=>{void this.review?.select(path);}} onRefresh={()=>{if(this.project)void this.review?.open(this.project.toString());}} onClose={this.closeReview} onOpenFile={this.openReviewedFile} onOpenProject={()=>{void this.runAction(()=>this.openProjectFile());}}/>}
            {this.taskOverviewOpen&&this.project&&this.room&&<div className="omo-task-overview-view"><TaskOverviewPanel projectUri={this.project.toString()} onClose={this.closeTaskOverview}/></div>}
            {this.taskWorkspacesOpen&&this.project&&this.room&&<div className="omo-task-overview-view"><TaskWorkspacePanel projectUri={this.project.toString()} service={this.taskWorkspaceUiService} onClose={this.closeTaskWorkspaces} onOpen={uri=>this.openTaskProject(uri,taskSourceUri)}/></div>}
            <div className={`omo-body ${this.configuring ? 'is-onboarding' : ''}`} style={this.reviewOpen||this.taskOverviewOpen||this.taskWorkspacesOpen?{display:'none'}:undefined}>
                {/* design lane (omo/build-design): setup markup + classNames only — scroll body + pinned action footer */}
                {/* w2:onboard (mount hook): new 3-step flow; the classic form below stays reachable via "Room settings" */}
                {this.configuring && !this.onboardingClassic && <OnboardingFlow key={`${this.project?.toString() ?? ''}:${this.onboardingEpoch}`} initialName={this.draftName} initialTheme={this.draftTheme}
                    savedWorld={this.savedOnboardingWorld()} projectPath={this.project?.path.toString()} hasRoom={!!this.room} busy={this.busy || this.presetLoading}
                    hermes={this.onboardingPlanner} fullPreview={typeof (this.worldScene as unknown as { setWorld?: unknown } | undefined)?.setWorld === 'function'}
                    onPreview={this.onboardingPreview} onCreate={this.onboardingCreate} onChooseProject={this.chooseProject} onCancel={this.cancelConfiguration}
                    onClassic={() => { this.onboardingClassic = true; this.update(); }}/>}
                {this.configuring && this.onboardingClassic ? <section className="omo-onboarding" data-testid="omo-onboarding"><div className="omo-setup-scroll">
                    <button type="button" className="omo-ob-link" data-testid="onboarding-describe" onClick={() => { this.onboardingClassic = false; this.update(); }}>← Describe a world instead</button>{/* w2:onboard */}
                    <span className="omo-kicker">YOUR WORK, SOMEWHERE YOU REMEMBER</span>
                    <h1>A place for<br/>your next idea.</h1>
                    <p className="omo-intro">Make this workspace feel like you.<br/>Your code and tools are already at home.</p>
                    <div className="omo-step-title"><span>01</span> Choose your world</div>
                    <div className="omo-theme-list">{(Object.keys(THEMES) as RoomTheme[]).map(key => <button key={key} data-testid={`theme-${key}`} className={`omo-theme-card ${theme === key ? 'selected' : ''}`} aria-pressed={theme === key} disabled={this.presetLoading || this.busy} onClick={() => { this.draftTheme = key; this.update(); }}>
                        <span className="omo-theme-symbol">{THEMES[key].symbol}</span><span><strong>{THEMES[key].title}</strong><small>{THEMES[key].eyebrow}</small></span><span className="omo-radio"/>
                    </button>)}</div>
                    <div className="omo-step-title"><span>02</span> Make it yours</div>
                    <label className="omo-field">Room layout<select data-testid="room-layout" aria-label="Room layout" value={layout} disabled={this.presetLoading || this.busy || this.anyStationLocked} onChange={event => { this.draftLayout = event.target.value as RoomLayoutId; this.update(); }}>
                        {(Object.keys(ROOM_LAYOUTS) as RoomLayoutId[]).map(key => <option key={key} value={key}>{ROOM_LAYOUTS[key].label}</option>)}
                    </select><small>{ROOM_LAYOUTS[layout].description}</small>{this.anyStationLocked && <small data-testid="room-layout-locked" role="note">🔒 A desk is locked, so the room layout cannot change. Unlock it in Station recipes.</small>}</label>
                    <label className="omo-field">Room kit<select data-testid="room-kit" aria-label="Room kit" value={this.configuring ? this.draftKit : this.room?.kit ?? 'hermes-desk'} disabled={this.presetLoading || this.busy} onChange={event => { this.draftKit = event.target.value as RoomKitId; this.update(); }}>
                        {(Object.keys(ROOM_KITS) as RoomKitId[]).map(key => <option key={key} value={key}>{ROOM_KITS[key].label}</option>)}
                    </select><small>{ROOM_KITS[this.configuring ? this.draftKit : this.room?.kit ?? 'hermes-desk'].description}</small></label>
                    <label className="omo-field">Workspace name<input data-testid="room-name" maxLength={120} defaultValue={this.draftName} onChange={event => { this.draftName = event.target.value; this.update(); }} placeholder="My next big thing" /></label>
                    <div className="omo-field">Project folder<div className="omo-folder"><span title={this.project?.path.toString()}>{this.project?.path.toString() ?? 'No folder selected'}</span><button onClick={this.chooseProject} disabled={this.busy}>Browse</button></div></div>
                    <fieldset className="omo-preset-controls" aria-label="Portable room appearance">
                        <legend>Room appearance preset</legend>
                        <label className="omo-field">Import JSON (maximum 8 KiB)<input type="file" accept=".json,application/json" data-testid="room-preset-import" aria-label="Import room appearance preset" disabled={this.presetLoading || this.busy} onChange={event => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ''; if (file) void this.importPreset(file); }}/></label>
                        <button type="button" data-testid="room-preset-export" disabled={!this.room || this.presetLoading || this.busy} onClick={this.exportPreset}>Export saved room</button>
                        <p>Appearance only. No project names, paths, sessions or agent settings. Import previews first; Save room applies it.</p>
                        <span role="status" data-testid="room-preset-status">{this.presetLoading ? 'Reading appearance preset…' : this.presetStatus}</span>
                    </fieldset>
                    </div><div className="omo-setup-actions">
                    <button className="omo-primary" data-testid="create-room" disabled={!this.project || !this.draftName.trim() || this.busy || this.presetLoading} onClick={this.createRoom}>{this.room ? 'Save room' : 'Create my room'} <span>↗</span></button>
                    {this.room && <button className="omo-cancel" data-testid="cancel-room" onClick={this.cancelConfiguration}>Back to my room</button>}
                    <p className="omo-privacy">Saved on this device. No account. No model calls.</p>
                </div></section> : null}
                <section className="omo-stage" aria-label="Spatial workspace">
                    <div className="omo-stage-heading"><div><span className="omo-kicker">{THEMES[theme].eyebrow}</span><h2>{this.configuring ? THEMES[theme].title : this.room!.projectName}</h2><p>{this.configuring ? THEMES[theme].description : 'Same project. A different perspective.'}</p></div>
                        {!this.configuring && <button className="omo-outline" data-testid="edit-room" onClick={this.configure}>◌ Customise room</button>}
                    </div>
                    {this.room && !this.configuring && <div className="omo-console-dock" onPointerDownCapture={()=>this.worldScene?.releaseTyping()}>
                        <PresenceStrip state={this.presenceState} onJoin={this.joinPresence} onLeave={this.leavePresence} deskRoom={this.personalRoom?.roomId}/>
                        {/* omo voice lane (mount hook) */}{this.voiceHub&&<VoicePanel hub={this.voiceHub} view={this.voiceHub.state}/>}
                        <nav className="omo-station-switch" aria-label="Physical workstations"><button data-testid="station-one-controls" aria-pressed={this.activeMode === 'terminal'} onClick={()=>this.chooseStation('terminal')}>Desk one{this.consoleStates.terminal.unreadBells > 0 && <strong className="omo-bell-alert" data-testid="station-one-bell" role="status"> · Bell {this.consoleStates.terminal.unreadBells}</strong>}</button><button data-testid="station-two-controls" aria-pressed={this.activeMode === 'terminal-2'} onClick={()=>this.chooseStation('terminal-2')}>Desk two{this.consoleStates['terminal-2'].unreadBells > 0 && <strong className="omo-bell-alert" data-testid="station-two-bell" role="status"> · Bell {this.consoleStates['terminal-2'].unreadBells}</strong>}</button>{ROOM_KITS[this.room?.kit ?? 'hermes-desk'].webWall && <button data-testid="station-web-controls" aria-pressed={this.activeMode === 'web'} onClick={()=>this.chooseStation('web')}>Web wall</button>}<button data-testid="station-mirror-controls" onClick={()=>this.selectStation('mirror')}>Mirror · {this.stationLink.targetStationId === 'terminal' ? 'Desk one' : 'Desk two'}</button><button data-testid="station-recipe-toggle" aria-expanded={this.recipeOpen} onClick={()=>{this.recipeOpen=!this.recipeOpen;this.update();}}>Station recipes</button></nav>
                        {this.recipeOpen&&<StationRecipePanel recipes={this.recipes} stationId={this.activeStation} profile={this.consoleState.profile} onSave={this.saveStationRecipe} onApply={this.applyStationRecipe} onDelete={this.deleteStationRecipe} onClose={()=>{this.recipeOpen=false;this.update();}} locked={this.stationLocks[this.activeStation]} onLock={locked=>this.setStationLock(this.activeStation,locked)} idleSleep={this.consoleState.host?.idleSleep} onIdleSleep={(on,seconds)=>void this.console?.setIdleSleep(on,seconds)}/>}
                        {this.activeMode === 'web' ? <WebSurfaceStrip key={this.project?.toString()} state={this.webState} controller={this.web} initialUrl={this.savedWebUrl}/> : <><RuntimeConsoleStrip key={this.activeStation} state={this.consoleState} controller={this.console} onOpenLink={this.openTerminalLink} onReview={this.openTaskReview} onNewAgentTask={this.openAgentWorkflow}/>{this.taskWorkflowOpen&&taskSourceUri&&this.room&&<AgentWorkflowPanel projectUri={taskSourceUri} stationId={this.binding()?.stationId??''} stationLabel={this.activeStation==='terminal-2'?'Desk two':'Desk one'} authority={this.taskWorkspaceUiService as TaskWorkspaceAuthority} runtimeState={this.consoleState} runtimeController={this.console} onOpenWorkspace={this.openAgentWorkflowProject} onContinueDesk={this.continueAgentWorkflowDesk} onClose={this.closeAgentWorkflow}/>}</>}
                    </div>}
                    <SceneView key={`${theme}:${layout}:${this.configuring ? this.draftKit : this.room?.kit ?? 'hermes-desk'}:${this.presetRevision}`} theme={theme} layout={layout} kit={this.configuring ? this.draftKit : this.room?.kit ?? 'hermes-desk'} camera={(this.configuring ? this.draftCamera : undefined) ?? this.room?.camera ?? CAMERA} onSelect={this.selectStation} onTextSelect={this.chooseStation} onCamera={this.cameraChanged} walk={!this.configuring} terminalFrames={this.monitors} webFrame={this.webState.frame} onInstance={scene=>{this.worldScene=scene;scene?.setPeers(this.presenceState.snapshot?.members.filter(m=>m.id!==this.presenceState.snapshot?.selfId)??[]);scene?.setMirrorFrame(this.mirrorMonitor);if(this.codeReviewFrame)scene?.setCodeReview(this.codeReviewFrame);if(this.configuring&&this.onboardingWorld)(scene as unknown as {setWorld?:(w:WorldSpec)=>void}|undefined)?.setWorld?.(this.onboardingWorld);/* w2:onboard */}} onInput={this.terminalInput} onPaste={this.pasteInput} onScroll={this.worldScroll} onWebScroll={this.webScroll} onShortcut={this.monitorShortcut} onOpenLink={this.openTerminalLink} onPose={this.poseChanged} onMessage={text=>{this.feedback=text;this.update();}}>
                        {/* omo immersive lane (mount hook) */}{this.room && !this.configuring && (this.immersive.mode.active
                            ? <ImmersivePill roomName={this.room.projectName} activeDesk={this.activeMode} focus={this.focusMode} hud={this.hudHub} voice={this.voiceHub}
                                bells={{ terminal: this.consoleStates.terminal.unreadBells, 'terminal-2': this.consoleStates['terminal-2'].unreadBells }} onExit={this.leaveImmersive}/>
                            : <button type="button" className="omo-immersive-launch" data-testid="immersive-launch" title="Immersive world (G)" onMouseDown={event => event.preventDefault()} onClick={this.toggleImmersiveButton}>
                                <Icon name="expand" size={14} />Immersive world <kbd>G</kbd></button>)}
                    </SceneView>
                    {/* omo parity2 lane (mount hook) */}{this.room && !this.configuring && this.hudHub && <HudOverlay hub={this.hudHub} view={this.hudHub.state} chat={this.hudHub.chat.state}/>}
                    {/* omo focus lane (mount hook) */}{this.room && !this.configuring && <FocusOverlay focus={this.focusMode} frames={this.monitors} desk={station => ({ state: this.consoleStates[station], controller: this.consoles.get(station) })}/>}
                    {/* omo keys6 lane (mount hook) */}{this.room && !this.configuring && <ShortcutsLane focus={this.focusMode} activeDesk={() => this.activeMode} desk={station => ({ state: this.consoleStates[station], controller: this.consoles.get(station) })} reconnect={station => this.selectStation(station)}/>}
                    <pre className="omo-accessible-terminal" role="log" aria-label="Live in-world terminal" data-testid="in-world-terminal-output" data-ready={String(this.consoleState.phase === 'live')} data-phase={this.consoleState.phase}>{this.consoleState.lines.join('\n')}</pre>
                    {!this.configuring && <aside className="omo-tool-dock" aria-label="Project tools"><span>YOUR WORKSTATIONS</span><button disabled={this.busy} data-testid="terminal-action" onClick={() => this.selectStation('terminal')}><b>01</b><div><strong>Terminal</strong><small>A real shell. Your project folder.</small></div><span>↗</span></button><button disabled={this.busy} data-testid="code-action" onClick={() => this.selectStation('code')}><b>02</b><div><strong>Code</strong><small>Files, editing and your next change.</small></div><span>↗</span></button><p>Nothing starts unless you choose it.</p></aside>}
                    {this.configuring && <div className="omo-preview-badge"><i/> LIVE ROOM PREVIEW</div>}
                </section>
            </div>
            <footer className="omo-footer"><span>◈ &nbsp; {this.configuring ? 'A workspace with a sense of place.' : this.project?.path.toString()}</span><span role={this.error ? 'alert' : 'status'} className={this.error ? 'omo-error' : ''}>{this.error || this.feedback || 'Built on Theia · Local first'}</span></footer>
        </main>;
    }
}

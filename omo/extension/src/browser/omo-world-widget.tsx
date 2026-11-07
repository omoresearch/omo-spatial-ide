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
import { exportWorldPreset, exportStationSetupPreset, parseAnyRoomPreset, stationConfigFromSetup, WORLD_PRESET_FILENAME, WORLD_PRESET_MAX_BYTES } from '../common/world-preset'; // w2:templates
import { validateWorld, worldFromRoomV1, worldStorageKey } from '../common/world-model'; // w2:templates
import type { WorldOp, WorldSpec } from '../common/world-model'; // w2:templates; t2:regress WorldOp
import { WorldPresetPanel } from './world-preset-panel'; // w2:templates
import { ROOM_LAYOUTS, ROOM_KITS } from '../common/player-state';
import type { RoomLayoutId, RoomKitId, PlayerPose } from '../common/player-state';
import { OmoRuntimeService } from '../common/runtime-protocol';
import type { RuntimeFrame } from '../common/runtime-protocol';
import { RuntimeConsoleController, RuntimeConsoleState, StationBinding } from './runtime-console-controller';
import { WorldStations, StationInfo, WORLD_CHANGED_EVENT, loadWorld, linkedEntities, saveWorldOps } from './world-stations'; // w2:runtime
import type { WorldChangedDetail } from './world-stations'; // w2:runtime
import { RuntimeConsoleStrip } from './runtime-console-strip';
import { OmoWebService, WebSurfaceFrame } from '../common/web-runtime-protocol';
import { WebSurfaceController, WebWallState } from './web-surface-controller';
import { WebSurfaceStrip } from './web-surface-strip';
import { normalizeWebUrl } from '../common/web-url';
import { OmoPresenceService, PresenceJoin } from '../common/presence-protocol';
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
import { readStationRecipes, writeStationRecipes, makeStationRecipe, readStationLocks, writeStationLocks, recipesForStation } from './station-recipe';
import type { StationLocks } from './station-recipe';
import type { StationRecipe } from './station-recipe';
import { StationRecipePanel } from './station-recipe-panel';
import { defaultStationLink, readStationLink, writeStationLink, webWallDistance } from './station-link';
import type { StationLink } from './station-link';
// --- omo voice lane (mount hook): room voice, talk-to-agent dictation, agent avatars ---
import { VoiceHub } from './voice-hub';
import { RemoteRoomController, RoutedPresenceService } from './remote-room-controller'; // w2:mp-client
import { RemoteRoomChip, RemoteRoomPanel, RemoteRoomPopover } from './remote-room-panel'; // w2:mp-client
import { OmoRemoteRoomService } from '../common/remote-room-protocol'; // w2:mp-client
import { VoicePanel } from './voice-panel';
import { OmoVoiceSettingsService } from '../common/voice-settings-protocol'; // w2:voice
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
// w2:admin (mount hook) — in-world World admin console
import { AdminController, AdminState, LocalAdminWorldStore, ADMIN_TOGGLE_EVENT, bindAdminKeys } from './admin-controller';
import type { AdminWorldStore } from './admin-controller';
import { AdminPanel, AdminButton } from './admin-panel';
import { WorldAdminService } from '../common/world-admin-protocol';
import { sceneControls as adminSceneControls } from './focus-screen';
// end w2:admin
import { AgentSignalsService } from '../common/agent-signals-protocol'; // w2:agents
import { AgentsPanel } from './agents-panel'; // w2:agents
import { AgentSignalPoller } from './agent-signal-poller'; // w2:agents
import type { DeskId } from './agent-avatars'; // w2:integrate
// --- end omo focus lane ---
import { WorldStore } from './world-store'; // w2:build
import { BuildMode } from './build-mode'; // w2:build
import { BuildPanel, BuildToggle } from './build-panel'; // w2:build
// --- w2:onboard (mount hook): prompt-to-world onboarding; see onboarding-flow.tsx ---
import { OnboardingFlow } from './onboarding-flow';
import { OnboardingPlanBackend } from './onboarding-admin';
import { OnboardingWorldSink, saveOnboardingWorld, readLocalWorld } from './onboarding-store';
import { v1RoomFor } from './onboarding-planner';
// --- end w2:onboard ---

export const TERMINAL_STATION_ID = 'terminal-1';
// w2:runtime — stations come from the WorldSpec (WorldStations). Ids are strings; the scene/focus types keep
// their legacy unions for merge compatibility, so station ids are cast where they cross into them.
const asDesk = (id: string): TerminalWorkstation => id as TerminalWorkstation;

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
    // --- w2:admin (mount hook) ---
    @inject(WorldAdminService) protected readonly worldAdminService!: WorldAdminService;
    private admin?: AdminController;
    private adminState?: AdminState;
    private adminLocalStore?: LocalAdminWorldStore;
    /** STUB until the build lane's WorldStore is mounted here: replace with that store. */
    private adminStore = (): AdminWorldStore | undefined => {
        // w2:integrate — the admin plans against the SAME WorldStore build mode uses (one pending proposal, one undo stack).
        const shared = this.currentWorldStore();
        if (shared) return { get world() { return shared.world; },
            propose: proposal => { shared.propose({ ...proposal }); },
            apply: () => shared.apply(),
            discard: () => shared.discard(),
            subscribe: listener => shared.onChange(() => listener()) };
        if (!this.project || !this.room || this.configuring) return undefined;
        const uri = this.project.toString();
        if (!this.adminLocalStore || this.adminLocalStore.projectUri !== uri) this.adminLocalStore = new LocalAdminWorldStore(safeStorage(), uri, this.room);
        else this.adminLocalStore.syncRoom(this.room);
        return this.adminLocalStore;
    };
    // --- end w2:admin ---
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
    @inject(OmoRemoteRoomService) protected readonly remoteRoomService!: OmoRemoteRoomService; // w2:mp-client
    @inject(RoutedPresenceService) protected readonly presenceRouter!: RoutedPresenceService; // w2:mp-client
    /** w2:mp-client: remote room lifecycle; `remoteRoom.world` is the WorldSource for the WorldStore while connected. */
    remoteRoom?: RemoteRoomController;
    private remotePanelOpen = false; // w2:mp-client
    private remoteAnchor: HTMLElement | null = null; // w2:mp-client
    @inject(OmoVoiceSettingsService) protected readonly voiceSettings!: OmoVoiceSettingsService; // w2:voice
    @inject(AgentSignalsService) protected readonly agentSignals!: AgentSignalsService; // w2:agents
    private agentsOpen = false; // w2:agents
    private agentSignalPoller?: AgentSignalPoller; // w2:agents
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
    private draftWorld?: WorldSpec; // w2:templates — previewed world (template, kit or imported v2 preset); Save applies it
    private draftWorldSource?: string; // w2:templates
    private configuring = true;
    private error = '';
    private feedback = '';
    private busy = false;
    private initialized = false;
    private console?: RuntimeConsoleController;
    private consoleState: RuntimeConsoleState = RuntimeConsoleController.initial();
    // w2:runtime — one lazily created controller per world station (was a fixed two-desk map).
    private stations!: WorldStations;
    private activeStation: string = 'terminal';
    private activeMode: Workstation | string = 'terminal';
    private monitors: Record<string, MonitorFrame> = { terminal: { lines: [] }, 'terminal-2': { lines: [] } };
    private get stationList(): readonly StationInfo[] { return this.stations?.stations() ?? []; }
    private stationName(id: string): string { return this.stations?.name(id) ?? id; }
    private deskState(id: string): RuntimeConsoleState { return this.stations?.state(id) ?? RuntimeConsoleController.initial(); }
    /** Last state per station (kept for consoleChanged's frame diff; same shape as the two-desk record). */
    private consoleStates: Record<string, RuntimeConsoleState> = {};
    /** Existing controllers by station id (read only; WorldStations creates them). */
    private get consoles(): { get(id: string): RuntimeConsoleController | undefined } { return { get: id => this.stations?.peek(id) }; }
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
    private get anyStationLocked(): boolean { return this.stationList.some(s => this.stations.locked(s.id)); } // w2:runtime
    private pushStationLocks(): void { this.stations?.pushLocks(); } // w2:runtime
    private setStationLock = (station: string, locked: boolean): void => {
        if (!this.project) return;
        if (!locked && this.stations.configLocked(station)) { this.feedback = `${this.stationName(station)} is locked in Station Setup. Unlock it in build mode.`; this.update(); return; } // w2:runtime
        const next = { ...this.stationLocks, [station]: locked };
        if (!writeStationLocks(safeStorage(), this.project.toString(), next)) { this.error = 'The lock could not be saved: browser storage is unavailable.'; this.update(); return; }
        this.stationLocks = next; this.pushStationLocks();
        this.feedback = locked ? `${this.stationName(station)} is locked. Nothing running was stopped.` : `${this.stationName(station)} is unlocked.`; this.update();
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
    private focusMode = new FocusMode({ scene: () => this.worldScene, activeStation: () => this.activeMode as Workstation,
        select: station => this.selectStation(station), message: text => { this.feedback = text; this.update(); },
        stations: () => this.stationList }); // w2:runtime
    // --- end omo focus lane ---
    // --- w2:build — per-project WorldStore + in-world build mode. Changes only go through store proposals; starts nothing. ---
    private worldStore?: WorldStore;
    private buildMode = new BuildMode({ scene: () => this.worldScene, store: () => this.currentWorldStore(),
        profiles: () => [...new Set(Object.values(this.consoleStates).flatMap(state => state?.host?.profiles ?? []))], // t2:worldui — any desk's host status; no opened desk = no crash
        loadProfiles: async () => (await this.runtime.status()).profiles, // read-only host status
        message: text => { this.feedback = text; this.update(); } });
    private currentWorldStore(): WorldStore | undefined {
        if (!this.project || !this.room || this.configuring) return undefined;
        const uri = this.project.toString();
        if (this.worldStore?.projectUri !== uri) {
            this.worldStore = new WorldStore({ storage: safeStorage(), projectUri: uri, roomV1: this.room });
            // w2:integrate — one world for build mode, admin, stations and the 3D room: broadcast every saved change.
            const store = this.worldStore;
            store.onChange(change => {
                if (['apply', 'undo', 'redo', 'external'].includes(change.reason)) { try { window.dispatchEvent(new CustomEvent(WORLD_CHANGED_EVENT, { detail: { projectUri: uri, world: change.world } })); } catch { /* no window */ } } });
        }
        this.worldStore.attachRemote(this.remoteRoom?.world); // t3:mp2: the shared room world replaces local storage while connected
        return this.worldStore;
    }
    // --- end w2:build ---

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
        this.voiceHub=new VoiceHub({presenceService:this.presenceService,voiceSettings:this.voiceSettings/* w2:voice */,presence:()=>this.presenceState,scene:()=>this.worldScene,layout:()=>this.room?.layout??'classic',
            desk:desk=>({state:this.deskState(desk),controller:this.stations?.peek(desk)}),activeDesk:()=>asDesk(this.activeStation),signals:key=>this.agentSignalPoller?.get(key)??[]/* t2:agents */,
            onChange:()=>this.update(),message:text=>{this.feedback=text;this.update();}});
        this.toDispose.push({dispose:()=>{this.voiceHub?.dispose();this.voiceHub=undefined;}});
        // --- end omo voice lane ---
        this.toDispose.push({ dispose: () => this.focusMode.dispose() }); // omo focus lane
        this.toDispose.push({ dispose: () => this.buildMode.dispose() }); // w2:build
        { const offBuild = this.buildMode.subscribe(() => this.update()); this.toDispose.push({ dispose: offBuild }); } // w2:build
        // --- w2:admin (mount hook): the admin only plans; Apply goes through the world store. Starts nothing. ---
        this.admin = new AdminController({ service: this.worldAdminService, store: this.adminStore, storage: safeStorage(),
            onChange: state => { this.adminState = state; this.update(); }, message: text => { this.feedback = text; this.update(); } });
        this.adminState = this.admin.state;
        const adminToggle = (): void => { if (this.room && !this.configuring) { this.worldScene?.releaseTyping(); this.admin?.toggle(); } };
        window.addEventListener(ADMIN_TOGGLE_EVENT, adminToggle);
        const offAdminKeys = bindAdminKeys(() => { const c = adminSceneControls(this.worldScene); return !!c?.enabled && document.activeElement === c.element && !c.typing && !c.cameraOwned; },
            target => target instanceof Node && this.node.contains(target));
        this.toDispose.push({ dispose: () => { window.removeEventListener(ADMIN_TOGGLE_EVENT, adminToggle); offAdminKeys(); this.admin?.dispose(); this.admin = undefined; } });
        // --- end w2:admin ---
        // --- omo immersive lane (mount hook): the room fills the window while a saved room shows. ---
        const offImmersive = this.immersive.mode.subscribe(() => this.update());
        this.toDispose.push({ dispose: () => { offImmersive(); this.immersive.mode.setEngaged(false); } });
        // --- end omo immersive lane ---
        // --- omo parity2 lane (mount hook): read-only getters; goToDesk is the same path as clicking the desk. Starts nothing. ---
        // w2:agents: real agent signals (read-only) feed the notifications hub; the screen hint stays the fallback.
        this.agentSignalPoller=new AgentSignalPoller({service:this.agentSignals,desks:()=>this.stationList.map(info=>({desk:info.id as DeskId,workspace:this.deskState(info.id).workspace})),
            schedule:(fn,ms)=>window.setTimeout(fn,ms),cancel:id=>window.clearTimeout(id as number)});
        this.toDispose.push({dispose:()=>{this.agentSignalPoller?.dispose();this.agentSignalPoller=undefined;}});
        this.hudHub=new HudHub({presenceService:this.presenceService,presence:()=>this.presenceState,scene:()=>this.worldScene,layout:()=>this.room?.layout??'classic',signals:key=>this.agentSignalPoller?.get(key)??[],signalsReady:()=>!!this.agentSignalPoller?.ready/* t2:agents */,
            desk:desk=>({state:this.deskState(desk),controller:this.stations?.peek(desk)}),activeDesk:()=>this.activeMode,agents:()=>this.voiceHub?.state.agents??[],
            voice:()=>this.voiceHub?.state.voice,goToDesk:desk=>{if(!this.stations.has(desk)){this.feedback='That desk is no longer in this world.';this.update();return;}this.chooseStation(desk);this.focusMode.sync();if(this.deskState(desk).phase==='live')this.focusMode.attachActive();else{this.feedback=`${this.stationName(desk)} is not connected. Click its monitor to reconnect. Nothing was started.`;this.update();}},onChange:()=>this.update()});
        this.toDispose.push({dispose:()=>{this.hudHub?.dispose();this.hudHub=undefined;}});
        // --- end omo parity2 lane ---
        // --- w2:mp-client (mount hook): remote rooms reuse the same presence path; terminals stay local. Starts nothing. ---
        this.remoteRoom=new RemoteRoomController(this.remoteRoomService,this.presenceRouter,{joinPresence:(roomId,name)=>this.joinPresence(roomId,name),leavePresence:()=>this.leavePresence(),
            presence:()=>this.presenceState,agents:()=>this.voiceHub?.state.agents??[],seedWorld:()=>this.room?worldFromRoomV1({theme:this.room.theme,projectName:this.room.projectName,layout:this.room.layout,kit:this.room.kit}):undefined,
            schedule:(fn,ms)=>window.setTimeout(fn,ms),cancel:id=>window.clearTimeout(id as number),onChange:()=>this.update(),
            voiceTransport:t=>{void this.voiceHub?.useTransport(t);}/* t3:mp2 */});
        this.currentWorldStore(); // t3:mp2: bind the store to the remote world source now
        this.toDispose.push({dispose:()=>{this.remoteRoom?.dispose();this.remoteRoom=undefined;}});
        // --- end w2:mp-client ---
        this.review=new GitReviewController(this.gitReviewService,state=>{
            this.reviewState=state;
            if(state.phase!=='idle'){
                this.codeReviewFrame={title:state.patch?.path??'PROJECT CHANGES',lines:state.patch?state.patch.patch.split('\n'):state.snapshot?state.snapshot.changes.map(c=>`${c.status} ${c.path}`):[state.error||'Reading project Git status…'],status:state.loadingPatch?'Reading patch…':state.snapshot?.truncated&&!state.patch?'Git list capped at 200 files':'Read-only snapshot'};
                this.worldScene?.setCodeReview(this.codeReviewFrame);
            }
            this.update();
        });
        this.toDispose.push({dispose:()=>{this.reviewRequest++;this.reviewOpen=false;this.taskOverviewOpen=false;this.taskWorkspacesOpen=false;this.taskWorkflowOpen=false;this.review?.close();}});
        // w2:runtime — WorldStations owns one controller per station id, created on first use.
        this.stations = new WorldStations({ service: this.runtime, storage: safeStorage(),
            schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: handle => window.clearTimeout(handle as number),
            onChange: (state, station) => this.consoleChanged(state, station), onMirrorFrame: (frame, station) => { this.mirrorMonitor = frame ? this.toMonitorFrame(frame, station) : undefined; if (!frame) this.mirrorAttached = false; this.worldScene?.setMirrorFrame(this.mirrorMonitor); }, onMirrorError: message => { this.feedback = message; this.update(); },
            localLock: station => this.stationLocks[station] === true, onStations: (_list, removed) => this.stationsChanged(removed) });
        this.console = this.stations.controller(this.activeStation);
        const onWorld = (event: Event): void => { const detail = (event as CustomEvent<WorldChangedDetail>).detail; if (detail?.projectUri && detail.projectUri === this.project?.toString()) this.readWorld(); };
        const onStorage = (event: StorageEvent): void => { if (this.project && event.key === worldStorageKey(this.project.toString())) this.readWorld(); };
        window.addEventListener(WORLD_CHANGED_EVENT, onWorld); window.addEventListener('storage', onStorage);
        this.toDispose.push({ dispose: () => { window.removeEventListener(WORLD_CHANGED_EVENT, onWorld); window.removeEventListener('storage', onStorage); } });
        this.web = new WebSurfaceController({ service: this.webRuntime, schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: handle => window.clearTimeout(handle as number), onChange: state => this.webChanged(state) });
        // Detach only: the runtime keeps every tab and process running.
        this.toDispose.push({ dispose: () => { this.stations.dispose(); this.console = undefined; void this.web?.dispose(); this.web = undefined; } });
        this.toDispose.push(this.workspace.onWorkspaceChanged(roots => this.projectChanged(roots[0]?.resource)));
        this.initialize().catch(error => { this.error = String(error); this.initialized = true; this.update(); });
    }
    // --- omo immersive lane: engaged only while this widget shows a saved room (never during setup). ---
    private syncImmersive(): void { this.immersive.mode.setEngaged(!this.isDisposed && this.isVisible && this.initialized && !!this.room && !this.configuring); }
    protected override onAfterShow(msg: Message): void { super.onAfterShow(msg); this.syncImmersive(); }
    protected override onAfterHide(msg: Message): void { super.onAfterHide(msg); this.syncImmersive(); }
    protected override onBeforeDetach(msg: Message): void { this.immersive.mode.setEngaged(false); super.onBeforeDetach(msg); }
    protected override onUpdateRequest(msg: Message): void { super.onUpdateRequest(msg); this.syncImmersive(); this.buildMode.sync(); /* w2:build */ }
    private toggleImmersiveButton = (): void => { this.worldScene?.releaseTyping(); this.immersive.toggleFromButton(); this.focusMode.controls?.element.focus({ preventScroll: true }); };
    private leaveImmersive = (): void => { this.immersive.leave(); this.focusMode.controls?.element.focus({ preventScroll: true }); };
    // --- end omo immersive lane ---
    private storageKey(): string { return `omo.room.v1:${this.project?.toString() ?? ''}`; }
    /**
     * w2:render (mount hook) — draw this project's saved v2 world (localStorage omo.world.v2:<projectUri>) when there
     * is one and the room is not being customised. No saved world = the scene's own v1 room. Read only.
     */
    private drawStoredWorld(scene: RoomScene | undefined): void {
        if (!scene || !this.project || this.configuring) return;
        if (this.worldStore?.remoteActive) { scene.setWorld(this.worldStore.world); return; } // t3:mp2
        let raw: string | null = null;
        try { raw = safeStorage()?.getItem(worldStorageKey(this.project.toString())) ?? null; } catch { return; }
        if (!raw) return;
        try { const result = validateWorld(JSON.parse(raw)); if (result.ok) scene.setWorld(result.world); else { this.feedback = `The saved world could not be drawn: ${result.error}`; } }
        catch { this.feedback = 'The saved world could not be read. Showing the classic room.'; }
    }
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
        this.readWorld(false); // w2:runtime
        this.initialized = true; this.update();
        // Reconnect a workspace this room already opened. Never starts anything new.
        if (this.room) this.stations.reconnectSaved(this.bindingContext());
    }
    // --- w2:runtime: world-driven stations ---
    private bindingContext(): { projectUri: string; roomName: string; personal?: PresenceJoin } | undefined {
        if (!this.project) return undefined;
        return { projectUri: this.project.toString(), roomName: this.room?.projectName ?? this.draftName ?? this.project.path.base, personal: this.personalRoom };
    }
    /** Read the saved WorldSpec (or migrate the v1 room). Removed stations are detached; tabs keep running. */
    private readWorld(reconnect = true): void {
        const shared = this.worldStore?.remoteActive ? this.worldStore.world : undefined; // t3:mp2: in a remote room the room's world is the world
        const { world, stored } = shared ? { world: shared, stored: true } : this.project ? loadWorld(safeStorage(), this.project.toString(), this.room) : { world: undefined, stored: false };
        if (stored && this.worldStore?.projectUri === this.project?.toString()) this.worldStore?.reloadExternal(); // t2:regress: same-tab saves (saveWorldOps) must refresh build mode's cached world
        const { added } = this.stations.setWorld(world, stored);
        this.syncMirrorLink();
        for (const info of this.stationList) if (!this.monitors[info.id]) this.monitors = { ...this.monitors, [info.id]: { lines: [] } };
        if (reconnect && this.room && added.length) this.stations.reconnectSaved(this.bindingContext());
        if (stored && world && !this.configuring) this.worldScene?.setWorld(world); // w2:integrate — keep the 3D room in sync with world changes
        this.pushLinkedFrames(); this.update();
    }
    private stationsChanged(removed: string[]): void {
        if (removed.length) {
            const monitors = { ...this.monitors }; for (const id of removed) delete monitors[id]; this.monitors = monitors;
            if (removed.includes(this.activeStation)) { const first = this.stationList[0]?.id; if (first) this.chooseStation(first); else { this.console = undefined; this.consoleState = RuntimeConsoleController.initial(); } }
            if (removed.includes(this.mirrorTarget)) { this.mirrorAttached = false; this.mirrorMonitor = undefined; this.worldScene?.setMirrorFrame(undefined); }
            for (const id of removed) delete this.consoleStates[id];
            this.feedback = `${removed.length === 1 ? 'A desk was' : `${removed.length} desks were`} removed from this world. Their tabs keep running on this computer.`;
        }
    }
    /** Station the classic mirror follows (kept in stationLink.targetStationId; see syncMirrorLink). */
    private get mirrorTarget(): string { return this.stationLink.targetStationId; }
    /** A saved world's mirror link wins over the browser Station Link; a missing target falls back to the first station. */
    private syncMirrorLink(): void {
        const linked = this.stations.stored ? linkedEntities(this.stations.spec).find(l => l.entity.id === 'mirror')?.station : undefined;
        const target = linked ?? this.stationLink.targetStationId;
        const next = this.stations.has(target) ? target : this.stationList[0]?.id ?? 'terminal';
        if (next !== this.stationLink.targetStationId) { this.stationLink = { ...this.stationLink, targetStationId: next }; this.stations.peek(this.mirrorTargetPrevious ?? '')?.detachMirror(); this.mirrorAttached = false; }
        this.mirrorTargetPrevious = next;
    }
    private mirrorTargetPrevious?: string;
    /**
     * Render-lane hooks (duck-typed so this merges before or after room-scene gains them):
     * setStationFrames(frames by station id) for every station monitor, setLinkedFrames(frames by entity id)
     * for monitor walls / extra mirrors whose link is a station.
     */
    private pushLinkedFrames(): void {
        const scene = this.worldScene as unknown as { setLinkedFrames?: (frames: Record<string, MonitorFrame>) => void; setStationFrames?: (frames: Record<string, MonitorFrame>) => void } | undefined;
        scene?.setStationFrames?.(this.monitors);
        scene?.setLinkedFrames?.(this.stations?.linkedFrames(this.monitors) ?? {});
    }
    // --- end w2:runtime ---
    private binding(station: string = this.activeStation): StationBinding | undefined {
        return this.stations.binding(station, this.bindingContext()); // w2:runtime (legacy ids keep 'terminal-1' / 'terminal-2')
    }
    private presenceChanged(state:PresenceState):void {
        const old=this.personalRoom;
        this.presenceState=state;
        // Leave/connection loss removes presence, NOT the participant's current terminal bindings.
        // w2:mp-client: a remote room keeps this person's own desks (their own backend), so no per-room desk scoping.
        if(state.phase==='joined'&&state.join&&this.presenceRouter.route!=='remote')this.personalRoom=state.join;
        this.worldScene?.setPeers(state.snapshot?.members.filter(m=>m.id!==state.snapshot?.selfId)??[]);
        if(this.personalRoom&&(old?.roomId!==this.personalRoom.roomId||old?.clientId!==this.personalRoom.clientId)){
            this.worldScene?.releaseTyping();
            this.stations.reconnectSaved(this.bindingContext()); // w2:runtime
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
        this.invalidatePresetRead(); this.draftCamera = undefined; this.presetStatus = ''; this.draftWorld = undefined; this.draftWorldSource = undefined; // w2:templates
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
        this.readWorld(false); // w2:runtime
        this.stations.forEach((controller, id) => { const binding = this.binding(id); if (binding) void controller.reconnect(binding); else controller.release(); });
        if (this.room) this.stations.reconnectSaved(this.bindingContext());
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
    private toMonitorFrame(frame: RuntimeFrame, station: string): MonitorFrame {
        const state = this.deskState(station);
        const tab = state.workspace?.tabs.find(candidate => candidate.id === state.activeTabId);
        return { lines: frame.lines, cells: frame.cells, foreground: frame.foreground, background: frame.background, truecolor: frame.truecolor, palette: frame.palette, cursor: frame.cursor,
            unreadBells: 0, title: state.workspace ? `${state.workspace.name} / ${tab?.name ?? 'Mirror'}` : 'Linked monitor', status: tab?.busy ? 'Process active' : tab?.state === 'interrupted' ? 'interrupted' : 'live' };
    }
    private consoleChanged(state: RuntimeConsoleState, station: string): void {
        const old = this.consoleStates[station] ?? RuntimeConsoleController.initial(); // w2:runtime: any station id
        const framed = state.lines !== old.lines || state.cursor !== old.cursor || state.truecolor !== old.truecolor || state.statusText !== old.statusText || state.workspace !== old.workspace || state.activeTabId !== old.activeTabId || state.unreadBells !== old.unreadBells;
        this.consoleStates[station] = state;
        if (this.stations?.stored && this.room) this.stations.maybeOfferSetup(station, state, this.project?.toString()); // w2:runtime: StationConfig tabs, confirm first
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
            this.pushLinkedFrames?.(); // w2:runtime
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
        // w2:templates — a previewed world is validated and stored next to the v1 room (no ids, tokens or paths in it).
        let world: WorldSpec | undefined;
        if (this.draftWorld) {
            if (this.draftWorldTouchesLockedDesk(this.draftWorld)) { this.error = 'A desk is locked, so this world was not saved. Unlock it in Station recipes first.'; this.update(); return; }
            const checked = validateWorld({ ...this.draftWorld, name: next.projectName, shell: { ...this.draftWorld.shell, theme: next.theme }, revision: (this.savedWorld()?.revision ?? 0) + 1 });
            if (!checked.ok) { this.error = checked.error; this.update(); return; }
            world = checked.world;
        }
        if (!this.save(next)) return;
        if (world) { try { localStorage.setItem(worldStorageKey(next.projectUri), JSON.stringify(world)); } catch { this.error = 'The world could not be saved. Check browser storage.'; } this.draftWorld = undefined; this.draftWorldSource = undefined; } // w2:templates
        const previous = this.room;
        this.room = next; this.configuring = false; this.feedback = world ? 'Room and world saved on this device. No agent was started.' : 'Room saved on this device.';
        if (!world && previous) this.syncSavedWorldToRoom(previous, next); // t2:regress
        this.update();
    };
    /**
     * t2:regress — the classic form edits theme/layout of the v1 room. When a v2 world is saved for this project it is what
     * the 3D room draws, so carry the same change into it (move the two v1 desks, set the shell theme). Starts nothing.
     */
    private syncSavedWorldToRoom(previous: RoomState, next: RoomState): void {
        if (!this.project) return;
        const saved = loadWorld(safeStorage(), this.project.toString(), next);
        if (!saved.stored || !saved.world) return;
        const ops: WorldOp[] = [];
        if (saved.world.shell.theme !== next.theme) ops.push({ op: 'shell', shell: { theme: next.theme } });
        if ((previous.layout ?? 'classic') !== (next.layout ?? 'classic')) {
            const desks = ROOM_LAYOUTS[next.layout ?? 'classic'].desks;
            for (const id of ['terminal', 'terminal-2'] as const) {
                const e = saved.world.entities.find(item => item.id === id && item.kind === 'station');
                if (e) ops.push({ op: 'move', id, transform: { ...e.transform, x: desks[id].x, z: desks[id].z } });
            }
        }
        if (!ops.length) return;
        const result = saveWorldOps(safeStorage(), this.project.toString(), saved.world, ops);
        if (!result.ok) this.error = `The room was saved, but the world could not follow it: ${result.error}`;
    }
    private cameraChanged = (camera: RoomState['camera']): void => {
        if (this.configuring) { this.draftCamera = { ...camera }; return; }
        if (!this.room) return;
        const next = { ...this.room, camera };
        if (this.save(next)) this.room = next;
    };
    private chooseStation = (station: string): void => {
        if (station !== 'web' && !this.stations.has(station)) return; // w2:runtime: any world station id
        this.worldScene?.releaseTyping(); this.activeMode = station;
        if (station !== 'web') { this.activeStation = station; this.console = this.stations.controller(station); this.consoleState = this.deskState(station); }
        this.update();
    };
    private saveStationRecipe = (input: Omit<StationRecipe, 'version' | 'id'>): void => {
        if (!this.project) return;
        if (this.stations.locked(input.stationId)) { this.error = 'This desk is locked, so the recipe was not saved.'; this.update(); return; }
        try {
            const recipe = makeStationRecipe(input);
            const next = [...this.recipes.filter(existing => existing.id !== recipe.id), recipe];
            if (!writeStationRecipes(safeStorage(), this.project.toString(), next)) throw new Error('The recipe is too large or storage is unavailable.');
            this.recipes = next; this.feedback = 'Recipe saved. Saving did not launch a tab.'; this.update();
        } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.update(); }
    };
    private deleteStationRecipe = (recipe: StationRecipe): void => { if (!this.project || this.stations.locked(recipe.stationId)) return; const next = this.recipes.filter(item => item.id !== recipe.id); if (writeStationRecipes(safeStorage(), this.project.toString(), next)) { this.recipes = next; this.update(); } };
    private applyStationRecipe = (recipe: StationRecipe): void => {
        if (!this.stations.has(recipe.stationId)) { this.error = 'That recipe belongs to a desk that is not in this world.'; this.update(); return; } // w2:runtime
        this.chooseStation(recipe.stationId); this.stations.controller(recipe.stationId)?.requestRecipeApply(recipe, { setup: recipe.id === `setup-${recipe.stationId}` }); this.recipeOpen = false; this.update();
    };
    private linkMirror = (targetStationId: string): void => {
        if (!this.project || !this.stations.has(targetStationId)) return;
        const previous = this.stationLink.targetStationId;
        const next: StationLink = { version: 1, mirrorId: 'monitor-mirror', targetStationId };
        // w2:runtime — a saved world keeps the link in the WorldSpec (WorldOp 'link'); the v1 room keeps the browser Station Link.
        const saved = this.stations.stored && this.stations.spec?.entities.some(e => e.id === 'mirror') ? saveWorldOps(safeStorage(), this.project.toString(), this.stations.spec, [{ op: 'link', id: 'mirror', to: targetStationId }]) : undefined;
        if (saved && !saved.ok) { this.error = `The mirror link could not be saved: ${saved.error}`; this.update(); return; }
        if (!saved && !writeStationLink(safeStorage(), this.project.toString(), next)) { this.error = 'The mirror link could not be saved.'; this.update(); return; }
        if (previous !== targetStationId) this.stations.peek(previous)?.detachMirror();
        if (saved?.ok && this.stations.spec?.revision !== saved.world.revision) this.stations.setWorld(saved.world, true);
        this.stationLink = next; this.mirrorTargetPrevious = targetStationId; this.mirrorAttached = false; void this.stations.controller(targetStationId)?.attachMirror(this.binding(targetStationId)?.stationId); this.feedback = `Mirror linked to ${this.stationName(targetStationId)}.`; this.update();
    };
    private monitorShortcut = (shortcut: 'new-shell' | 'select-tab-2' | 'workspace-picker'): void => {
        if (shortcut === 'new-shell') void this.console?.requestNewTab('shell');
        else if (shortcut === 'select-tab-2') { const tab = this.consoleState.workspace?.tabs[1]; if (tab) void this.console?.selectTab(tab.id); else { this.feedback = 'There is no second tab on this desk yet.'; this.update(); } }
        else { this.console?.refreshBoard(); this.feedback = 'Workspace picker opened in Manage. No shell input was sent.'; this.update(); }
    };
    private poseChanged = (pose: PlayerPose): void => { void this.web?.setDistance(webWallDistance(pose)); };

    private selectStation = (station: Workstation | string, point?: ScreenPoint): void => {
        if (this.buildMode.ownsClicks) return; // w2:build — a click while building selects/places, never opens a workstation
        if (this.configuring) { this.feedback = 'Create your room first, then select a workstation.'; this.update(); return; }
        if (station === 'code') { void this.runAction(() => this.openCode()); return; }
        // w2:runtime — a clicked monitor wall / extra mirror with link=stationId goes to that station.
        const linked = station !== 'mirror' && !this.stations.has(station) ? this.stations.linkOf(station) : undefined;
        if (linked) { this.selectStation(linked, undefined); return; }
        if (station === 'mirror') {
            const target = this.mirrorTarget;
            this.chooseStation(target);
            const controller = this.stations.controller(target);
            void controller?.attachMirror(this.binding(target)?.stationId).then(ok => { this.feedback = ok ? `Mirror follows ${this.stationName(target)} · same station, independent view size.` : 'Mirror is not attached yet. Open the linked desk first.'; this.update(); });
            return;
        }
        if (station !== 'web' && !this.stations.has(station)) { this.feedback = 'That desk is not part of this world.'; this.update(); return; }
        this.chooseStation(station);
        if (station === 'web') {
            if (point && this.webState.surface) void this.web?.click(point);
            else if (!this.webState.surface && this.savedWebUrl) void this.web?.open(this.savedWebUrl);
            else { this.feedback = 'Open a web address above. Then click the physical wall to use the page.'; this.update(); }
            return;
        }
        // Each physical computer owns a separate controller; switching desks cannot route keys to a previous desk.
        void this.openTerminal(station as string).catch(error => { if (this.activeMode === station) { this.error = String(error); this.update(); } });
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
    private async openTerminal(station: string): Promise<void> {
        const binding = this.binding(station);
        if (!binding) throw new Error('Choose a project folder first.');
        const controller = this.stations.controller(station); await controller?.bind(binding);
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
        const station=this.stations.stationForRuntimeId(stationId,this.bindingContext()); // w2:runtime
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
    // w2:templates — the saved v2 world for this project, or the v1 room migrated (never written here).
    private savedWorld(): WorldSpec | undefined {
        if (!this.project) return undefined;
        try { const raw = safeStorage()?.getItem(worldStorageKey(this.project.toString())); if (raw) { const checked = validateWorld(JSON.parse(raw)); if (checked.ok) return checked.world; } } catch { /* fall back to the v1 room */ }
        return this.room ? worldFromRoomV1(this.room) : undefined;
    }
    // w2:templates — a locked desk must be identical in the preview (same place, same setup) before Save.
    private draftWorldTouchesLockedDesk(draft: WorldSpec): boolean {
        const saved = this.savedWorld();
        return this.stationList.map(info => info.id).some(id => this.stations.locked(id) && JSON.stringify(saved?.entities.find(e => e.id === id)) !== JSON.stringify(draft.entities.find(e => e.id === id)));
    }
    private previewWorld = (world: WorldSpec, source: string): void => { // w2:templates
        if (!this.configuring) return;
        this.draftWorld = world; this.draftWorldSource = source; this.draftTheme = world.shell.theme; this.error = '';
        this.presetRevision++; this.presetStatus = `${source} loaded into preview. Save room to apply it to this project.`; this.update();
    };
    private discardWorldPreview = (): void => { this.draftWorld = undefined; this.draftWorldSource = undefined; this.draftTheme = this.room?.theme ?? this.draftTheme; this.presetRevision++; this.presetStatus = 'World preview discarded.'; this.update(); }; // w2:templates
    private exportWorld = (): void => this.downloadWorld(world => exportWorldPreset(world, { camera: this.room?.camera })); // w2:templates
    private exportStationSetup = (setup: { name: string; profile: string; tabs: StationRecipe['tabs']; locked: boolean }): void => // w2:templates
        this.downloadWorld(world => exportStationSetupPreset(world, this.activeStation, stationConfigFromSetup(setup), { camera: this.room?.camera }));
    private downloadWorld(build: (world: WorldSpec) => string): void { // w2:templates
        const world = this.savedWorld(); if (!world) { this.error = 'Save a room first, then export it.'; this.update(); return; }
        try {
            const contents = build(world);
            const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = WORLD_PRESET_FILENAME;
            document.body.appendChild(link);
            try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60000); }
            this.error = ''; this.presetStatus = 'World exported (v2). Workspace ids, tokens, project names and paths are not included.'; this.update();
        } catch (error) { this.error = error instanceof Error ? error.message : 'This world could not be exported.'; this.update(); }
    }
    private importPreset = async (file: File): Promise<void> => {
        if (!this.project || !this.configuring) return;
        const epoch = ++this.presetReadEpoch;
        const project = this.project.toString();
        const ownsPreview = (): boolean => epoch === this.presetReadEpoch && this.configuring && project === this.project?.toString();
        this.presetLoading = true; this.presetStatus = ''; this.error = '';
        // w2:templates — v1 keeps its 8 KiB refuse-before-read rule. A larger file is allowed (up to the
        // v2 cap) only when a 512-byte header sniff shows it is an Omo world preset.
        const sniffWorld = async (): Promise<boolean> => { try { return /"format"\s*:\s*"omo-world-preset"/.test(await file.slice(0, 512).text()); } catch { return false; } };
        if (file.size > WORLD_PRESET_MAX_BYTES || (file.size > ROOM_PRESET_MAX_BYTES && !(await sniffWorld()))) {
            if (!ownsPreview()) return;
            this.presetLoading = false;
            this.error = file.size > WORLD_PRESET_MAX_BYTES ? `World preset files must be at most ${Math.round(WORLD_PRESET_MAX_BYTES / 1024)} KiB.` : 'Room preset files must be at most 8 KiB (8192 bytes).';
            this.update(); return;
        }
        if (!ownsPreview()) return;
        this.update();
        let raw: string;
        try { raw = await file.text(); }
        catch {
            if (ownsPreview()) { this.presetLoading = false; this.error = 'The room preset file could not be read.'; this.update(); }
            return;
        }
        if (!ownsPreview()) return;
        try {
            const any = parseAnyRoomPreset(raw); // w2:templates — v1 appearance or v2 world
            if (any.version === 2) { if (any.preset.camera) this.draftCamera = { ...any.preset.camera }; this.presetLoading = false; this.previewWorld(any.preset.world, 'Imported world'); return; }
            const preset = any.preset;
            this.draftTheme = preset.theme; this.draftLayout = preset.layout; this.draftCamera = { ...preset.camera };
            this.presetRevision++; this.presetStatus = 'Appearance loaded into preview. Save room to apply it to this project.';
        } catch (error) { this.error = /"format"\s*:\s*"omo-world-preset"/.test(raw) && error instanceof Error ? `That world preset was refused: ${error.message}` : 'That file is not a valid Omo appearance preset (8 KiB maximum).'; } // w2:templates
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
    private cancelConfiguration = (): void => { this.invalidatePresetRead(); this.draftWorld = undefined; this.draftWorldSource = undefined; /* w2:templates */ this.presetRevision++; this.presetStatus = ''; this.error = ''; this.configuring = false; this.update(); };
    private configure = (): void => { this.invalidatePresetRead(); this.draftWorld = undefined; this.draftWorldSource = undefined; /* w2:templates */ this.presetStatus = ''; this.error = ''; this.leavePresence();this.draftTheme = this.room?.theme ?? 'station'; this.draftLayout = this.room?.layout ?? 'classic'; this.draftKit = this.room?.kit ?? 'hermes-desk'; this.draftCamera = this.room ? { ...this.room.camera } : undefined; this.draftName = this.room?.projectName ?? this.draftName; this.configuring = true; this.feedback = ''; this.onboardingEpoch++; this.onboardingClassic = !!this.room; /* w2:onboard */ this.update(); };

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
                        <label className="omo-field">Import JSON (appearance 8 KiB, world 80 KiB){/* w2:templates */}<input type="file" accept=".json,application/json" data-testid="room-preset-import" aria-label="Import room appearance or world preset" disabled={this.presetLoading || this.busy} onChange={event => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ''; if (file) void this.importPreset(file); }}/></label>
                        <button type="button" data-testid="room-preset-export" disabled={!this.room || this.presetLoading || this.busy} onClick={this.exportPreset}>Export saved room</button>
                        <p>Appearance presets hold looks only. World presets (v2) add desks, walls and station setup, but never workspace ids, tokens, project names or paths. Import previews first; Save room applies it.</p>
                        {/* w2:templates */}<WorldPresetPanel saved={this.savedWorld()} draft={this.draftWorld} draftSource={this.draftWorldSource} disabled={this.presetLoading || this.busy || !this.project} locked={!!this.draftWorld && this.draftWorldTouchesLockedDesk(this.draftWorld)} onPreview={this.previewWorld} onDiscard={this.discardWorldPreview} onExport={this.room ? this.exportWorld : undefined} onError={message => { this.error = message; this.update(); }}/>
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
                        {/* w2:mp-client (mount hook) */}{this.remoteRoom&&<div className="omo-remote-anchor" ref={el=>{this.remoteAnchor=el;}}><RemoteRoomChip view={this.remoteRoom.state} open={this.remotePanelOpen} onToggle={()=>{this.remotePanelOpen=!this.remotePanelOpen;this.update();}}/>
                            {this.remotePanelOpen&&<RemoteRoomPopover anchor={this.remoteAnchor}><RemoteRoomPanel controller={this.remoteRoom} view={this.remoteRoom.state} onClose={()=>{this.remotePanelOpen=false;this.update();}}/></RemoteRoomPopover>}</div>}
                        {/* omo voice lane (mount hook) */}{this.voiceHub&&<VoicePanel hub={this.voiceHub} view={this.voiceHub.state}/>}
                        {/* w2:runtime — desk switcher lists every station in the world (Ctrl+1..9 while attached). Legacy test ids kept for desks one and two. */}
                        <nav className="omo-station-switch" aria-label="Physical workstations">{this.stationList.map(info => { const bells = this.deskState(info.id).unreadBells; const legacy = info.id === 'terminal' ? 'one' : info.id === 'terminal-2' ? 'two' : undefined; return <button key={info.id} data-testid={legacy ? `station-${legacy}-controls` : `station-controls-${info.id}`} data-station={info.id} aria-pressed={this.activeMode === info.id} title={info.slot <= 9 ? `${info.name} (Ctrl+${info.slot} while attached)` : info.name} onClick={()=>this.chooseStation(info.id)}>{this.stations.locked(info.id) ? '🔒 ' : ''}{info.name}{bells > 0 && <strong className="omo-bell-alert" data-testid={legacy ? `station-${legacy}-bell` : `station-bell-${info.id}`} role="status"> · Bell {bells}</strong>}</button>; })}{ROOM_KITS[this.room?.kit ?? 'hermes-desk'].webWall && <button data-testid="station-web-controls" aria-pressed={this.activeMode === 'web'} onClick={()=>this.chooseStation('web')}>Web wall</button>}<button data-testid="station-mirror-controls" onClick={()=>this.selectStation('mirror')}>Mirror · {this.stationName(this.mirrorTarget)}</button>{this.stationList.length > 1 && <select data-testid="station-mirror-link" aria-label="Mirror follows" value={this.mirrorTarget} onChange={event => this.linkMirror(event.target.value)}>{this.stationList.map(info => <option key={info.id} value={info.id}>{info.name}</option>)}</select>}<button data-testid="station-recipe-toggle" aria-expanded={this.recipeOpen} onClick={()=>{this.recipeOpen=!this.recipeOpen;this.update();}}>Station recipes</button>{/* w2:agents */}<button data-testid="agents-toggle" aria-expanded={this.agentsOpen} onClick={()=>{this.agentsOpen=!this.agentsOpen;this.update();}}>Agents</button></nav>
                        {/* w2:agents (mount hook) */}{this.agentsOpen&&<AgentsPanel signals={this.agentSignals} runtime={this.runtime} desk={this.consoleState} projectUri={this.project?.toString()} onOpenWeb={this.openTerminalLink} onClose={()=>{this.agentsOpen=false;this.update();}}/>}
                        {this.recipeOpen&&<StationRecipePanel key={this.activeStation} recipes={recipesForStation(this.recipes,this.activeStation)} stationId={this.activeStation} stationName={this.stationName(this.activeStation)} setup={this.stations.setupRecipeFor(this.activeStation)} worldLocked={this.stations.configLocked(this.activeStation)} profile={this.consoleState.profile} onSave={this.saveStationRecipe} onApply={this.applyStationRecipe} onDelete={this.deleteStationRecipe} onClose={()=>{this.recipeOpen=false;this.update();}} locked={this.stations.locked(this.activeStation)} onLock={locked=>this.setStationLock(this.activeStation,locked)} idleSleep={this.consoleState.host?.idleSleep} onIdleSleep={(on,seconds)=>void this.console?.setIdleSleep(on,seconds)}/>}
                        {this.activeMode === 'web' ? <WebSurfaceStrip key={this.project?.toString()} state={this.webState} controller={this.web} initialUrl={this.savedWebUrl}/> : <><RuntimeConsoleStrip key={this.activeStation} state={this.consoleState} controller={this.console} onOpenLink={this.openTerminalLink} onReview={this.openTaskReview} onNewAgentTask={this.openAgentWorkflow}/>{this.taskWorkflowOpen&&taskSourceUri&&this.room&&<AgentWorkflowPanel projectUri={taskSourceUri} stationId={this.binding()?.stationId??''} stationLabel={this.stationName(this.activeStation)} authority={this.taskWorkspaceUiService as TaskWorkspaceAuthority} runtimeState={this.consoleState} runtimeController={this.console} onOpenWorkspace={this.openAgentWorkflowProject} onContinueDesk={this.continueAgentWorkflowDesk} onClose={this.closeAgentWorkflow}/>}</>}
                    </div>}
                    <SceneView key={`${theme}:${layout}:${this.configuring ? this.draftKit : this.room?.kit ?? 'hermes-desk'}:${this.presetRevision}`} theme={theme} layout={layout} kit={this.configuring ? this.draftKit : this.room?.kit ?? 'hermes-desk'} camera={(this.configuring ? this.draftCamera : undefined) ?? this.room?.camera ?? CAMERA} onSelect={this.selectStation} onTextSelect={this.chooseStation} onCamera={this.cameraChanged} walk={!this.configuring} terminalFrames={this.monitors} webFrame={this.webState.frame} onInstance={scene=>{this.worldScene=scene;this.drawStoredWorld(scene);/* w2:render */this.pushLinkedFrames();/* w2:runtime */scene?.setPeers(this.presenceState.snapshot?.members.filter(m=>m.id!==this.presenceState.snapshot?.selfId)??[]);scene?.setMirrorFrame(this.mirrorMonitor);if(this.codeReviewFrame)scene?.setCodeReview(this.codeReviewFrame);if(this.configuring&&!this.onboardingClassic&&this.onboardingWorld)scene?.setWorld(this.onboardingWorld);/* w2:onboard; t2:regress: not under the classic form */}} onInput={this.terminalInput} onPaste={this.pasteInput} onScroll={this.worldScroll} onWebScroll={this.webScroll} onShortcut={this.monitorShortcut} onOpenLink={this.openTerminalLink} onPose={this.poseChanged} onMessage={text=>{this.feedback=text;this.update();}}>
                        {/* omo immersive lane (mount hook) */}{this.room && !this.configuring && (this.immersive.mode.active
                            ? <ImmersivePill roomName={this.room.projectName} activeDesk={this.activeMode as Workstation} focus={this.focusMode} hud={this.hudHub} voice={this.voiceHub}
                                desks={this.stationList.map(info => ({ id: info.id, label: info.name, slot: info.slot }))}
                                bells={Object.fromEntries(this.stationList.map(info => [info.id, this.deskState(info.id).unreadBells]))} onExit={this.leaveImmersive}/>
                            : <><BuildToggle build={this.buildMode}/>{/* w2:build */}<button type="button" className="omo-immersive-launch" data-testid="immersive-launch" title="Immersive world (G)" onMouseDown={event => event.preventDefault()} onClick={this.toggleImmersiveButton}>
                                <Icon name="expand" size={14} />Immersive world <kbd>G</kbd></button></>)}
                        {/* w2:build (mount hook) */}{this.room && !this.configuring && <BuildPanel build={this.buildMode}/>}
                    </SceneView>
                    {/* w2:admin (mount hook) */}{this.room && !this.configuring && this.admin && this.adminState && <>
                        {!this.adminState.open && <AdminButton open={false} onClick={() => { this.worldScene?.releaseTyping(); this.admin?.toggle(true); }}/>}
                        <AdminPanel controller={this.admin} state={this.adminState} worldName={this.room.projectName} previewSupported={!!this.adminStore()?.preview}/></>}
                    {/* omo parity2 lane (mount hook) */}{this.room && !this.configuring && this.hudHub && <HudOverlay hub={this.hudHub} view={this.hudHub.state} chat={this.hudHub.chat.state}/>}
                    {/* omo focus lane (mount hook) */}{this.room && !this.configuring && <FocusOverlay focus={this.focusMode} frames={this.monitors} desk={station => ({ state: this.deskState(station), controller: this.stations.peek(station) })}/>}
                    {/* omo keys6 lane (mount hook) */}{this.room && !this.configuring && <ShortcutsLane focus={this.focusMode} activeDesk={() => this.activeMode as Workstation} desk={station => ({ state: this.deskState(station), controller: this.stations.peek(station) })} reconnect={station => this.selectStation(station)}/>}
                    <pre className="omo-accessible-terminal" role="log" aria-label="Live in-world terminal" data-testid="in-world-terminal-output" data-ready={String(this.consoleState.phase === 'live')} data-phase={this.consoleState.phase}>{this.consoleState.lines.join('\n')}</pre>
                    {!this.configuring && <aside className="omo-tool-dock" aria-label="Project tools"><span>YOUR WORKSTATIONS</span><button disabled={this.busy} data-testid="terminal-action" onClick={() => this.selectStation(this.stationList[0]?.id ?? 'terminal')}><b>01</b><div><strong>Terminal</strong><small>A real shell. Your project folder.</small></div><span>↗</span></button><button disabled={this.busy} data-testid="code-action" onClick={() => this.selectStation('code')}><b>02</b><div><strong>Code</strong><small>Files, editing and your next change.</small></div><span>↗</span></button><p>Nothing starts unless you choose it.</p></aside>}
                    {this.configuring && <div className="omo-preview-badge"><i/> LIVE ROOM PREVIEW</div>}
                </section>
            </div>
            <footer className="omo-footer"><span>◈ &nbsp; {this.configuring ? 'A workspace with a sense of place.' : this.project?.path.toString()}</span><span role={this.error ? 'alert' : 'status'} className={this.error ? 'omo-error' : ''}>{this.error || this.feedback || 'Built on Theia · Local first'}</span></footer>
        </main>;
    }
}

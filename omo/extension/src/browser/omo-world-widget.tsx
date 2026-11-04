import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';
import URI from '@theia/core/lib/common/uri';
import { RoomScene, Workstation, TerminalWorkstation, ScreenPoint, MonitorFrame } from './room-scene';
import { RoomState, RoomTheme, parseRoomState } from '../common/room-state';
import { OmoRuntimeService } from '../common/runtime-protocol';
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

export const TERMINAL_STATION_ID = 'terminal-1';
const TERMINAL_STATIONS: TerminalWorkstation[] = ['terminal', 'terminal-2'];

const CAMERA = { azimuth: 0.56, elevation: 0.61, distance: 24 };
const THEMES = {
    station: { title: 'Space station', eyebrow: 'ORBITAL / 01', description: 'A quiet observatory for your next big idea.', symbol: '◉' },
    jungle: { title: 'Prehistoric jungle', eyebrow: 'EXPEDITION / 02', description: 'A green retreat. Room to think, space to build.', symbol: '✳' }
};

function SceneView(props: { theme: RoomTheme; camera: RoomState['camera']; onSelect: (station: Workstation, point?: ScreenPoint) => void; onTextSelect: (station: TerminalWorkstation) => void; onCamera: (camera: RoomState['camera']) => void; walk: boolean; terminalFrames: Record<TerminalWorkstation, MonitorFrame>; webFrame?: WebSurfaceFrame; onInstance?: (scene: RoomScene | undefined) => void; onInput: (text: string) => void; onPaste: (text: string) => void; onScroll?: (delta: number) => void; onMessage: (text: string) => void }): React.ReactElement {
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
        const scene = new RoomScene(host.current, { theme: props.theme, camera: props.camera, walk: mode==='walk',
            onInput: text=>callbacks.current.onInput(text),onPaste:text=>callbacks.current.onPaste(text),onScroll:delta=>callbacks.current.onScroll?.(delta),onMessage:text=>callbacks.current.onMessage(text),
            onSelect: (action,point) => callbacks.current.onSelect(action,point), onCameraChange: camera => callbacks.current.onCamera(camera),
            onTextSelect: station => callbacks.current.onTextSelect(station),
            onReady: () => setReady(true), onError: message => setError(message) });
        instance.current = scene;scene.setTerminalFrames(callbacks.current.terminalFrames);if(callbacks.current.webFrame)scene.setWebFrame(callbacks.current.webFrame);callbacks.current.onInstance?.(scene);
        return () => { scene.dispose(); instance.current = undefined; callbacks.current.onInstance?.(undefined); };
    }, [props.theme]);
    return <div className={`omo-scene-wrap ${mode==='walk'?'omo-walking':''}`} data-theme={props.theme} data-navigation={mode}>
        <div ref={host} className="omo-scene" data-testid="omo-scene" data-ready={ready ? 'true' : 'false'} />
        {error && <div className="omo-render-error" role="alert"><strong>3D rendering could not start.</strong><p>{error}</p><p>The project terminal and editor are still available from the toolbar.</p></div>}
        {mode==='walk'&&<div className="omo-crosshair" aria-hidden="true">+</div>}
        {props.walk&&<div className="omo-navigation-switch"><button data-testid="walk-mode" aria-pressed={mode==='walk'} onClick={()=>setMode('walk')}>First person</button><button data-testid="overview-mode" aria-pressed={mode==='overview'} onClick={()=>setMode('overview')}>Overview</button></div>}

        <div className="omo-scene-controls"><span>{mode==='walk'?'WASD · Drag to look · Shift+drag text · Shift+double/triple-click word/line · Ctrl+Shift+C copy · Esc':'Drag to orbit · Scroll to zoom'}</span><button aria-label="Reset room camera" onClick={() => instance.current?.resetCamera()}>↺ Reset view</button></div>
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
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    private project?: URI;
    private room?: RoomState;
    private draftTheme: RoomTheme = 'station';
    private draftName = '';
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
    private web?: WebSurfaceController;
    private webState: WebWallState = { phase: 'idle', error: '' };
    private savedWebUrl = '';
    private worldScene?: RoomScene;
    private presence?: PresenceController;
    private presenceState:PresenceState={phase:'solo',error:''};
    private personalRoom?:PresenceJoin;
    private tabIdentity:string=crypto.randomUUID();

    @postConstruct()
    protected init(): void {
        this.id = OmoWorldWidget.ID; this.title.label = 'World'; this.title.caption = 'Omo · Your spatial workspace';
        this.title.closable = false; this.title.iconClass = 'codicon codicon-globe';
        this.addClass('omo-world-widget'); this.node.tabIndex = -1;
        try {const saved=sessionStorage.getItem('omo.presence.tab.v1');if(saved&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(saved))this.tabIdentity=saved;sessionStorage.setItem('omo.presence.tab.v1',this.tabIdentity);}catch{/* Memory-only identity; never guesses another tab's terminals. */}
        this.presence=new PresenceController({service:this.presenceService,pose:()=>this.worldScene?.getPlayerPose()??{...PLAYER_HOME},schedule:(fn,ms)=>window.setTimeout(fn,ms),cancel:id=>window.clearTimeout(id as number),onChange:state=>this.presenceChanged(state)});
        this.toDispose.push({dispose:()=>{void this.presence?.dispose().catch(()=>undefined);}});
        for (const station of TERMINAL_STATIONS) this.consoles.set(station, new RuntimeConsoleController({ service: this.runtime, storage: safeStorage(),
            schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: handle => window.clearTimeout(handle as number),
            onChange: state => this.consoleChanged(state, station) }));
        this.console = this.consoles.get(this.activeStation);
        this.web = new WebSurfaceController({ service: this.webRuntime, schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: handle => window.clearTimeout(handle as number), onChange: state => this.webChanged(state) });
        // Detach only: the runtime keeps every tab and process running.
        this.toDispose.push({ dispose: () => { this.consoles.forEach(controller => controller.dispose()); this.consoles.clear(); this.console = undefined; void this.web?.dispose(); this.web = undefined; } });
        this.toDispose.push(this.workspace.onWorkspaceChanged(roots => this.projectChanged(roots[0]?.resource)));
        this.initialize().catch(error => { this.error = String(error); this.initialized = true; this.update(); });
    }
    private storageKey(): string { return `omo.room.v1:${this.project?.toString() ?? ''}`; }
    private async initialize(): Promise<void> {
        const roots = await this.workspace.roots;
        this.project = roots[0]?.resource;
        this.readWebBinding();
        this.draftName = this.project?.path.base || 'My workspace';
        if (this.project) {
            try {
                const raw = localStorage.getItem(this.storageKey());
                this.room = parseRoomState(raw, this.project.toString());
                if (raw && !this.room) this.feedback = 'Saved room settings could not be read. Choose a theme to recreate this project’s room.';
                if (this.room) { this.draftTheme = this.room.theme; this.draftName = this.room.projectName; this.configuring = false; }
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
        void this.presence?.join({roomId,name,projectUri:this.project.toString(),theme:this.room.theme,clientId:this.tabIdentity}).catch(error=>{this.error=String(error);this.update();});
    };
    private leavePresence=():void=>{this.worldScene?.releaseTyping();void this.presence?.leave().catch(error=>{this.error=String(error);this.update();});};
    private projectChanged(next: URI | undefined): void {
        if (next?.toString() === this.project?.toString()) return;
        this.leavePresence();this.personalRoom=undefined;
        this.project = next;
        this.readWebBinding();
        this.room = undefined; this.configuring = true; this.draftName = next?.path.base || 'My workspace';
        if (next) {
            try {
                this.room = parseRoomState(localStorage.getItem(this.storageKey()), next.toString());
                if (this.room) { this.draftTheme = this.room.theme; this.draftName = this.room.projectName; this.configuring = false; }
            } catch { /* storage errors were reported at start-up */ }
        }
        void this.web?.close();
        for (const station of TERMINAL_STATIONS) { const binding = this.binding(station); if (binding) void this.consoles.get(station)?.reconnect(binding); else this.consoles.get(station)?.release(); }
        this.update();
    }
    private readWebBinding(): void {
        this.savedWebUrl = '';
        if (!this.project) return;
        try { const data = JSON.parse(localStorage.getItem(`omo.webwall.v1:${this.project}`) || 'null'); if (typeof data?.url === 'string' && /^https?:\/\//.test(data.url)) this.savedWebUrl = data.url; } catch { /* a bad local binding is not permission to browse */ }
    }
    private webChanged(state: WebWallState): void {
        this.webState = state;
        const url = state.surface?.url;
        if (this.project && url && /^https?:\/\//.test(url) && url !== this.savedWebUrl) {
            this.savedWebUrl = url;
            try { localStorage.setItem(`omo.webwall.v1:${this.project}`, JSON.stringify({ url })); } catch { this.feedback = 'The web address could not be saved on this device.'; }
        }
        this.update();
    }
    private consoleChanged(state: RuntimeConsoleState, station: TerminalWorkstation): void {
        const old = this.consoleStates[station];
        const framed = state.lines !== old.lines || state.cursor !== old.cursor || state.statusText !== old.statusText || state.workspace !== old.workspace || state.activeTabId !== old.activeTabId || state.unreadBells !== old.unreadBells;
        this.consoleStates[station] = state;
        if (station === this.activeStation) this.consoleState = state;
        if (framed) {
            const tab = state.workspace?.tabs.find(t => t.id === state.activeTabId);
            this.monitors = { ...this.monitors, [station]: { lines: state.lines, cells: state.cells, unreadBells: state.unreadBells, foreground: state.foreground, background: state.background, palette: state.palette, cursor: state.cursor,
                title: tab ? `${state.workspace?.name ?? 'OMO'} / ${tab.name}` : undefined, status: state.phase === 'live' && tab?.state === 'running' ? (tab.busy ? 'working' : 'live') : (tab && tab.state !== 'running' ? tab.state : state.statusText) } };
        }
        this.update();
    }
    private save(state: RoomState): boolean {
        try { localStorage.setItem(this.storageKey(), JSON.stringify(state)); this.error = ''; return true; }
        catch { this.error = 'Your room could not be saved. Check browser storage before continuing.'; this.update(); return false; }
    }
    private createRoom = (): void => {
        if (!this.project || !this.draftName.trim()) return;
        const next: RoomState = { version: 1, theme: this.draftTheme, projectUri: this.project.toString(),
            projectName: this.draftName.trim().slice(0, 120), camera: this.room?.camera ?? { ...CAMERA } };
        if (!this.save(next)) return;
        this.room = next; this.configuring = false; this.feedback = 'Room saved on this device.'; this.update();
    };
    private cameraChanged = (camera: RoomState['camera']): void => {
        if (!this.room || this.configuring) return;
        const next = { ...this.room, camera };
        if (this.save(next)) this.room = next;
    };
    private chooseStation = (station: TerminalWorkstation | 'web'): void => {
        this.worldScene?.releaseTyping(); this.activeMode = station;
        if (station !== 'web') { this.activeStation = station; this.console = this.consoles.get(station); this.consoleState = this.consoleStates[station]; }
        this.update();
    };
    private selectStation = (station: Workstation, point?: ScreenPoint): void => {
        if (this.configuring) { this.feedback = 'Create your room first, then select a workstation.'; this.update(); return; }
        if (station === 'code') { void this.runAction(() => this.openCode()); return; }
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
    private worldScroll = (deltaY: number): void => { if (this.activeMode === 'web') void this.web?.scroll(deltaY); else void this.console?.wheel(-Math.sign(deltaY) * 3); };
    /** Click on the physical monitor: open (or reconnect) this room's persistent workspace on the runtime. */
    private async openTerminal(station: TerminalWorkstation): Promise<void> {
        const binding = this.binding(station);
        if (!binding) throw new Error('Choose a project folder first.');
        const controller = this.consoles.get(station); await controller?.bind(binding);
        if (this.activeMode === station) { this.feedback = controller?.state.phase === 'live' ? 'Live terminal on this monitor · Type here. Esc to walk away.' : controller?.state.error || controller?.state.statusText || ''; this.update(); }
    }
    private async openCode(): Promise<void> {
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
    private configure = (): void => { this.leavePresence();this.draftTheme = this.room?.theme ?? 'station'; this.draftName = this.room?.projectName ?? this.draftName; this.configuring = true; this.feedback = ''; this.update(); };

    protected render(): React.ReactNode {
        if (!this.initialized) return <div className="omo-loading">Opening your workspace…</div>;
        const theme = this.configuring ? this.draftTheme : this.room!.theme;
        return <main className={`omo-root omo-${theme}`} data-testid="omo-world" data-configured={this.room ? 'true' : 'false'} data-active-station={this.activeMode}>
            <header className="omo-header">
                <div className="omo-brand"><span className="omo-brand-mark">o<span>m</span>o</span><span className="omo-brand-caption">RESEARCH<br/>SPATIAL IDE</span></div>
                <nav className="omo-view-switch" aria-label="Workspace views"><button className="active" aria-current="page">◈ World</button><button disabled={!this.room || this.busy} onClick={() => this.selectStation('code')}>⌘ Code</button></nav>
                <span className="omo-local"><i/> LOCAL WORKSPACE</span>
            </header>
            <div className={`omo-body ${this.configuring ? 'is-onboarding' : ''}`}>
                {this.configuring ? <section className="omo-onboarding" data-testid="omo-onboarding">
                    <span className="omo-kicker">YOUR WORK, SOMEWHERE YOU REMEMBER</span>
                    <h1>A place for<br/>your next idea.</h1>
                    <p className="omo-intro">Make this workspace feel like you.<br/>Your code and tools are already at home.</p>
                    <div className="omo-step-title"><span>01</span> Choose your world</div>
                    <div className="omo-theme-list">{(Object.keys(THEMES) as RoomTheme[]).map(key => <button key={key} data-testid={`theme-${key}`} className={`omo-theme-card ${theme === key ? 'selected' : ''}`} aria-pressed={theme === key} onClick={() => { this.draftTheme = key; this.update(); }}>
                        <span className="omo-theme-symbol">{THEMES[key].symbol}</span><span><strong>{THEMES[key].title}</strong><small>{THEMES[key].eyebrow}</small></span><span className="omo-radio"/>
                    </button>)}</div>
                    <div className="omo-step-title"><span>02</span> Make it yours</div>
                    <label className="omo-field">Workspace name<input data-testid="room-name" maxLength={120} defaultValue={this.draftName} onChange={event => { this.draftName = event.target.value; this.update(); }} placeholder="My next big thing" /></label>
                    <div className="omo-field">Project folder<div className="omo-folder"><span title={this.project?.path.toString()}>{this.project?.path.toString() ?? 'No folder selected'}</span><button onClick={this.chooseProject} disabled={this.busy}>Browse</button></div></div>
                    <button className="omo-primary" data-testid="create-room" disabled={!this.project || !this.draftName.trim() || this.busy} onClick={this.createRoom}>{this.room ? 'Save room' : 'Create my room'} <span>↗</span></button>
                    {this.room && <button className="omo-cancel" onClick={() => { this.configuring = false; this.update(); }}>Back to my room</button>}
                    <p className="omo-privacy">Saved on this device. No account. No model calls.</p>
                </section> : null}
                <section className="omo-stage" aria-label="Spatial workspace">
                    <div className="omo-stage-heading"><div><span className="omo-kicker">{THEMES[theme].eyebrow}</span><h2>{this.configuring ? THEMES[theme].title : this.room!.projectName}</h2><p>{this.configuring ? THEMES[theme].description : 'Same project. A different perspective.'}</p></div>
                        {!this.configuring && <button className="omo-outline" data-testid="edit-room" onClick={this.configure}>◌ Customise room</button>}
                    </div>
                    {this.room && !this.configuring && <div className="omo-console-dock" onPointerDownCapture={()=>this.worldScene?.releaseTyping()}>
                        <PresenceStrip state={this.presenceState} onJoin={this.joinPresence} onLeave={this.leavePresence} deskRoom={this.personalRoom?.roomId}/>
                        <nav className="omo-station-switch" aria-label="Physical workstations"><button data-testid="station-one-controls" aria-pressed={this.activeMode === 'terminal'} onClick={()=>this.chooseStation('terminal')}>Desk one{this.consoleStates.terminal.unreadBells > 0 && <strong className="omo-bell-alert" data-testid="station-one-bell" role="status"> · Bell {this.consoleStates.terminal.unreadBells}</strong>}</button><button data-testid="station-two-controls" aria-pressed={this.activeMode === 'terminal-2'} onClick={()=>this.chooseStation('terminal-2')}>Desk two{this.consoleStates['terminal-2'].unreadBells > 0 && <strong className="omo-bell-alert" data-testid="station-two-bell" role="status"> · Bell {this.consoleStates['terminal-2'].unreadBells}</strong>}</button><button data-testid="station-web-controls" aria-pressed={this.activeMode === 'web'} onClick={()=>this.chooseStation('web')}>Web wall</button></nav>
                        {this.activeMode === 'web' ? <WebSurfaceStrip key={this.project?.toString()} state={this.webState} controller={this.web} initialUrl={this.savedWebUrl}/> : <RuntimeConsoleStrip key={this.activeStation} state={this.consoleState} controller={this.console} onOpenLink={this.openTerminalLink}/>}
                    </div>}
                    <SceneView key={theme} theme={theme} camera={this.room?.camera ?? CAMERA} onSelect={this.selectStation} onTextSelect={this.chooseStation} onCamera={this.cameraChanged} walk={!this.configuring} terminalFrames={this.monitors} webFrame={this.webState.frame} onInstance={scene=>{this.worldScene=scene;scene?.setPeers(this.presenceState.snapshot?.members.filter(m=>m.id!==this.presenceState.snapshot?.selfId)??[]);}} onInput={this.terminalInput} onPaste={this.pasteInput} onScroll={this.worldScroll} onMessage={text=>{this.feedback=text;this.update();}}/>
                    <pre className="omo-accessible-terminal" role="log" aria-label="Live in-world terminal" data-testid="in-world-terminal-output" data-ready={String(this.consoleState.phase === 'live')} data-phase={this.consoleState.phase}>{this.consoleState.lines.join('\n')}</pre>
                    {!this.configuring && <aside className="omo-tool-dock" aria-label="Project tools"><span>YOUR WORKSTATIONS</span><button disabled={this.busy} data-testid="terminal-action" onClick={() => this.selectStation('terminal')}><b>01</b><div><strong>Terminal</strong><small>A real shell. Your project folder.</small></div><span>↗</span></button><button disabled={this.busy} data-testid="code-action" onClick={() => this.selectStation('code')}><b>02</b><div><strong>Code</strong><small>Files, editing and your next change.</small></div><span>↗</span></button><p>Nothing starts unless you choose it.</p></aside>}
                    {this.configuring && <div className="omo-preview-badge"><i/> LIVE ROOM PREVIEW</div>}
                </section>
            </div>
            <footer className="omo-footer"><span>◈ &nbsp; {this.configuring ? 'A workspace with a sense of place.' : this.project?.path.toString()}</span><span role={this.error ? 'alert' : 'status'} className={this.error ? 'omo-error' : ''}>{this.error || this.feedback || 'Built on Theia · Local first'}</span></footer>
        </main>;
    }
}

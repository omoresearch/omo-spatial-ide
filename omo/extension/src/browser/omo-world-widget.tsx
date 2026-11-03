import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { Widget } from '@theia/core/lib/browser/widgets/widget';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';
import URI from '@theia/core/lib/common/uri';
import { RoomScene, Workstation } from './room-scene';
import { RoomState, RoomTheme, parseRoomState } from '../common/room-state';

const CAMERA = { azimuth: 0.56, elevation: 0.61, distance: 24 };
const THEMES = {
    station: { title: 'Space station', eyebrow: 'ORBITAL / 01', description: 'A quiet observatory for your next big idea.', symbol: '◉' },
    jungle: { title: 'Prehistoric jungle', eyebrow: 'EXPEDITION / 02', description: 'A green retreat. Room to think, space to build.', symbol: '✳' }
};

function SceneView(props: { theme: RoomTheme; camera: RoomState['camera']; onSelect: (station: Workstation) => void; onCamera: (camera: RoomState['camera']) => void; walk: boolean; terminalLines: string[]; onInput: (text: string) => void; onMessage: (text: string) => void }): React.ReactElement {
    const host = React.useRef<HTMLDivElement>(null);
    const instance = React.useRef<RoomScene>();
    const callbacks = React.useRef(props); callbacks.current = props;
    const [error, setError] = React.useState('');
    const [ready, setReady] = React.useState(false);
    const [mode,setMode]=React.useState<'walk'|'overview'>(props.walk?'walk':'overview');
    React.useEffect(()=>{setMode(props.walk?'walk':'overview');},[props.walk]);
    React.useEffect(()=>{instance.current?.setNavigation(mode);},[mode]);
    React.useEffect(()=>{instance.current?.setTerminalLines(props.terminalLines);},[props.terminalLines]);
    React.useEffect(() => {
        if (!host.current) return;
        setError(''); setReady(false);
        const scene = new RoomScene(host.current, { theme: props.theme, camera: props.camera, walk: mode==='walk',
            onInput: text=>callbacks.current.onInput(text),onMessage:text=>callbacks.current.onMessage(text),
            onSelect: action => callbacks.current.onSelect(action), onCameraChange: camera => callbacks.current.onCamera(camera),
            onReady: () => setReady(true), onError: message => setError(message) });
        instance.current = scene;scene.setTerminalLines(props.terminalLines);
        return () => { scene.dispose(); instance.current = undefined; };
    }, [props.theme]);
    return <div className={`omo-scene-wrap ${mode==='walk'?'omo-walking':''}`} data-theme={props.theme} data-navigation={mode}>
        <div ref={host} className="omo-scene" data-testid="omo-scene" data-ready={ready ? 'true' : 'false'} />
        {error && <div className="omo-render-error" role="alert"><strong>3D rendering could not start.</strong><p>{error}</p><p>The project terminal and editor are still available from the toolbar.</p></div>}
        {mode==='walk'&&<div className="omo-crosshair" aria-hidden="true">+</div>}
        {props.walk&&<div className="omo-navigation-switch"><button data-testid="walk-mode" aria-pressed={mode==='walk'} onClick={()=>setMode('walk')}>First person</button><button data-testid="overview-mode" aria-pressed={mode==='overview'} onClick={()=>setMode('overview')}>Overview</button></div>}
        <div className="omo-scene-controls"><span>{mode==='walk'?'WASD to walk · Drag to look · Click a screen · Esc to leave it':'Drag to orbit · Scroll to zoom'}</span><button aria-label="Reset room camera" onClick={() => instance.current?.resetCamera()}>↺ Reset view</button></div>
    </div>;
}

@injectable()
export class OmoWorldWidget extends ReactWidget {
    static readonly ID = 'omo-world';
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(TerminalService) protected readonly terminals!: TerminalService;
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
    private terminalOpening?: Promise<void>;
    private liveTerminal?: TerminalWidget;
    private terminalLines: string[] = [];
    private terminalReady = false;

    @postConstruct()
    protected init(): void {
        this.id = OmoWorldWidget.ID; this.title.label = 'World'; this.title.caption = 'Omo · Your spatial workspace';
        this.title.closable = false; this.title.iconClass = 'codicon codicon-globe';
        this.addClass('omo-world-widget'); this.node.tabIndex = -1;
        this.initialize().catch(error => { this.error = String(error); this.initialized = true; this.update(); });
    }
    private storageKey(): string { return `omo.room.v1:${this.project?.toString() ?? ''}`; }
    private async initialize(): Promise<void> {
        const roots = await this.workspace.roots;
        this.project = roots[0]?.resource;
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
    private selectStation = (station: Workstation): void => {
        if (this.configuring) { this.feedback = 'Create your room first, then select a workstation.'; this.update(); return; }
        void this.runAction(() => station === 'terminal' ? this.openTerminal() : this.openCode());
    };
    private async runAction(action: () => Promise<void>): Promise<void> {
        if (this.busy) return;
        this.busy = true; this.error = ''; this.update();
        try { await action(); } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
        finally { this.busy = false; this.update(); }
    }
    private terminalInput = (text: string): void => { this.liveTerminal?.sendText(text); };
    private async openTerminal(): Promise<void> {
        if (!this.project) throw new Error('Choose a project folder first.');
        if (this.liveTerminal && !this.liveTerminal.isDisposed) return;
        if (this.terminalOpening) return this.terminalOpening;
        this.terminalOpening = (async () => {
            const terminal = await this.terminals.newTerminal({ id: 'omo-in-world-terminal', title: `Omo · ${this.project!.path.base}`,
                cwd: this.project!.toString(), useServerTitle: false, destroyTermOnClose: true, kind: 'user' });
            // The real xterm widget parses the real PTY stream. It is not opened in a flat panel.
            const backplane = document.createElement('div');backplane.className='omo-terminal-backplane';backplane.setAttribute('aria-hidden','true');document.body.appendChild(backplane);
            terminal.node.style.width='800px';terminal.node.style.height='440px';Widget.attach(terminal,backplane);
            this.toDispose.push({dispose:()=>{terminal.dispose();backplane.remove();}});
            const capture=()=>{this.terminalLines=terminal.buffer.getLines(Math.max(0,terminal.buffer.length-22),22,true);this.update();};
            this.toDispose.push(terminal.onOutput(capture));
            this.toDispose.push(terminal.onSizeChanged(size=>{if(size.cols!==80||size.rows!==22)terminal.resize(80,22);}));
            await terminal.start();terminal.resize(80,22);
            this.liveTerminal=terminal;this.terminalReady=true;capture();
            this.feedback='Live terminal on the monitor · Type here. Esc to walk away.';
        })();
        try { await this.terminalOpening; } finally { this.terminalOpening = undefined; }
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
    private configure = (): void => { this.draftTheme = this.room?.theme ?? 'station'; this.draftName = this.room?.projectName ?? this.draftName; this.configuring = true; this.feedback = ''; this.update(); };

    protected render(): React.ReactNode {
        if (!this.initialized) return <div className="omo-loading">Opening your workspace…</div>;
        const theme = this.configuring ? this.draftTheme : this.room!.theme;
        return <main className={`omo-root omo-${theme}`} data-testid="omo-world" data-configured={this.room ? 'true' : 'false'}>
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
                    <SceneView key={theme} theme={theme} camera={this.room?.camera ?? CAMERA} onSelect={this.selectStation} onCamera={this.cameraChanged} walk={!this.configuring} terminalLines={this.terminalLines} onInput={this.terminalInput} onMessage={text=>{this.feedback=text;this.update();}}/>
                    <pre className="omo-accessible-terminal" role="log" aria-label="Live in-world terminal" data-testid="in-world-terminal-output" data-ready={String(this.terminalReady)}>{this.terminalLines.join('\n')}</pre>
                    {!this.configuring && <aside className="omo-tool-dock" aria-label="Project tools"><span>YOUR WORKSTATIONS</span><button disabled={this.busy} data-testid="terminal-action" onClick={() => this.selectStation('terminal')}><b>01</b><div><strong>Terminal</strong><small>A real shell. Your project folder.</small></div><span>↗</span></button><button disabled={this.busy} data-testid="code-action" onClick={() => this.selectStation('code')}><b>02</b><div><strong>Code</strong><small>Files, editing and your next change.</small></div><span>↗</span></button><p>No agents running. You’re in control.</p></aside>}
                    {this.configuring && <div className="omo-preview-badge"><i/> LIVE ROOM PREVIEW</div>}
                </section>
            </div>
            <footer className="omo-footer"><span>◈ &nbsp; {this.configuring ? 'A workspace with a sense of place.' : this.project?.path.toString()}</span><span role={this.error ? 'alert' : 'status'} className={this.error ? 'omo-error' : ''}>{this.error || this.feedback || 'Built on Theia · Local first'}</span></footer>
        </main>;
    }
}

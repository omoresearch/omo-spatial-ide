/**
 * promise:onboarding — the first minute (mock-up: omo-space-landing-mockup/onboarding). Shown on a true first run
 * (no room, no saved world). Calm black, one mint accent.
 *
 *   Welcome   "Your mind, given a place."                      Get started ↵   (or: start in the penthouse / set up by hand)
 *   Stage 1   "If your mind had a home, what would it look like?"   one input, Enter -> the world is planned from it
 *   Stage 2   "Bring your mind with you."   Hermes + Claude Code chats, read on this device (0 bytes sent) or Skip for now
 *   Ready     "Your world is ready."   Enter your world ↵  -> the world is saved and shown.
 *
 * Planning is local (mind-world.ts through the onboarding planner); the import is the backend's local-only reader
 * (node/mind-import.ts). Timer: from the sentence (Enter in stage 1) to the world shown, kept in
 * <html data-omo-first-minute-ms> and localStorage omo.firstMinute.ms.
 */
import * as React from 'react';
import type { WorldSpec } from '../common/world-model';
import type { MindImportResult, MindImportService } from '../common/mind-import-protocol';
import { homeWorld, mindCounts, mindWorld } from './mind-world';
import { starterWorld } from './starter-world';
import '../../src/browser/first-minute.css';

export const FIRST_MINUTE_PREF = 'omo.firstMinute';

/** False when a driver or the user opted out (omo.firstMinute = off) or kept the classic starter room. */
export function firstMinuteEnabled(storage: Pick<Storage, 'getItem'> | undefined = safeStore()): boolean {
    try { return storage?.getItem(FIRST_MINUTE_PREF) !== 'off' && storage?.getItem('omo.starter') !== 'classic'; } catch { return true; }
}
function safeStore(): Storage | undefined { try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; } }

export interface FirstMinuteProps {
    initialName: string;
    projectPath?: string;
    busy: boolean;
    /** The backend's local chat reader; undefined = not available here (Read is disabled, Skip works). */
    mind?: MindImportService;
    onPreview: (world: WorldSpec) => void;
    onCreate: (world: WorldSpec) => Promise<void> | void;
    onChooseProject: () => void;
    /** "Set up by hand": the classic 3-step onboarding. */
    onManual: () => void;
}

type Scene = 'welcome' | 'seed' | 'mind' | 'ready';
type Read = 'idle' | 'reading' | 'done' | 'error';

/** Chat titles in the room list: about one line beside the room name (520 px column, 13 px text). */
export const CHAT_LINE_MAX = 46;
/** Cut text at the last whole word that fits in max characters, then add an ellipsis; never mid-word. */
export function clipWords(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max + 1);
    const at = cut.lastIndexOf(' ');
    const head = (at > 0 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s·,;:.\-–—]+$/u, '');
    return `${head}…`;
}

const Kbd = (): React.ReactElement => <kbd aria-hidden="true">↵</kbd>;

export function FirstMinute(props: FirstMinuteProps): React.ReactElement {
    const [scene, setScene] = React.useState<Scene>('welcome');
    const [seed, setSeed] = React.useState('');
    const [home, setHome] = React.useState<{ world: WorldSpec; notes: string[] }>();
    const [sources, setSources] = React.useState({ hermes: true, claude: true });
    const [read, setRead] = React.useState<Read>('idle');
    const [result, setResult] = React.useState<MindImportResult>();
    const [world, setWorld] = React.useState<WorldSpec>();
    const [error, setError] = React.useState('');
    const [entering, setEntering] = React.useState(false);
    const started = React.useRef<number>(0);
    const primary = React.useRef<HTMLButtonElement>(null);
    const seedBox = React.useRef<HTMLTextAreaElement>(null);
    const alive = React.useRef(true);
    React.useEffect(() => () => { alive.current = false; }, []);
    React.useEffect(() => { const id = window.setTimeout(() => (scene === 'seed' ? seedBox.current : primary.current)?.focus(), 60); return () => window.clearTimeout(id); }, [scene, read]);

    const preview = (w: WorldSpec): void => { setWorld(w); try { props.onPreview(w); } catch { /* the preview is best effort */ } };

    const bringToLife = (): void => {
        started.current = performance.now();
        const plan = homeWorld(seed, {});
        setHome({ world: plan.world, notes: plan.notes });
        preview(plan.world);
        setScene('mind');
    };
    const readHere = async (): Promise<void> => {
        if (!props.mind || !home || read === 'reading') return;
        setRead('reading'); setError('');
        try {
            const r = await props.mind.importMind({ hermes: sources.hermes, claude: sources.claude });
            if (!alive.current) return;
            setResult(r); setRead('done');
            preview(mindWorld(home.world, r.rooms));
        } catch (err) {
            if (!alive.current) return;
            setRead('error'); setError(`Could not read the chats here (${err instanceof Error ? err.message : String(err)}). Nothing was sent.`);
        }
    };
    const skip = (): void => { if (home) preview(home.world); setScene('ready'); };
    const enter = async (): Promise<void> => {
        const w = world ?? home?.world;
        if (!w || entering) return;
        if (!props.projectPath) { props.onChooseProject(); return; }
        setEntering(true); setError('');
        try {
            await props.onCreate({ ...w, revision: 0 });
            const ms = Math.round(performance.now() - (started.current || performance.now()));
            document.documentElement.dataset.omoFirstMinuteMs = String(ms);
            try { localStorage.setItem(`${FIRST_MINUTE_PREF}.ms`, String(ms)); } catch { /* private mode */ }
        } catch (err) {
            if (alive.current) setError(err instanceof Error ? err.message : String(err));
        } finally { if (alive.current) setEntering(false); }
    };
    const quickStart = async (): Promise<void> => {
        const w = starterWorld(props.initialName) ?? homeWorld('', { name: props.initialName }).world;
        if (!props.projectPath) { props.onChooseProject(); return; }
        setEntering(true);
        try { await props.onCreate(w); } catch (err) { if (alive.current) setError(err instanceof Error ? err.message : String(err)); } finally { if (alive.current) setEntering(false); }
    };

    const counts = result?.counts;
    const made = world ? mindCounts(world) : { rooms: 0, notes: 0, signs: 0 };
    const step = scene === 'welcome' ? 0 : scene === 'seed' ? 1 : 2;
    const head = read === 'reading' ? 'b' : read === 'done' ? 'c' : 'a';

    return <section className={`omo-fm omo-fm-${scene}`} data-testid="first-minute" data-scene={scene} data-read={read} role="dialog" aria-modal="true" aria-label="Make your world"
        onKeyDown={e => e.stopPropagation()} onKeyUp={e => e.stopPropagation()}>
        <span data-testid="omo-onboarding" hidden />{/* drivers that wait for onboarding and press create-room ("Start in the penthouse") still work */}
        <div className="omo-fm-sky" aria-hidden="true" />
        <div className="omo-fm-hz" aria-hidden="true" />
        <header className="omo-fm-top">
            <span className="omo-fm-logo"><i />omo<span>space</span></span>
            {scene !== 'welcome' && <span className="omo-fm-prog" aria-label="Progress"><span className={`seg ${step >= 1 ? 'on' : ''}`}><i /></span><span className={`seg ${step >= 2 ? 'on' : ''}`}><i /></span><span>{step === 1 ? '1 / 2' : '2 / 2'}</span></span>}
        </header>

        {scene === 'welcome' && <div className="omo-fm-scene omo-fm-centre" key="welcome">
            <h1>Your mind,<br /><em>given a place.</em></h1>
            <p className="omo-fm-lede">In about a minute you will have a world of your own, shaped by how you think and what you are working on.</p>
            <button ref={primary} type="button" className="omo-fm-btn primary" data-testid="first-minute-start" onClick={() => setScene('seed')}>Get started <Kbd /></button>
            <p className="omo-fm-hint">or press Enter</p>
            <div className="omo-fm-quiet">
                <button type="button" className="omo-fm-link" data-testid="create-room" disabled={props.busy || entering} onClick={() => { void quickStart(); }}>Start in the penthouse</button>
                <span aria-hidden="true">·</span>
                <button type="button" className="omo-fm-link" data-testid="first-minute-manual" onClick={props.onManual}>Set up by hand</button>
            </div>
        </div>}

        {scene === 'seed' && <div className="omo-fm-scene omo-fm-centre" key="seed">
            <h2>If your mind had a home,<br /><em>what would it look like?</em></h2>
            <label className="omo-fm-sr" htmlFor="omo-fm-seed">The home your mind would live in</label>
            <textarea id="omo-fm-seed" ref={seedBox} className="omo-fm-seed" data-testid="first-minute-seed" rows={2} maxLength={180} spellCheck={false} enterKeyHint="go"
                placeholder="A lighthouse library at the edge of the sea…" value={seed} onChange={e => setSeed(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); bringToLife(); } }} />
            <p className="omo-fm-hint"><kbd aria-hidden="true">↵</kbd> Enter to bring it to life</p>
            <button type="button" className="omo-fm-btn primary omo-fm-go" data-testid="first-minute-go" onClick={bringToLife}>Bring it to life <Kbd /></button>
        </div>}

        {scene === 'mind' && <div className="omo-fm-scene omo-fm-side" key="mind">
            <div className="omo-fm-seedpill"><i /><b>Your world</b><q data-testid="first-minute-echo">{seed.trim() || 'A penthouse above the city'}</q></div>
            <p className="omo-fm-eyebrow">Stage 2 · Bring your mind with you</p>
            <h2 data-testid="first-minute-mind-head" aria-live="polite">{head === 'a' ? <>Bring your mind <em>with you.</em></> : head === 'b' ? <>Reading, <em>on this device.</em></> : <>Your mind <em>has rooms now.</em></>}</h2>
            <p className="omo-fm-sub">Your chats become rooms. Read here, never uploaded.</p>
            {read !== 'done' && <div className="omo-fm-sources" role="group" aria-label="Sources">
                {([['hermes', 'Hermes chats', '~/.hermes/sessions', '1'], ['claude', 'Claude Code chats', '~/.claude/projects', '2']] as const).map(([key, name, where, k]) =>
                    <button key={key} type="button" className="omo-fm-src" data-testid={`first-minute-src-${key}`} aria-pressed={sources[key]} disabled={read === 'reading'}
                        onClick={() => setSources(s => ({ ...s, [key]: !s[key] }))}>
                        <span className="chk"><i /></span><span className="nm"><strong>{name}</strong><small>{where} · on this computer</small></span><span className="tag">Local</span><kbd>{k}</kbd></button>)}
                <p className="omo-fm-more">Later: Cursor, ChatGPT exports, Obsidian and Notion.</p>
            </div>}
            {read === 'done' && counts && <div className="omo-fm-reader" data-testid="first-minute-result">
                <div className="omo-fm-stats">
                    <div><small>Chats</small><span data-testid="first-minute-chats">{counts.chats}</span></div>
                    <div><small>Rooms</small><span data-testid="first-minute-rooms">{made.rooms}</span></div>
                    <div><small>Screens</small><span>{counts.screens}</span></div>
                    <div><small>Notes</small><span>{made.notes + made.signs}</span></div>
                </div>
                <ul className="omo-fm-rooms">{result!.rooms.map(r => <li key={r.title}><b>{r.title}</b><span title={r.screens.map(s => s.title).join(' · ')}>{clipWords(r.screens.map(s => s.title).join(' · '), CHAT_LINE_MAX)}</span></li>)}</ul>
                {!result!.rooms.length && <p className="omo-fm-sub">No chats were found on this computer. Your world starts with its home room.</p>}
            </div>}
            <div className="omo-fm-actions">
                {read === 'idle' || read === 'error' ? <>
                    <button ref={primary} type="button" className="omo-fm-btn primary" data-testid="first-minute-read" disabled={!props.mind || (!sources.hermes && !sources.claude)} onClick={() => { void readHere(); }}>Read on this device <Kbd /></button>
                    <button type="button" className="omo-fm-link" data-testid="first-minute-skip" onClick={skip}>Skip for now</button>
                </> : read === 'reading' ? <span className="omo-fm-local" data-testid="first-minute-reading"><span className="dot" />Reading on this device · 0 bytes sent</span> : <>
                    <button ref={primary} type="button" className="omo-fm-btn primary" data-testid="first-minute-form" onClick={() => setScene('ready')}>Form my world <Kbd /></button>
                    <span className="omo-fm-local" data-testid="first-minute-bytes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>{counts?.bytesSent ?? 0} bytes leave this device</span>
                </>}
            </div>
            {!props.mind && <p className="omo-fm-note">Reading chats needs the Omo app on this computer. Skip for now and add them later.</p>}
            {error && <p className="omo-fm-error" role="alert">{error}</p>}
        </div>}

        {scene === 'ready' && <div className="omo-fm-scene omo-fm-side omo-fm-end" key="ready">
            <h2>Your world <em>is ready.</em></h2>
            <p className="omo-fm-q" data-testid="first-minute-quote">“{seed.trim() || 'A penthouse above the city'}”</p>
            <p className="omo-fm-sub" data-testid="first-minute-summary">{home?.notes[0]}{made.rooms ? ` · ${made.rooms} room${made.rooms === 1 ? '' : 's'} from your chats, ${made.notes} note${made.notes === 1 ? '' : 's'}` : ''}</p>
            <button ref={primary} type="button" className="omo-fm-btn primary" data-testid="first-minute-enter" disabled={entering || props.busy} onClick={() => { void enter(); }}>{entering ? 'Opening…' : 'Enter your world'} <Kbd /></button>
            <p className="omo-fm-hint">Saved on this device. Nothing starts until you choose it.</p>
            {error && <p className="omo-fm-error" role="alert">{error}</p>}
        </div>}
    </section>;
}

/**
 * w2:onboard — "prompt to world" onboarding: Describe → Your world → Create.
 *
 * Step 1  Describe your plan (free text + template cards, theme, name). The offline planner reads it
 *         live and shows what it understood. "Plan with Hermes" is opt-in and asks before sending.
 * Step 2  Your world: a floor plan of the proposed WorldSpec (every entity, real positions), the live
 *         3D room behind the panel, and an editable list (rename, change desk agent, remove, add).
 *         Every edit is a WorldOp through the shared contract, so the list can never become invalid.
 * Step 3  Create: a summary, the project folder, and Create. Creating saves the world; it never
 *         starts an agent or a terminal. Desks only list the tabs they offer to open later.
 */
import * as React from 'react';
import type { RoomTheme } from '../common/room-state';
import { WORLD_MAX_ENTITIES, WORLD_MAX_STATIONS, stations } from '../common/world-model';
import type { WorldEntity, WorldOp, WorldSpec, StationEntity } from '../common/world-model';
import {
    ONBOARDING_TEMPLATES, AGENT_LABEL, planWorld, planTitle, applyOnboardingEdit, agentOf, stationForAgent, nextStationId, nextId, deskName, describeWorld
} from './onboarding-planner';
import type { DeskAgent, PlanResult } from './onboarding-planner';
import { planWithBackend } from './onboarding-admin';
import type { OnboardingPlanBackend } from './onboarding-admin';
import '../../src/browser/onboarding.css';

export interface OnboardingFlowProps {
    initialName: string;
    initialTheme: RoomTheme;
    /** A world saved before (editing an existing room): prefills the plan text and step 2. */
    savedWorld?: WorldSpec;
    projectPath?: string;
    hasRoom: boolean;
    busy: boolean;
    /** The admin lane planner, when bound. Undefined = offline only. */
    hermes?: OnboardingPlanBackend;
    /** The 3D scene can draw any WorldSpec (render lane setWorld present). */
    fullPreview: boolean;
    onPreview: (world: WorldSpec) => void;
    onCreate: (world: WorldSpec) => Promise<void> | void;
    onChooseProject: () => void;
    onCancel: () => void;
    onClassic: () => void;
}

type Step = 1 | 2 | 3;
const AGENTS: DeskAgent[] = ['hermes', 'claude', 'codex', 'shell'];
const KIND_ICON: Record<WorldEntity['kind'], string> = { station: '▣', 'monitor-wall': '▤', 'web-wall': '◫', mirror: '◩', 'review-screen': '⌘', decor: '✿' };
const KIND_LABEL: Record<WorldEntity['kind'], string> = { station: 'Desk', 'monitor-wall': 'Monitor wall', 'web-wall': 'Web wall', mirror: 'Mirror', 'review-screen': 'Code review', decor: 'Decor' };
const THEME_INFO: Record<RoomTheme, { title: string; symbol: string }> = { station: { title: 'Space station', symbol: '◉' }, jungle: { title: 'Prehistoric jungle', symbol: '✳' } };

const labelOf = (e: WorldEntity): string => e.label ?? (e.kind === 'station' ? e.station.name : KIND_LABEL[e.kind]);

function RenameField(props: { value: string; disabled?: boolean; testId: string; onCommit: (value: string) => void }): React.ReactElement {
    const [draft, setDraft] = React.useState(props.value);
    React.useEffect(() => setDraft(props.value), [props.value]);
    const commit = (): void => { const v = draft.trim().slice(0, 60); if (v && v !== props.value) props.onCommit(v); else setDraft(props.value); };
    return <input className="omo-ob-rename" data-testid={props.testId} aria-label="Name" maxLength={60} value={draft} disabled={props.disabled}
        onChange={e => setDraft(e.target.value)} onFocus={e => e.currentTarget.select()} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } else if (e.key === 'Escape') { setDraft(props.value); } e.stopPropagation(); }} />;
}

/** Top-down plan of the world in metres. Pure SVG; shows every entity where it will stand. */
function FloorPlan(props: { world: WorldSpec; selected?: string; onSelect: (id: string) => void }): React.ReactElement {
    const { width: w, depth: d } = props.world.shell;
    const pad = 0.6;
    return <svg className="omo-ob-plan" data-testid="onboarding-floor-plan" viewBox={`${-w / 2 - pad} ${-d / 2 - pad} ${w + pad * 2} ${d + pad * 2}`} role="img" aria-label={`Floor plan: ${describeWorld(props.world)}`}>
        <defs><pattern id="omo-ob-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M 1 0 L 0 0 0 1" fill="none" className="omo-ob-grid-line" /></pattern></defs>
        <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={0.3} className="omo-ob-floor" />
        <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={0.3} fill="url(#omo-ob-grid)" />
        <rect x={-0.9} y={d / 2 - 0.08} width={1.8} height={0.16} className="omo-ob-door" />
        {props.world.entities.map(e => {
            const t = e.transform, sel = props.selected === e.id;
            const deg = -t.rotation * 180 / Math.PI;
            const common = { key: e.id, transform: `translate(${t.x} ${t.z}) rotate(${deg})`, className: `omo-ob-ent omo-ob-${e.kind}${sel ? ' is-selected' : ''}`, onClick: () => props.onSelect(e.id), 'data-entity': e.id } as const;
            let shape: React.ReactNode;
            if (e.kind === 'station') shape = <><rect x={-1.1} y={-0.55} width={2.2} height={1.1} rx={0.18} data-agent={agentOf(e.station)} /><circle cx={0} cy={0.95} r={0.28} /></>;
            else if (e.kind === 'monitor-wall' || e.kind === 'web-wall') shape = <rect x={-e.width / 2} y={-0.14} width={e.width} height={0.28} rx={0.08} />;
            else if (e.kind === 'mirror' || e.kind === 'review-screen') shape = <rect x={-0.8} y={-0.12} width={1.6} height={0.24} rx={0.08} />;
            else shape = <circle cx={0} cy={0} r={0.32 * (e.scale ?? 1)} />;
            return <g {...common}><title>{labelOf(e)}</title>{shape}</g>;
        })}
        {props.world.entities.filter(e => e.kind === 'station' || e.kind === 'monitor-wall' || e.kind === 'web-wall').map(e =>
            <text key={`t-${e.id}`} x={e.transform.x} y={e.transform.z + (e.kind === 'station' ? 0.12 : Math.abs(Math.sin(e.transform.rotation)) > 0.5 ? 0 : 0.62)} className="omo-ob-label" textAnchor="middle">{labelOf(e).slice(0, 14)}</text>)}
    </svg>;
}

export function OnboardingFlow(props: OnboardingFlowProps): React.ReactElement {
    const [step, setStep] = React.useState<Step>(props.savedWorld ? 2 : 1);
    const [prompt, setPrompt] = React.useState(props.savedWorld?.plan ?? '');
    const [typedName, setName] = React.useState(props.savedWorld?.name ?? props.initialName);
    /** Until the user types a name, a plan title ("research lab: ...") names the world. */
    const [nameTouched, setNameTouched] = React.useState(!!props.savedWorld || props.hasRoom);
    const name = nameTouched ? typedName : (planTitle(prompt) ?? typedName);
    const typeName = (value: string): void => { setNameTouched(true); setName(value); };
    const [theme, setTheme] = React.useState<RoomTheme>(props.savedWorld?.shell.theme ?? props.initialTheme);
    const [themeTouched, setThemeTouched] = React.useState(!!props.savedWorld);
    const [useHermes, setUseHermes] = React.useState(false);
    const [confirming, setConfirming] = React.useState(false);
    const [planning, setPlanning] = React.useState(false);
    const [plan, setPlan] = React.useState<PlanResult | undefined>(props.savedWorld ? { world: props.savedWorld, notes: ['Your saved world'], warnings: [] } : undefined);
    const [source, setSource] = React.useState<'offline' | 'hermes' | 'saved'>(props.savedWorld ? 'saved' : 'offline');
    const [error, setError] = React.useState('');
    const [selected, setSelected] = React.useState<string>();
    const [creating, setCreating] = React.useState(false);
    const planEpoch = React.useRef(0);
    /** The step-1 inputs the current plan was made from; unchanged inputs keep the user's step-2 edits. */
    const [planFor, setPlanFor] = React.useState(props.savedWorld ? `${props.savedWorld.plan ?? ''}\u0000${props.savedWorld.shell.theme}` : '');

    const live = React.useMemo(() => planWorld(prompt, { name, theme: themeTouched ? theme : undefined }), [prompt, name, theme, themeTouched]);
    const world = step === 1 ? live.world : (plan?.world ?? live.world);
    const shownTheme = step === 1 ? live.world.shell.theme : world.shell.theme;

    // Live 3D preview, debounced so typing never rebuilds the scene on every key.
    const preview = React.useRef(props.onPreview); preview.current = props.onPreview;
    React.useEffect(() => { const id = window.setTimeout(() => preview.current(world), 280); return () => window.clearTimeout(id); }, [world]);
    React.useEffect(() => () => { planEpoch.current++; }, []);

    const edit = (ops: WorldOp[]): void => {
        if (!plan) return;
        const result = applyOnboardingEdit(plan.world, ops);
        if (!result.ok) { setError(result.error); return; }
        setError(''); setPlan({ ...plan, world: { ...result.world, revision: 0 } });
    };
    const taken = (): Set<string> => new Set(world.entities.map(e => e.id));
    const deskCount = stations(world).length;
    const full = world.entities.length >= WORLD_MAX_ENTITIES;
    const addDesk = (): void => {
        if (deskCount >= WORLD_MAX_STATIONS || full) { setError(`A world holds at most ${WORLD_MAX_STATIONS} desks.`); return; }
        const id = nextStationId(taken()), label = deskName(deskCount);
        edit([{ op: 'add', entity: { id, kind: 'station', label, transform: { x: 0, z: 0, rotation: 0 }, station: stationForAgent(label, 'hermes') } }]); setSelected(id);
    };
    const addWall = (kind: 'monitor-wall' | 'web-wall'): void => {
        if (full) { setError('A world holds at most 64 things.'); return; }
        const id = nextId(taken(), kind === 'web-wall' ? 'web' : 'monitor-wall');
        const entity: WorldEntity = kind === 'web-wall'
            ? { id, kind, label: 'Web wall', transform: { x: 0, z: 0, rotation: 0 }, width: 3.9, height: 2.44, elevation: 0.68 }
            : { id, kind, label: 'Monitor wall', transform: { x: 0, z: 0, rotation: 0 }, width: 3.2, height: 1.8, elevation: 0.9 };
        edit([{ op: 'add', entity }]); setSelected(id);
    };
    const addPlant = (): void => {
        if (full) { setError('A world holds at most 64 things.'); return; }
        const id = nextId(taken(), 'plant');
        edit([{ op: 'add', entity: { id, kind: 'decor', decor: 'plant', label: 'Plant', transform: { x: 0, z: 0, rotation: 0 } } }]);
    };
    const rename = (e: WorldEntity, label: string): void => edit(e.kind === 'station' ? [{ op: 'rename', id: e.id, label }, { op: 'update-station', id: e.id, station: { name: label } }] : [{ op: 'rename', id: e.id, label }]);
    const setAgent = (e: StationEntity, agent: DeskAgent): void => { const s = stationForAgent(e.station.name, agent, e.station.profile); edit([{ op: 'update-station', id: e.id, station: { kind: s.kind, tabs: s.tabs } }]); };
    const setLink = (id: string, to: string): void => edit([{ op: 'link', id, to: to || undefined }]);

    const chooseTheme = (next: RoomTheme): void => { setTheme(next); setThemeTouched(true); if (step > 1 && plan) edit([{ op: 'shell', shell: { theme: next } }]); };
    const toStep2 = (): void => {
        setError('');
        const key = `${prompt}\u0000${themeTouched ? theme : live.world.shell.theme}`;
        if (plan && planFor === key) { setStep(2); return; }
        if (useHermes && props.hermes) { setConfirming(true); return; }
        setPlan(live); setPlanFor(key); setSource('offline'); setSelected(undefined); setStep(2);
    };
    const runHermes = async (): Promise<void> => {
        if (!props.hermes) return;
        setConfirming(false); setPlanning(true); setError('');
        const epoch = ++planEpoch.current;
        try {
            const result = await planWithBackend(props.hermes, { prompt, name: name.trim() || 'My workspace', theme: themeTouched ? theme : undefined, source: 'onboarding', useHermes: true });
            if (epoch !== planEpoch.current) return;
            setPlan(result); setPlanFor(`${prompt}\u0000${themeTouched ? theme : live.world.shell.theme}`); setSource('hermes');
        } catch (err) {
            if (epoch !== planEpoch.current) return;
            const reason = err instanceof Error ? err.message : String(err);
            setPlan({ ...live, warnings: [...live.warnings, `Hermes could not plan this (${reason}). The offline planner was used.`] }); setSource('offline');
        } finally { if (epoch === planEpoch.current) { setPlanning(false); setSelected(undefined); setStep(2); } }
    };
    const cancelHermes = (): void => { planEpoch.current++; setPlanning(false); };
    const create = async (): Promise<void> => {
        if (creating) return;
        const finalWorld: WorldSpec = { ...world, name: (name.trim() || world.name).slice(0, 120), revision: 0 };
        setCreating(true); setError('');
        try { await props.onCreate(finalWorld); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setCreating(false); }
    };
    const canCreate = !!props.projectPath && !!name.trim() && !props.busy && !creating && !planning;

    const stepper = <ol className="omo-ob-steps" aria-label="Setup steps">
        {(['Describe your plan', 'Your world', 'Create'] as const).map((title, i) => {
            const n = (i + 1) as Step;
            return <li key={title} className={`${step === n ? 'is-current' : ''} ${step > n ? 'is-done' : ''}`}>
                <button type="button" data-testid={`onboarding-step-${n}`} aria-current={step === n ? 'step' : undefined} disabled={planning || creating}
                    onClick={() => { if (n === 1) setStep(1); else if (n === 2) { if (step === 1) toStep2(); else setStep(2); } else { if (!plan) setPlan(live); setStep(3); } }}>
                    <span>{step > n ? '✓' : `0${n}`}</span>{title}</button></li>;
        })}
    </ol>;

    const themePicker = <div className="omo-ob-themes" role="radiogroup" aria-label="World theme">
        {(Object.keys(THEME_INFO) as RoomTheme[]).map(key => <button key={key} type="button" role="radio" data-testid={`theme-${key}`} aria-checked={shownTheme === key} aria-pressed={shownTheme === key}
            className={`omo-ob-theme ${shownTheme === key ? 'selected' : ''}`} disabled={props.busy || planning} onClick={() => chooseTheme(key)}>
            <span>{THEME_INFO[key].symbol}</span>{THEME_INFO[key].title}</button>)}
    </div>;

    return <section className="omo-onboarding omo-ob" data-testid="omo-onboarding" data-onboarding-step={step} data-plan-source={source}>
        <div className="omo-setup-scroll omo-ob-scroll">
            <span className="omo-kicker">BUILD A WORLD FROM A SENTENCE</span>
            {stepper}

            {step === 1 && <div className="omo-ob-pane" key="s1">
                <h1>What will you<br />work on here?</h1>
                <p className="omo-intro">Describe your plan in plain words. Omo turns it into desks, walls and a room you can walk in.</p>
                <label className="omo-ob-prompt">
                    <span className="omo-ob-label">Your plan</span>
                    <textarea data-testid="onboarding-prompt" rows={4} maxLength={4000} value={prompt} disabled={planning}
                        placeholder="research lab: 3 Hermes desks for literature, data and writing, a shared monitor wall, a web wall for papers"
                        onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toStep2(); } e.stopPropagation(); }} />
                </label>
                <div className="omo-ob-understood" data-testid="onboarding-understood" aria-live="polite">
                    <span>{prompt.trim() ? 'Omo understood' : 'Empty plan = the classic room'}</span><strong>{describeWorld(live.world)}</strong>
                </div>
                <span className="omo-ob-label">Or start from a template</span>
                <div className="omo-ob-templates">{ONBOARDING_TEMPLATES.map(t => <button key={t.id} type="button" data-testid={`onboarding-template-${t.id}`}
                    className={`omo-ob-template ${prompt === t.prompt ? 'selected' : ''}`} disabled={planning} onClick={() => { setPrompt(t.prompt); if (!themeTouched) setTheme(planWorld(t.prompt).world.shell.theme); }}>
                    <span className="omo-ob-template-symbol">{t.symbol}</span><strong>{t.title}</strong><small>{t.caption}</small></button>)}</div>
                <span className="omo-ob-label">Theme</span>
                {themePicker}
                <label className="omo-field">Workspace name<input data-testid="room-name" maxLength={120} value={name} onChange={e => typeName(e.target.value)} onKeyDown={e => e.stopPropagation()} placeholder="My next big thing" /></label>
                <label className={`omo-ob-hermes ${props.hermes ? '' : 'is-off'}`}>
                    <input type="checkbox" data-testid="onboarding-use-hermes" checked={useHermes && !!props.hermes} disabled={!props.hermes || planning} onChange={e => setUseHermes(e.target.checked)} />
                    <span><strong>Plan with Hermes</strong><small>{props.hermes ? 'Hermes reads your plan text and proposes a world. You review it before anything is saved.' : 'Not available here. The offline planner runs on this device.'}</small></span>
                </label>
                <button type="button" className="omo-ob-link" data-testid="onboarding-classic" onClick={props.onClassic}>Room settings (layout, kit, presets) →</button>
            </div>}

            {step === 2 && <div className="omo-ob-pane" key="s2">
                <h1 className="omo-ob-h1-sm">Your world</h1>
                <p className="omo-intro">{source === 'hermes' ? 'Planned by Hermes.' : source === 'saved' ? 'Your saved world.' : 'Planned on this device.'} Rename, remove or add things. Nothing runs yet.</p>
                <FloorPlan world={world} selected={selected} onSelect={setSelected} />
                <div className="omo-ob-meta"><span data-testid="onboarding-summary">{describeWorld(world)}</span><span>{world.shell.width} × {world.shell.depth} m</span></div>
                {!props.fullPreview && deskCount > 2 && <p className="omo-ob-note" role="note">The 3D view behind shows the closest classic room. The floor plan shows your full world.</p>}
                {themePicker}
                {(plan?.warnings.length ?? 0) > 0 && <ul className="omo-ob-warnings" role="note">{plan!.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
                <ul className="omo-ob-list" data-testid="onboarding-entity-list">
                    {world.entities.map(e => <li key={e.id} className={selected === e.id ? 'is-selected' : ''} data-entity={e.id} data-kind={e.kind} onClick={() => setSelected(e.id)}>
                        <span className={`omo-ob-icon omo-ob-icon-${e.kind}`} data-agent={e.kind === 'station' ? agentOf(e.station) : undefined} aria-hidden="true">{KIND_ICON[e.kind]}</span>
                        <div className="omo-ob-row">
                            <RenameField value={labelOf(e)} testId={`onboarding-rename-${e.id}`} disabled={e.kind === 'station' && e.station.locked} onCommit={v => rename(e, v)} />
                            <small>{KIND_LABEL[e.kind]}{e.kind === 'station' ? ` · offers ${e.station.tabs.map(t => t.name).join(' + ')}` : ''}{e.kind === 'web-wall' && e.home ? ` · ${e.home.replace(/^https?:\/\//, '')}` : ''}{e.kind === 'decor' ? ` · ${e.decor}` : ''}</small>
                        </div>
                        {e.kind === 'station' && <select aria-label="Desk agent" data-testid={`onboarding-agent-${e.id}`} value={agentOf(e.station)} onChange={ev => setAgent(e, ev.target.value as DeskAgent)}>
                            {AGENTS.map(a => <option key={a} value={a}>{AGENT_LABEL[a]}</option>)}</select>}
                        {(e.kind === 'monitor-wall' || e.kind === 'mirror') && <select aria-label="Shows desk" data-testid={`onboarding-link-${e.id}`} value={e.link ?? ''} onChange={ev => setLink(e.id, ev.target.value)}>
                            {e.kind === 'monitor-wall' && <option value="">Own view</option>}
                            {stations(world).map(s => <option key={s.id} value={s.id}>{labelOf(s)}</option>)}</select>}
                        <button type="button" className="omo-ob-remove" data-testid={`onboarding-remove-${e.id}`} aria-label={`Remove ${labelOf(e)}`} title="Remove" onClick={ev => { ev.stopPropagation(); edit([{ op: 'remove', id: e.id }]); }}>×</button>
                    </li>)}
                </ul>
                <div className="omo-ob-add">
                    <button type="button" data-testid="onboarding-add-desk" disabled={deskCount >= WORLD_MAX_STATIONS || full} onClick={addDesk}>+ Desk</button>
                    <button type="button" data-testid="onboarding-add-monitor" disabled={full} onClick={() => addWall('monitor-wall')}>+ Monitor wall</button>
                    <button type="button" data-testid="onboarding-add-web" disabled={full} onClick={() => addWall('web-wall')}>+ Web wall</button>
                    <button type="button" data-testid="onboarding-add-plant" disabled={full} onClick={addPlant}>+ Plant</button>
                </div>
                {plan?.notes.length ? <details className="omo-ob-notes"><summary>What the planner read</summary><ul>{plan.notes.map(n => <li key={n}>{n}</li>)}</ul></details> : null}
            </div>}

            {step === 3 && <div className="omo-ob-pane" key="s3">
                <h1 className="omo-ob-h1-sm">Ready to create</h1>
                <p className="omo-intro">Creating saves your world on this device. No agent, terminal or web page starts. You open each desk when you choose.</p>
                <div className="omo-ob-card" data-testid="onboarding-create-summary">
                    <div className="omo-ob-card-head"><span>{THEME_INFO[world.shell.theme].symbol}</span><div><strong>{name.trim() || world.name}</strong><small>{THEME_INFO[world.shell.theme].title} · {describeWorld(world)}</small></div></div>
                    <ul>{stations(world).map(s => <li key={s.id}><b>{labelOf(s)}</b><span>{s.station.tabs.map(t => t.name).join(' · ')}</span></li>)}</ul>
                </div>
                <label className="omo-field">Workspace name<input data-testid="room-name" maxLength={120} value={name} onChange={e => typeName(e.target.value)} onKeyDown={e => e.stopPropagation()} /></label>
                <div className="omo-field">Project folder<div className="omo-folder"><span title={props.projectPath}>{props.projectPath ?? 'No folder selected'}</span><button onClick={props.onChooseProject} disabled={props.busy}>Browse</button></div></div>
            </div>}

            {confirming && <div className="omo-ob-confirm" role="alertdialog" aria-modal="true" aria-labelledby="omo-ob-confirm-title" data-testid="onboarding-hermes-confirm">
                <strong id="omo-ob-confirm-title">Send your plan to Hermes?</strong>
                <p>Hermes gets only the plan text above{prompt.trim() ? '' : ' (it is empty)'}. It proposes a world; it does not start agents or open terminals. Nothing is saved until you press Create.</p>
                <div><button type="button" className="omo-ob-confirm-yes" data-testid="onboarding-hermes-send" onClick={() => { void runHermes(); }}>Send to Hermes</button>
                    <button type="button" data-testid="onboarding-hermes-offline" onClick={() => { setConfirming(false); setPlan(live); setPlanFor(`${prompt}\u0000${themeTouched ? theme : live.world.shell.theme}`); setSource('offline'); setStep(2); }}>Use the offline planner</button>
                    <button type="button" data-testid="onboarding-hermes-cancel" onClick={() => setConfirming(false)}>Cancel</button></div>
            </div>}
            {planning && <div className="omo-ob-planning" role="status" data-testid="onboarding-planning"><i />Hermes is planning your world…<button type="button" onClick={cancelHermes}>Stop waiting</button></div>}
            {error && <p className="omo-ob-error" role="alert" data-testid="onboarding-error">{error}</p>}
        </div>
        <div className="omo-setup-actions omo-ob-actions">
            <div className="omo-ob-nav">
                {step > 1 && <button type="button" className="omo-ob-back" data-testid="onboarding-back" disabled={planning || creating} onClick={() => setStep((step - 1) as Step)}>← Back</button>}
                {step === 1 && <button type="button" className="omo-primary" data-testid="onboarding-next" disabled={planning || props.busy} onClick={toStep2}>{useHermes && props.hermes ? 'Plan with Hermes' : 'Preview my world'} <span>→</span></button>}
                {step === 2 && <button type="button" className="omo-primary" data-testid="onboarding-next" disabled={planning || props.busy} onClick={() => setStep(3)}>Looks good <span>→</span></button>}
                {step === 3 && <button type="button" className="omo-primary" data-testid="create-room" disabled={!canCreate} onClick={() => { void create(); }}>{creating ? 'Creating…' : props.hasRoom ? 'Save my world' : 'Create my world'} <span>↗</span></button>}
            </div>
            {step < 3 && <button type="button" className="omo-ob-quick" data-testid="create-room" disabled={!canCreate} onClick={() => { void create(); }}>{props.hasRoom ? 'Save now' : 'Create now'} · skip review</button>}
            {props.hasRoom && <button className="omo-cancel" data-testid="cancel-room" onClick={props.onCancel}>Back to my room</button>}
            <p className="omo-privacy">Saved on this device. Nothing starts until you choose it.{useHermes && props.hermes ? ' Hermes sees only your plan text.' : ' No model calls.'}</p>
        </div>
    </section>;
}

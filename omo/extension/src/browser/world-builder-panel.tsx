/**
 * builder-ui — the World Builder: one right-side glass panel for building the world.
 *
 *   Talk   chat with the existing world planner (AdminController: rules by default, Hermes only after the
 *          existing confirmation). Each reply shows the plan as plain steps and a one-line diff summary.
 *          The pending plan is a WorldStore proposal, so build mode draws it as ghosts in the room.
 *   Add    a visual palette: rooms (S / M / L or draw), desks (pick tab kinds), monitor walls (pick the
 *          desk they follow), web walls (enter a page), mirror, code review, decor. A card starts the
 *          existing placement ghost (crosshair, R turns, Esc stops, past the edge grows the world).
 *   Rooms  every room: jump to it, rename, resize, doorways.
 *   Inspect  the selected thing (the build inspector, plus page address, duplicate and delete).
 *
 * The shared proposal tray (diff + Apply / Discard) sits at the bottom of every tab.
 * Everything goes through BuildMode / WorldStore / AdminController: nothing here edits the world directly.
 * The panel stays in the right column, clear of the screen centre and the bottom-centre monitor click area.
 */
import * as React from 'react';
import type { BuildMode } from './build-mode';
import type { AdminController, AdminEntry, AdminState } from './admin-controller';
import { PALETTE, PaletteId, PaletteItem, placementPrefs, setPlacementPrefs, webHomeUrl } from './build-catalog';
import { BuildGlyph } from './build-glyphs';
import { Icon } from './icons';
import { WorldSizeSection } from './build-world-size';
import { entityTitle } from './world-store';
import type { RoomEntity, TabKind, WallSide, WorldSpec } from '../common/world-model';
import { applyWorldOps, stations, WALL_SIDES, ROOM_MIN, ROOM_MAX } from '../common/world-model';
import { WORLD_ADMIN_PROMPT_MAX } from '../common/world-admin-protocol';
import { diffSummary, ghostIds, jumpPose, nextTab, roomRows, talkChips } from './builder-helpers';
import type { BuilderTab, RoomRow } from './builder-helpers';
import { sceneControls } from './focus-screen';
import { threeOf } from './build-scene';
import { OmoSelect } from './omo-select'; // world-ui
import '../../src/browser/world-builder.css';

export type BuilderView = BuilderTab | 'rooms' | 'inspect';

export interface WorldBuilderProps {
    build: BuildMode;
    admin?: AdminController;
    adminState?: AdminState;
    /** The existing build inspector for the selected thing (rendered by build-panel.tsx). */
    inspector?: React.ReactNode;
    /** The shared proposal tray (rendered by build-panel.tsx). */
    tray?: React.ReactNode;
    /** world-ui — the build notice (was a centre toast), shown in the panel above the tray. */
    notice?: React.ReactNode;
}

const isField = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName));
/** The tab the builder showed last in this window (B again reopens it). Starts on Add: the palette is what B always showed. */
let lastTab: BuilderTab = 'add';

export function WorldBuilder(props: WorldBuilderProps): React.ReactElement | null {
    const { build, admin, adminState } = props;
    const store = build.store;
    const selected = build.state.selected;
    const [tab, setTabRaw] = React.useState<BuilderTab>(() => lastTab);
    const [view, setView] = React.useState<BuilderView>(tab);
    const setTab = (t: BuilderView): void => {
        if (t === 'talk' || t === 'add') { setTabRaw(t); lastTab = t; }
        if (t !== 'inspect' && selected && view === 'inspect') build.select(undefined);
        setView(t);
    };
    // The Talk tab shows the planner conversation: embed it while the builder is open.
    React.useEffect(() => { admin?.embed(true); return () => admin?.embed(false); }, [admin]);
    // H / the Admin button while building brings Talk forward.
    const talkFocus = adminState?.talkFocus ?? 0;
    const firstFocus = React.useRef(talkFocus);
    React.useEffect(() => { if (talkFocus !== firstFocus.current) setTab('talk'); }, [talkFocus]);
    // Selecting a thing in the world shows the inspector; deselecting goes back to the tab.
    const lastSel = React.useRef<string | undefined>(undefined);
    React.useEffect(() => {
        if (selected && selected !== lastSel.current) setView('inspect');
        if (!selected && view === 'inspect') setView(tab);
        lastSel.current = selected;
    }, [selected]);
    // Tab / Shift+Tab switch Talk ↔ Add (canvas or the panel focused, not typing).
    const viewRef = React.useRef(view); viewRef.current = view;
    const tabRef = React.useRef(tab); tabRef.current = tab;
    React.useEffect(() => {
        const key = (event: KeyboardEvent): void => {
            if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
            const t = event.target as HTMLElement | null;
            const canvas = threeOf(build.scene).canvas;
            const inPanel = !!t?.closest?.('[data-testid="world-builder"]');
            if (!(t === canvas || t === document.body || inPanel) || isField(t)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            const cur = viewRef.current === 'talk' || viewRef.current === 'add' ? viewRef.current : tabRef.current;
            const next = viewRef.current === 'talk' || viewRef.current === 'add' ? nextTab(cur) : cur;
            setTabRaw(next); setView(next); lastTab = next;
        };
        window.addEventListener('keydown', key, true);
        return () => window.removeEventListener('keydown', key, true);
    }, [build]);
    if (!store) return null;
    const world = store.world, preview = store.preview;
    const ghosts = store.proposal ? ghostIds(world, preview) : [];
    const summary = store.proposal ? diffSummary(world, preview) : '';
    const sel = selected ? preview.entities.find(e => e.id === selected) : undefined;
    const roomCount = preview.entities.filter(e => e.kind === 'room').length;
    return <section className="omo-wb" data-testid="world-builder" data-view={view} data-ghost-preview={ghosts.join(',')} data-diff-summary={summary}
        role="complementary" aria-label="World Builder" onPointerDown={e => e.stopPropagation()}>
        <header className="omo-wb-head">
            <span className="omo-wb-mark" aria-hidden="true"><BuildGlyph name="build" size={16} /></span>
            <div className="omo-wb-title"><strong>World Builder</strong><small>{preview.name || 'This world'} · {preview.shell.width} × {preview.shell.depth} m{roomCount ? ` · ${roomCount} room${roomCount === 1 ? '' : 's'}` : ''}</small></div>
            <button type="button" className="omo-wb-iconbtn" data-testid="builder-undo" title={store.proposal ? 'Undo the last unapplied step (Ctrl+Z)' : store.undoLabel ? `Undo “${store.undoLabel}” (Ctrl+Z)` : 'Nothing to undo'}
                disabled={!store.proposal && !store.canUndo} onMouseDown={e => e.preventDefault()} onClick={() => build.undo()}><BuildGlyph name="undo" size={15} /></button>
        </header>
        <nav className="omo-wb-tabs" role="tablist" aria-label="World Builder tabs">
            <TabButton id="talk" label="Talk" glyph="sparkle" view={view} onPick={setTab} badge={adminState?.busy ? '…' : undefined} />
            <TabButton id="add" label="Add" glyph="plus" view={view} onPick={setTab} />
            <TabButton id="rooms" label="Rooms" glyph="room" view={view} onPick={setTab} badge={roomCount ? String(roomCount) : undefined} />
            {sel && <TabButton id="inspect" label={entityTitle(sel).slice(0, 14)} glyph="cursor" view={view} onPick={setTab} />}
            <span className="omo-wb-tabkey" aria-hidden="true"><kbd>Tab</kbd></span>
        </nav>
        <div className="omo-wb-body" role="tabpanel">
            {view === 'talk' && <TalkTab build={build} admin={admin} state={adminState} world={world} />}
            {view === 'add' && <AddTab build={build} world={preview} />}
            {view === 'rooms' && <RoomsTab build={build} world={preview} />}
            {view === 'inspect' && (props.inspector ?? <p className="omo-wb-empty">Click a thing in the world to inspect it.</p>)}
        </div>
        {props.notice && <div className="omo-wb-notice">{props.notice}</div>}
        {store.proposal && <div className="omo-wb-tray">
            {summary && <p className="omo-wb-summary" data-testid="builder-diff-summary"><span className="omo-wb-ghostdot" aria-hidden="true" />{summary}</p>}
            {props.tray}
        </div>}
    </section>;
}

function TabButton(props: { id: BuilderView; label: string; glyph: string; view: BuilderView; badge?: string; onPick: (v: BuilderView) => void }): React.ReactElement {
    const on = props.view === props.id;
    return <button type="button" role="tab" aria-selected={on} className={`omo-wb-tab${on ? ' is-on' : ''}`} data-testid={`builder-tab-${props.id}`}
        onMouseDown={e => e.preventDefault()} onClick={() => props.onPick(props.id)}>
        {props.glyph === 'plus' ? <Icon name="plus" size={14} /> : <BuildGlyph name={props.glyph} size={14} />}<span>{props.label}</span>{props.badge && <em>{props.badge}</em>}
    </button>;
}

// ------------------------------------------------------------------------------------------------ Talk

function time(at: number): string { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function TalkEntry(props: { entry: AdminEntry; world: WorldSpec; admin: AdminController }): React.ReactElement {
    const { entry, admin, world } = props;
    const plan = entry.plan, proposal = plan?.proposal ?? undefined;
    const diff = React.useMemo(() => {
        if (!proposal || entry.status !== 'proposed' || proposal.baseRevision !== world.revision) return '';
        const r = applyWorldOps(world, proposal.ops); return r.ok ? diffSummary(world, r.world) : '';
    }, [proposal, entry.status, world]);
    return <li className={`omo-wb-msg is-${entry.status}`} data-testid="admin-entry" data-status={entry.status}>
        <div className="omo-wb-you"><span>{entry.prompt}</span><time>{time(entry.at)}</time></div>
        <div className="omo-wb-reply">
            <div className="omo-wb-who"><BuildGlyph name="sparkle" size={12} /> {entry.planner === 'hermes' ? 'Hermes' : 'Planner'}<span className={`omo-wb-status is-${entry.status}`}>{statusText(entry.status)}</span></div>
            {entry.status === 'thinking'
                ? <p className="omo-wb-thinking" role="status">{entry.planner === 'hermes' ? 'Asking Hermes (no tools, one answer)…' : 'Planning…'}</p>
                : <p data-testid="admin-explanation">{proposal ? proposal.summary : plan?.explanation ?? entry.outcome ?? ''}</p>}
            {proposal && <>
                {diff && <p className="omo-wb-diffline" data-testid="builder-plan-diff">{diff}</p>}
                <ol className="omo-wb-steps" data-testid="admin-ops">{proposal.ops.map((op, i) => <li key={i} data-op={op.op}>{plan?.steps[i] ?? op.op}</li>)}</ol>
                {plan && plan.notes.length > 0 && <ul className="omo-wb-notes">{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                {entry.status === 'proposed' && <div className="omo-wb-actions">
                    <button type="button" className="omo-wb-primary" data-testid="admin-apply" onClick={() => admin.apply(entry.id)}><Icon name="check" size={13} /> Apply</button>
                    <button type="button" className="omo-wb-secondary" data-testid="admin-discard" onClick={() => admin.discard(entry.id)}>Discard</button>
                    <small>Ghosts show the plan in the room.</small>
                </div>}
            </>}
            {entry.outcome && entry.status !== 'thinking' && entry.status !== 'proposed' && (proposal || entry.status === 'failed') && <p className={`omo-wb-outcome is-${entry.status}`} role="status">{entry.outcome}</p>}
        </div>
    </li>;
}
function statusText(s: AdminEntry['status']): string {
    return s === 'proposed' ? 'Plan · not applied' : s === 'applied' ? 'Applied' : s === 'discarded' ? 'Discarded' : s === 'stale' ? 'Out of date' : s === 'failed' ? 'Failed' : s === 'answered' ? 'Answer' : 'Thinking';
}

function TalkTab(props: { build: BuildMode; admin?: AdminController; state?: AdminState; world: WorldSpec }): React.ReactElement {
    const { build, admin, state, world } = props;
    const [text, setText] = React.useState('');
    const input = React.useRef<HTMLTextAreaElement>(null);
    const log = React.useRef<HTMLOListElement>(null);
    React.useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
    React.useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [state?.entries.length, state?.entries[state.entries.length - 1]?.status]);
    if (!admin || !state) return <p className="omo-wb-empty">The planner is not available in this window.</p>;
    const hermesOn = state.useHermes && state.hermesConfirmed;
    // A new plan replaces the pending proposal. Never drop unapplied Add-tab placements that way.
    const draft = build.store?.proposal;
    const active = state.entries.find(e => e.id === state.activeId);
    const blockedByDraft = !!draft && !(active?.status === 'proposed' && active.plan?.proposal?.id === draft.id);
    const send = (value = text): void => { const v = value.trim(); if (!v || state.busy || blockedByDraft) return; setText(''); void admin.ask(v); };
    const chips = talkChips(world, build.state.selected);
    return <div className="omo-wb-talk" data-testid="admin-panel" data-planner={hermesOn ? 'hermes' : 'rules'}>
        <div className="omo-wb-planner" role="radiogroup" aria-label="Planner">
            <button type="button" role="radio" aria-checked={!hermesOn && !state.confirmingHermes} data-testid="builder-planner-rules" disabled={state.busy}
                onClick={() => admin.setUseHermes(false)}>Rules</button>
            <button type="button" role="radio" aria-checked={hermesOn || state.confirmingHermes} data-testid="builder-planner-hermes" disabled={state.busy}
                onClick={() => { if (!hermesOn) admin.setUseHermes(true); }}>Hermes</button>
            <span className={`omo-wb-plannerstate${hermesOn ? ' is-hermes' : ''}`} data-testid="builder-planner-state">{hermesOn ? `Hermes on · ${state.profile || 'default'}` : state.confirmingHermes ? 'Hermes · waiting for your OK' : 'Built-in rules · no model'}</span>
        </div>
        {state.confirmingHermes && <div className="omo-wb-confirm" data-testid="admin-hermes-confirm" role="alertdialog" aria-label="Confirm Hermes use">
            <p><strong>Use your local Hermes for world plans?</strong></p>
            <p>Each request runs Hermes once with profile “{state.profile || 'default'}”: no tools, no shell, no files, a 90 second limit. It may use your model account. The answer is only a plan; you still press Apply.</p>
            <label className="omo-wb-field"><span>Profile</span><input data-testid="admin-profile" value={state.profile} maxLength={64} spellCheck={false} onChange={e => admin.setProfile(e.currentTarget.value)} /></label>
            <p className="omo-wb-muted">{state.hermes ? state.hermes.message : 'Checking Hermes…'}</p>
            <div className="omo-wb-actions">
                <button type="button" className="omo-wb-primary" data-testid="admin-hermes-yes" disabled={!state.hermes || !state.hermes.available || state.hermes.busy} onClick={() => admin.confirmHermes()}>Use Hermes</button>
                <button type="button" className="omo-wb-secondary" onClick={() => admin.cancelHermes()}>Keep rules</button>
                <button type="button" className="omo-wb-link" onClick={() => void admin.refreshHermes()}>Check again</button>
            </div>
        </div>}
        <ol className="omo-wb-thread" ref={log} aria-live="polite" data-testid="builder-thread">
            {state.entries.length === 0 && <li className="omo-wb-hello">
                <p>Say what to build. You get a plan and ghosts in the room first. Nothing changes until you press Apply.</p>
            </li>}
            {state.entries.map(entry => <TalkEntry key={entry.id} entry={entry} world={world} admin={admin} />)}
        </ol>
        {state.error && <p className="omo-wb-error" role="alert">{state.error}</p>}
        {blockedByDraft && <p className="omo-wb-error" role="status" data-testid="builder-talk-blocked">You have unapplied changes from the Add tab. Apply or discard them below, then ask.</p>}
        <div className="omo-wb-chips" data-testid="builder-chips">{chips.map(chip => <button type="button" key={chip} disabled={state.busy || blockedByDraft}
            onMouseDown={e => e.preventDefault()} onClick={() => send(chip)}>{chip}</button>)}</div>
        <form className="omo-wb-ask" onSubmit={e => { e.preventDefault(); send(); }}>
            <textarea ref={input} data-testid="admin-prompt" rows={2} maxLength={WORLD_ADMIN_PROMPT_MAX} value={text} placeholder="Add a room for research with 2 desks…"
                onChange={e => setText(e.currentTarget.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); } }} />
            <button type="submit" data-testid="admin-ask" className="omo-wb-send" disabled={!text.trim() || state.busy || blockedByDraft} aria-label="Send">{state.busy ? '…' : <Icon name="chevron-up" size={16} />}</button>
        </form>
        {state.entries.length > 0 && <button type="button" className="omo-wb-link omo-wb-clear" onClick={() => admin.clear()}>Clear conversation</button>}
    </div>;
}

// ------------------------------------------------------------------------------------------------ Add

const TAB_CHOICES: Array<{ kind: TabKind; label: string }> = [{ kind: 'hermes', label: 'Hermes' }, { kind: 'shell', label: 'Shell' }, { kind: 'claude', label: 'Claude' }, { kind: 'codex', label: 'Codex' }];
const ADD_GROUPS: Array<{ title: string; ids: PaletteId[] }> = [
    { title: 'Rooms', ids: ['room-s', 'room-m', 'room-l', 'room'] },
    { title: 'Screens', ids: ['agent-desk', 'shell-desk', 'monitor-wall', 'web-wall', 'mirror', 'review-screen'] },
    { title: 'Furniture & decor', ids: PALETTE.filter(p => p.group === 'Decor').map(p => p.id) }
];

function AddTab(props: { build: BuildMode; world: WorldSpec }): React.ReactElement {
    const { build, world } = props, s = build.state;
    const desks = stations(world);
    const [deskTabs, setDeskTabs] = React.useState<TabKind[]>(() => placementPrefs.deskTabs.length ? [...placementPrefs.deskTabs] : ['hermes', 'shell']);
    const [monitorLink, setMonitorLink] = React.useState(() => placementPrefs.monitorLink);
    const [webUrl, setWebUrl] = React.useState(() => placementPrefs.webHome);
    React.useEffect(() => { setPlacementPrefs({ deskTabs }); }, [deskTabs]);
    React.useEffect(() => { setPlacementPrefs({ monitorLink: desks.some(d => d.id === monitorLink) ? monitorLink : '' }); }, [monitorLink, desks.length]);
    React.useEffect(() => { setPlacementPrefs({ webHome: webUrl }); }, [webUrl]);
    const placing = s.tool === 'place' ? s.item : undefined;
    // A changed option while placing: restart the ghost so it shows the new choice.
    const refresh = (item: PaletteId): void => { if (placing === item) build.choose(item); };
    const urlBad = webUrl.trim() !== '' && !webHomeUrl(webUrl);
    const pick = (item: PaletteItem): void => {
        if (placing === item.id) { build.selectTool(); return; }
        if (item.id === 'web-wall' && urlBad) return;
        build.choose(item.id);
    };
    return <div className="omo-wb-add omo-build-palette" data-testid="build-palette">
        {placing && <div className={`omo-wb-placing${s.ghostValid ? ' is-ok' : ' is-bad'}`} data-testid="builder-placing" role="status">
            <BuildGlyph name={PALETTE.find(p => p.id === placing)?.glyph ?? 'build'} size={16} />
            <span><strong>Placing {PALETTE.find(p => p.id === placing)?.title}</strong><small>{s.ghostValid ? 'Click the floor to place · R turn · Esc stop' : s.ghostReason || 'Aim at the floor'}</small></span>
            <button type="button" className="omo-wb-link" onClick={() => build.selectTool()}>Stop <kbd>Esc</kbd></button>
        </div>}
        {ADD_GROUPS.map(group => <section key={group.title} className="omo-wb-group">
            <h3>{group.title}</h3>
            <div className={`omo-wb-cards${group.title === 'Furniture & decor' ? ' is-small' : ''}`}>{group.ids.map(id => {
                const item = PALETTE.find(p => p.id === id); if (!item) return null;
                const chosen = placing === id;
                const blocked = id === 'mirror' && !desks.length;
                return <button key={id} type="button" className={`omo-wb-card${chosen ? ' is-chosen' : ''}`} data-testid={`build-item-${id}`} aria-pressed={chosen}
                    disabled={blocked || (id === 'web-wall' && urlBad)} title={blocked ? 'Add a desk first. A mirror follows one desk.' : `${item.title} · ${item.hint}`}
                    onMouseDown={e => e.preventDefault()} onClick={() => pick(item)}>
                    <span className="omo-wb-card-art"><BuildGlyph name={item.glyph} size={group.title === 'Furniture & decor' ? 18 : 22} />{id.startsWith('room-') && <b>{id.slice(5).toUpperCase()}</b>}</span>
                    <span className="omo-wb-card-text"><strong>{item.title}</strong><small>{id === 'agent-desk' ? `${deskTabs.length} tab${deskTabs.length === 1 ? '' : 's'}` : id === 'monitor-wall' && monitorLink ? `Follows ${entityTitle(desks.find(d => d.id === monitorLink))}` : id === 'web-wall' && webHomeUrl(webUrl) ? new URL(webHomeUrl(webUrl)).host : item.hint}</small></span>
                </button>;
            })}</div>
            {group.title === 'Screens' && <div className="omo-wb-options">
                <div className="omo-wb-field"><span>Agent desk tabs</span>
                    <div className="omo-wb-toggles" role="group" aria-label="Agent desk tabs">{TAB_CHOICES.map(c => {
                        const on = deskTabs.includes(c.kind);
                        return <button key={c.kind} type="button" aria-pressed={on} data-testid={`builder-desk-tab-${c.kind}`} className={on ? 'is-on' : ''}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => { const next = on ? deskTabs.filter(k => k !== c.kind) : TAB_CHOICES.map(x => x.kind).filter(k => k === c.kind || deskTabs.includes(k)); if (next.length) { setDeskTabs(next); setPlacementPrefs({ deskTabs: next }); refresh('agent-desk'); } }}>{c.label}</button>;
                    })}</div></div>
                <div className="omo-wb-field"><span>Monitor wall follows</span>
                    <OmoSelect testid="builder-monitor-link" ariaLabel="Monitor wall follows" value={desks.some(d => d.id === monitorLink) ? monitorLink : ''}
                        options={[{ value: '', label: 'No desk (its own view)' }, ...desks.map(d => ({ value: d.id, label: entityTitle(d) }))]}
                        onChange={v => { setMonitorLink(v); setPlacementPrefs({ monitorLink: v }); refresh('monitor-wall'); }} /></div>
                <label className="omo-wb-field"><span>Web wall page</span>
                    <input data-testid="builder-web-url" type="url" spellCheck={false} placeholder="https://example.com" value={webUrl} aria-invalid={urlBad}
                        onChange={e => { setWebUrl(e.target.value); setPlacementPrefs({ webHome: e.target.value }); }}
                        onBlur={() => refresh('web-wall')} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
                    {urlBad && <small className="omo-wb-error">Use an http:// or https:// address.</small>}</label>
            </div>}
        </section>)}
        <WorldSizeSection build={build} world={world} />
        <p className="omo-wb-foot">Click a card, then the floor · <kbd>R</kbd> turn · <kbd>Esc</kbd> stop · past the edge the world grows · wall screens snap to walls.</p>
    </div>;
}

// ------------------------------------------------------------------------------------------------ Rooms

const SIDE: Record<WallSide, string> = { back: 'Back', front: 'Front', left: 'Left', right: 'Right' };

/** Stand in the room (walking) and select it (its outline shows in the overview). */
export function jumpToRoom(build: BuildMode, room: RoomEntity): boolean {
    const scene = build.scene, c = sceneControls(scene);
    build.select(room.id);
    if (c && threeOf(scene).navigation === 'walk') { Object.assign(c.pose, jumpPose(room)); scene?.invalidate(); return true; }
    return false;
}

function RoomsTab(props: { build: BuildMode; world: WorldSpec }): React.ReactElement {
    const { build, world } = props;
    const rows = roomRows(world);
    const [editing, setEditing] = React.useState<string | undefined>();
    if (!rows.length) return <div className="omo-wb-rooms" data-testid="builder-rooms">
        <p className="omo-wb-empty">No rooms yet. Add one from the <b>Add</b> tab, or say “add a room for research with 2 desks” in <b>Talk</b>.</p>
    </div>;
    return <div className="omo-wb-rooms" data-testid="builder-rooms">
        <ul>{rows.map(row => {
            const room = world.entities.find((e): e is RoomEntity => e.id === row.id && e.kind === 'room')!;
            return <RoomItem key={row.id} build={build} row={row} room={room} open={editing === row.id} onOpen={() => setEditing(editing === row.id ? undefined : row.id)} />;
        })}</ul>
        <p className="omo-wb-foot">Jump stands you in the room while walking; in the overview it selects the room.</p>
    </div>;
}

function RoomItem(props: { build: BuildMode; row: RoomRow; room: RoomEntity; open: boolean; onOpen: () => void }): React.ReactElement {
    const { build, row, room } = props;
    const [name, setName] = React.useState(row.name);
    React.useEffect(() => setName(row.name), [row.name]);
    const reshape = (p: Partial<{ width: number; depth: number; doors: WallSide[] }>): void =>
        build.reshapeRoom(room.id, { width: room.width, depth: room.depth, doors: [...(room.doors ?? ['front'])], theme: room.theme, ...p });
    const step = (key: 'width' | 'depth', dir: 1 | -1): void => { const v = Math.max(ROOM_MIN, Math.min(ROOM_MAX, room[key] + dir)); if (v !== room[key]) reshape({ [key]: v }); };
    const commit = (): void => { const v = name.trim(); if (v && v !== row.name) build.rename(room.id, v.slice(0, 60)); else setName(row.name); };
    const selected = build.state.selected === room.id;
    return <li className={`omo-wb-room${selected ? ' is-selected' : ''}`} data-testid={`builder-room-${room.id}`}>
        <div className="omo-wb-room-row">
            <span className="omo-wb-room-art"><BuildGlyph name="room" size={16} /></span>
            <button type="button" className="omo-wb-room-name" onClick={props.onOpen} aria-expanded={props.open}>
                <strong>{row.name}</strong><small>{row.width} × {row.depth} m · {row.desks} desk{row.desks === 1 ? '' : 's'}{row.screens ? ` · ${row.screens} screen${row.screens === 1 ? '' : 's'}` : ''}</small>
            </button>
            <button type="button" className="omo-wb-secondary" data-testid={`builder-room-jump-${room.id}`} onMouseDown={e => e.preventDefault()} onClick={() => jumpToRoom(build, room)}>Jump</button>
        </div>
        {props.open && <div className="omo-wb-room-edit">
            <label className="omo-wb-field"><span>Name</span><input data-testid={`builder-room-name-${room.id}`} maxLength={60} value={name}
                onChange={e => setName(e.target.value)} onBlur={commit} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } }} /></label>
            <div className="omo-wb-steppers">
                {(['width', 'depth'] as const).map(k => <div key={k} className="omo-wb-stepper"><span>{k === 'width' ? 'Width' : 'Depth'}</span>
                    <button type="button" aria-label={`Narrower ${k}`} data-testid={`builder-room-${k}-minus-${room.id}`} disabled={room[k] <= ROOM_MIN} onClick={() => step(k, -1)}>−</button>
                    <b>{room[k]} m</b>
                    <button type="button" aria-label={`Wider ${k}`} data-testid={`builder-room-${k}-plus-${room.id}`} disabled={room[k] >= ROOM_MAX} onClick={() => step(k, 1)}>+</button></div>)}
            </div>
            <div className="omo-wb-field"><span>Doorways</span><div className="omo-wb-toggles">{WALL_SIDES.map(side => {
                const on = (room.doors ?? ['front']).includes(side);
                return <button key={side} type="button" aria-pressed={on} className={on ? 'is-on' : ''} data-testid={`builder-room-door-${side}-${room.id}`}
                    onClick={() => { const doors = room.doors ?? ['front']; reshape({ doors: on ? doors.filter(d => d !== side) : WALL_SIDES.filter(d => d === side || doors.includes(d)) }); }}>{SIDE[side]}</button>;
            })}</div></div>
        </div>}
    </li>;
}

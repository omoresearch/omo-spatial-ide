/**
 * Build mode UI (w2 build lane): the Build button, palette, tool bar, inspector, Station Setup
 * dialog and the proposal bar (diff summary + explicit Apply / Discard). All changes go through
 * BuildMode -> WorldStore proposals. Nothing here starts an agent.
 */
import * as React from 'react';
import type { BuildMode } from './build-mode';
import { PALETTE, PaletteItem, PaletteId } from './build-catalog';
import { BuildGlyph } from './build-glyphs';
import { Icon } from './icons';
import { entityTitle, entityNoun } from './world-store';
import type { WorldEntity, StationConfig, StationEntity, TabKind } from '../common/world-model';
import { stations } from '../common/world-model';
import '../../src/browser/build-mode.css';

function useBuild(build: BuildMode): void {
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        const offs = [build.subscribe(bump)];
        let offStore: (() => void) | undefined;
        const follow = (): void => { offStore?.(); offStore = build.store?.onChange(() => bump()); };
        follow(); offs.push(build.subscribe(() => { if (build.store) follow(); }));
        return () => { offs.forEach(off => off()); offStore?.(); };
    }, [build]);
}

const isField = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName));
const deg = (r: number): number => Math.round(((r * 180 / Math.PI) % 360 + 360) % 360);
const m = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** Build toggle for the scene toolbar. Shown while a saved room shows. */
export function BuildToggle(props: { build: BuildMode }): React.ReactElement {
    useBuild(props.build);
    // Follow a rebuilt room even when nothing else re-renders the widget (same pattern as the focus overlay).
    React.useEffect(() => { props.build.sync(); });
    React.useEffect(() => { const id = window.setInterval(() => props.build.sync(), 500); return () => window.clearInterval(id); }, [props.build]);
    const on = props.build.active;
    return <button type="button" className={`omo-build-toggle${on ? ' is-on' : ''}`} data-testid="build-toggle" aria-pressed={on}
        title={on ? 'Leave build mode (B)' : 'Build mode (B)'} onMouseDown={e => e.preventDefault()} onClick={() => props.build.toggle()}>
        <BuildGlyph name="build" size={14} />{on ? 'Building' : 'Build'} <kbd>B</kbd>
    </button>;
}

export function BuildPanel(props: { build: BuildMode }): React.ReactElement | null {
    const build = props.build;
    useBuild(build);
    const store = build.store;
    if (!build.active || !store) return null;
    const s = build.state;
    const world = store.preview;
    const selected = s.selected ? world.entities.find(e => e.id === s.selected) : undefined;
    const setupFor = s.setupFor ? world.entities.find((e): e is StationEntity => e.id === s.setupFor && e.kind === 'station') : undefined;
    const onKey = (event: React.KeyboardEvent): void => {
        if (isField(event.target)) { if (event.key === 'Escape') (event.target as HTMLElement).blur(); return; }
        if (build.handleKey(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); }
    };
    return <div className="omo-build" data-testid="build-mode" data-tool={s.tool} data-ghost={s.ghostAt && (s.tool === 'place' || s.tool === 'move') ? `${s.ghostAt.x},${s.ghostAt.z},${s.ghostAt.rotation},${s.ghostValid}` : ''} data-selected={s.selected ?? ''} data-hover={s.hover ?? ''} onKeyDown={onKey}>
        <div className="omo-build-topbar" role="toolbar" aria-label="Build tools">
            <span className="omo-build-badge"><BuildGlyph name="build" size={14} /> Build</span>
            <ToolButton glyph="cursor" label="Select" keyHint="V" active={s.tool === 'select'} onClick={() => build.selectTool()} />
            <ToolButton glyph="move" label="Move" keyHint="M" active={s.tool === 'move'} disabled={!selected} onClick={() => build.startMove()} />
            <ToolButton glyph="rotate" label="Turn" keyHint="R" disabled={!selected && s.tool !== 'place'} onClick={() => build.rotate(1)} />
            <ToolButton glyph="link" label="Link" keyHint="K" active={s.tool === 'link'} onClick={() => build.linkTool()} />
            <ToolButton glyph="trash" label="Remove" keyHint="Del" disabled={!selected} danger onClick={() => build.remove()} />
            <span className="omo-build-sep" />
            <ToolButton glyph="undo" label={store.proposal ? 'Undo step' : store.undoLabel ? `Undo “${store.undoLabel}”` : 'Undo'} keyHint="Ctrl+Z" iconOnly disabled={!store.proposal && !store.canUndo} onClick={() => build.undo()} />
            <ToolButton glyph="redo" label={store.redoLabel ? `Redo “${store.redoLabel}”` : 'Redo'} keyHint="Ctrl+Shift+Z" iconOnly disabled={!!store.proposal || !store.canRedo} onClick={() => build.redo()} />
            <span className="omo-build-sep" />
            <button type="button" className="omo-build-exit" data-testid="build-exit" onClick={() => build.exit()} title="Leave build mode (B)"><Icon name="x" size={14} /> Done</button>
        </div>
        <Palette build={build} />
        <div className={`omo-build-hint${s.tool === 'place' || s.tool === 'move' ? (s.ghostValid ? ' is-ok' : ' is-bad') : ''}`} role="status" data-testid="build-hint">{s.hint}</div>
        {s.notice && <div className={`omo-build-notice is-${s.noticeTone}`} role={s.noticeTone === 'warn' ? 'alert' : 'status'} data-testid="build-notice">{s.noticeTone === 'warn' ? <Icon name="alert" size={14} /> : <Icon name="check" size={14} />}{s.notice}</div>}
        {!s.worldRenderer && <div className="omo-build-renderer-note" data-testid="build-renderer-note">Blueprint view · New things show as outlines until the world renderer draws them.</div>}
        {selected && !setupFor && <Inspector key={selected.id} build={build} entity={selected} />}
        {store.proposal && <ProposalBar build={build} />}
        {setupFor && <StationSetup key={setupFor.id} build={build} entity={setupFor} />}
    </div>;
}

function ToolButton(props: { glyph: string; label: string; keyHint?: string; active?: boolean; disabled?: boolean; danger?: boolean; iconOnly?: boolean; onClick: () => void }): React.ReactElement {
    return <button type="button" className={`omo-build-tool${props.active ? ' is-active' : ''}${props.danger ? ' is-danger' : ''}`} aria-pressed={props.active} disabled={props.disabled}
        title={props.keyHint ? `${props.label} (${props.keyHint})` : props.label} aria-label={props.label} onMouseDown={e => e.preventDefault()} onClick={props.onClick}>
        <BuildGlyph name={props.glyph} size={16} />{!props.iconOnly && <span>{props.label}</span>}
    </button>;
}

function Palette(props: { build: BuildMode }): React.ReactElement {
    const { build } = props, s = build.state;
    const groups: Array<PaletteItem['group']> = ['Stations', 'Screens', 'Decor'];
    const hasDesk = !!build.store && stations(build.store.preview).length > 0;
    return <aside className="omo-build-palette" aria-label="Build palette" data-testid="build-palette">
        {groups.map(group => <section key={group} className={`omo-build-group is-${group.toLowerCase()}`}>
            <h3>{group}</h3>
            <div className="omo-build-items">{PALETTE.filter(item => item.group === group).map(item => {
                const chosen = s.tool === 'place' && s.item === item.id;
                const blocked = item.id === 'mirror' && !hasDesk;
                return <button key={item.id} type="button" className={`omo-build-item${chosen ? ' is-chosen' : ''}`} data-testid={`build-item-${item.id}`} aria-pressed={chosen}
                    disabled={blocked} title={blocked ? 'Add a desk first. A mirror follows one desk.' : `${item.title} · ${item.hint}`}
                    onMouseDown={e => e.preventDefault()} onClick={() => chosen ? build.selectTool() : build.choose(item.id as PaletteId)}>
                    <span className="omo-build-item-art"><BuildGlyph name={item.glyph} size={group === 'Decor' ? 20 : 24} /></span>
                    <span className="omo-build-item-text"><strong>{item.title}</strong><small>{item.hint}</small></span>
                </button>;
            })}</div>
        </section>)}
        <p className="omo-build-palette-foot">Place · <kbd>R</kbd> turn · <kbd>Esc</kbd> stop. Changes wait for <b>Apply</b>.</p>
    </aside>;
}

function NumberField(props: { label: string; value: number; min: number; max: number; step: number; disabled?: boolean; onCommit: (n: number) => void; testid?: string }): React.ReactElement {
    const [text, setText] = React.useState(m(props.value));
    React.useEffect(() => setText(m(props.value)), [props.value]);
    const commit = (): void => { const n = Number(text); if (Number.isFinite(n) && n >= props.min && n <= props.max) { if (n !== props.value) props.onCommit(Math.round(n * 100) / 100); } else setText(m(props.value)); };
    return <label className="omo-build-num"><span>{props.label}</span>
        <input type="number" inputMode="decimal" data-testid={props.testid} min={props.min} max={props.max} step={props.step} value={text} disabled={props.disabled}
            onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} /><em>m</em></label>;
}

function Inspector(props: { build: BuildMode; entity: WorldEntity }): React.ReactElement {
    const { build, entity: e } = props;
    const locked = e.kind === 'station' && e.station.locked;
    const [label, setLabel] = React.useState(e.label ?? entityTitle(e));
    React.useEffect(() => setLabel(e.label ?? entityTitle(e)), [e.label]);
    const world = build.store!.preview;
    const deskList = stations(world);
    const linkTarget = e.kind === 'mirror' || e.kind === 'monitor-wall' ? e.link : undefined;
    const followers = e.kind === 'station' ? world.entities.filter(x => (x.kind === 'mirror' || x.kind === 'monitor-wall') && x.link === e.id) : [];
    const commitLabel = (): void => { const v = label.trim(); if (v && v !== (e.label ?? entityTitle(e))) build.rename(e.id, v); else setLabel(e.label ?? entityTitle(e)); };
    return <aside className={`omo-build-inspector${locked ? ' is-locked' : ''}`} aria-label={`Selected: ${entityTitle(e)}`} data-testid="build-inspector" data-entity={e.id}>
        <header>
            <span className={`omo-build-kind is-${e.kind}`}><BuildGlyph name={glyphFor(e)} size={18} /></span>
            <div><small>{entityNoun(e).toUpperCase()}</small><strong>{entityTitle(e)}</strong></div>
            {locked && <span className="omo-build-lock" data-testid="build-locked"><Icon name="lock" size={12} /> Locked</span>}
            <button type="button" className="omo-build-close" aria-label="Deselect" onClick={() => build.select(undefined)}><Icon name="x" size={14} /></button>
        </header>
        {locked && <p className="omo-build-locknote">This desk is locked. It refuses moves, renames and removal. Unlock it to edit.</p>}
        <label className="omo-build-field"><span>Name</span>
            <input data-testid="build-rename" maxLength={60} value={label} disabled={locked} onChange={ev => setLabel(ev.target.value)} onBlur={commitLabel} onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); commitLabel(); } }} /></label>
        <div className="omo-build-readout"><span>x {m(e.transform.x)}</span><span>z {m(e.transform.z)}</span><span>{deg(e.transform.rotation)}°</span></div>
        <div className="omo-build-actions">
            <button type="button" disabled={locked} onClick={() => build.startMove()}><BuildGlyph name="move" size={14} /> Move</button>
            <button type="button" disabled={locked} onClick={() => build.rotate(1)}><BuildGlyph name="rotate" size={14} /> Turn</button>
            <button type="button" className="is-danger" data-testid="build-remove" disabled={locked} onClick={() => build.remove()}><BuildGlyph name="trash" size={14} /> Remove</button>
        </div>
        {(e.kind === 'monitor-wall' || e.kind === 'web-wall') && <div className="omo-build-size">
            <NumberField label="Width" testid="build-width" value={e.width} min={e.kind === 'web-wall' ? 0.8 : 0.6} max={8} step={0.1} onCommit={n => build.resize(e.id, { width: n, height: e.height, elevation: e.elevation })} />
            <NumberField label="Height" testid="build-height" value={e.height} min={e.kind === 'web-wall' ? 0.6 : 0.4} max={4} step={0.1} onCommit={n => build.resize(e.id, { width: e.width, height: n, elevation: e.elevation })} />
            <NumberField label="Lift" value={e.elevation} min={0} max={3} step={0.05} onCommit={n => build.resize(e.id, { width: e.width, height: e.height, elevation: n })} />
        </div>}
        {(e.kind === 'monitor-wall' || e.kind === 'mirror') && <label className="omo-build-field"><span>Follows</span>
            <select data-testid="build-link-select" value={linkTarget ?? ''} onChange={ev => ev.target.value ? build.link(e.id, ev.target.value) : build.unlink(e.id)}>
                {e.kind === 'monitor-wall' && <option value="">Nothing (its own view)</option>}
                {deskList.map(d => <option key={d.id} value={d.id}>{entityTitle(d)}</option>)}
            </select></label>}
        {e.kind === 'station' && <>
            <div className="omo-build-station-sum">
                <span className={`omo-build-chip is-${e.station.kind}`}>{e.station.kind === 'hermes' ? 'Agent desk' : 'Shell desk'}</span>
                <span className="omo-build-chip">{e.station.profile ? `Profile ${e.station.profile}` : 'Default profile'}</span>
                <span className="omo-build-chip">{e.station.tabs.length} tab{e.station.tabs.length === 1 ? '' : 's'}</span>
                {followers.length > 0 && <span className="omo-build-chip is-gold"><BuildGlyph name="link" size={12} /> {followers.length} linked</span>}
            </div>
            <div className="omo-build-actions">
                <button type="button" className="is-primary" data-testid="build-open-setup" onClick={() => build.openSetup(e.id)}><BuildGlyph name="setup" size={14} /> Station Setup</button>
                <button type="button" data-testid="build-link-from" onClick={() => build.linkTool()}><BuildGlyph name="link" size={14} /> Link screens</button>
                <button type="button" data-testid="build-lock-toggle" onClick={() => build.setLocked(e.id, !locked)}>{locked ? <><BuildGlyph name="unlock" size={14} /> Unlock</> : <><Icon name="lock" size={14} /> Lock</>}</button>
            </div>
        </>}
    </aside>;
}

function glyphFor(e: WorldEntity): string {
    switch (e.kind) {
        case 'station': return e.station.kind === 'hermes' ? 'desk-agent' : 'desk-shell';
        case 'monitor-wall': return 'monitor-wall';
        case 'web-wall': return 'web-wall';
        case 'mirror': return 'mirror';
        case 'review-screen': return 'review';
        case 'decor': return e.decor;
    }
}

function ProposalBar(props: { build: BuildMode }): React.ReactElement | null {
    const { build } = props, store = build.store!, p = store.proposal;
    const [open, setOpen] = React.useState(false);
    if (!p) return null;
    const lines = p.diff.length ? p.diff : ['No visible change.'];
    const shown = open ? lines : lines.slice(0, 4);
    return <section className="omo-build-proposal" aria-label="Pending changes" data-testid="build-proposal">
        <header><span className="omo-build-dot" /><strong>{lines.length} pending change{lines.length === 1 ? '' : 's'}</strong><small>Not saved until you apply. Nothing starts.</small></header>
        <ul data-testid="build-diff">{shown.map((line, i) => <li key={i} className={/^Add /.test(line) ? 'is-add' : /^Remove /.test(line) ? 'is-remove' : /^Link /.test(line) ? 'is-link' : /^(Lock|Unlock) /.test(line) ? 'is-lock' : ''}>{line}</li>)}</ul>
        {lines.length > 4 && <button type="button" className="omo-build-more" onClick={() => setOpen(!open)}>{open ? 'Show less' : `Show ${lines.length - 4} more`}</button>}
        <footer>
            <button type="button" className="omo-build-discard" data-testid="build-discard" onClick={() => build.discard()}>Discard</button>
            <button type="button" className="omo-build-apply" data-testid="build-apply" onClick={() => build.apply()}><Icon name="check" size={14} /> Apply <kbd>Ctrl+↵</kbd></button>
        </footer>
    </section>;
}

const TAB_KINDS: Array<{ kind: TabKind; label: string }> = [{ kind: 'hermes', label: 'Hermes' }, { kind: 'shell', label: 'Shell' }, { kind: 'claude', label: 'Claude' }, { kind: 'codex', label: 'Codex' }];

/** Station Setup (Minecraft parity): name, kind, Hermes profile, starting tabs, Lock. Saves as a proposal step. */
function StationSetup(props: { build: BuildMode; entity: StationEntity }): React.ReactElement {
    const { build, entity } = props, cur = entity.station;
    const [draft, setDraft] = React.useState<StationConfig>(() => ({ ...cur, tabs: cur.tabs.map(t => ({ ...t })) }));
    const locked = cur.locked;
    const profiles = build.profiles();
    const knownProfile = !draft.profile || profiles.includes(draft.profile);
    const nameOk = draft.name.trim().length > 0 && draft.name.length <= 60;
    const tabsOk = draft.tabs.length >= 1 && draft.tabs.length <= 8 && draft.tabs.every(t => t.name.trim().length > 0 && t.name.length <= 40);
    const first = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => { first.current?.focus(); }, []);
    const patch = (p: Partial<StationConfig>): void => setDraft(d => ({ ...d, ...p }));
    const setTab = (i: number, p: Partial<StationConfig['tabs'][number]>): void => setDraft(d => ({ ...d, tabs: d.tabs.map((t, j) => j === i ? { ...t, ...p } : t) }));
    const save = (): void => { if (nameOk && tabsOk) build.saveSetup(entity.id, { ...draft, name: draft.name.trim(), tabs: draft.tabs.map(t => ({ name: t.name.trim(), kind: t.kind })) }); };
    return <div className="omo-build-dialog-scrim" onMouseDown={ev => { if (ev.target === ev.currentTarget) build.closeSetup(); }}>
        <section className="omo-build-dialog" role="dialog" aria-modal="true" aria-labelledby="omo-station-setup-title" data-testid="station-setup"
            onKeyDown={ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); build.closeSetup(); } if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ev.stopPropagation(); save(); } }}>
            <header>
                <span className={`omo-build-kind is-station`}><BuildGlyph name={draft.kind === 'hermes' ? 'desk-agent' : 'desk-shell'} size={20} /></span>
                <div><small>STATION SETUP</small><h2 id="omo-station-setup-title">{entityTitle(entity)}</h2></div>
                <button type="button" className="omo-build-close" aria-label="Close Station Setup" onClick={() => build.closeSetup()}><Icon name="x" size={16} /></button>
            </header>
            {locked && <div className="omo-build-locknote is-banner" data-testid="station-setup-locked"><Icon name="lock" size={14} /> Locked. Settings are read-only. Unlock to change them; nothing running is stopped.</div>}
            <fieldset disabled={locked}>
                <label className="omo-build-field"><span>Name</span><input ref={first} data-testid="setup-name" maxLength={60} value={draft.name} onChange={ev => patch({ name: ev.target.value })} aria-invalid={!nameOk} /></label>
                <div className="omo-build-field"><span>Kind</span>
                    <div className="omo-build-seg" role="radiogroup" aria-label="Desk kind">
                        <button type="button" role="radio" aria-checked={draft.kind === 'hermes'} data-testid="setup-kind-hermes" onClick={() => patch({ kind: 'hermes' })}><BuildGlyph name="desk-agent" size={14} /> Agent (Hermes)</button>
                        <button type="button" role="radio" aria-checked={draft.kind === 'shell'} data-testid="setup-kind-shell" onClick={() => patch({ kind: 'shell' })}><BuildGlyph name="desk-shell" size={14} /> Shell</button>
                    </div></div>
                <label className="omo-build-field"><span>Hermes profile</span>
                    <select data-testid="setup-profile" value={draft.profile ?? ''} onChange={ev => patch({ profile: ev.target.value || undefined })}>
                        <option value="">Workspace default</option>
                        {profiles.map(p => <option key={p} value={p}>{p}</option>)}
                        {!knownProfile && draft.profile && <option value={draft.profile}>{draft.profile} (not on this computer)</option>}
                    </select>
                    <small>{profiles.length ? `${profiles.length} profile${profiles.length === 1 ? '' : 's'} on this computer. Only the name is saved.` : 'No Hermes profiles found yet. Open a desk once to read them.'}</small></label>
                <div className="omo-build-field"><span>Starting tabs</span>
                    <ol className="omo-build-tabs" data-testid="setup-tabs">{draft.tabs.map((tab, i) => <li key={i}>
                        <span className="omo-build-tabnum">{i + 1}</span>
                        <input aria-label={`Tab ${i + 1} name`} maxLength={40} value={tab.name} onChange={ev => setTab(i, { name: ev.target.value })} />
                        <select aria-label={`Tab ${i + 1} kind`} value={tab.kind} onChange={ev => setTab(i, { kind: ev.target.value as TabKind })}>{TAB_KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select>
                        <button type="button" aria-label={`Remove tab ${i + 1}`} disabled={draft.tabs.length <= 1} onClick={() => setDraft(d => ({ ...d, tabs: d.tabs.filter((_, j) => j !== i) }))}><Icon name="x" size={12} /></button>
                    </li>)}</ol>
                    <button type="button" className="omo-build-addtab" data-testid="setup-add-tab" disabled={draft.tabs.length >= 8} onClick={() => setDraft(d => ({ ...d, tabs: [...d.tabs, { name: d.kind === 'hermes' && !d.tabs.some(t => t.kind === 'hermes') ? 'Hermes' : `Shell ${d.tabs.length + 1}`, kind: d.kind === 'hermes' && !d.tabs.some(t => t.kind === 'hermes') ? 'hermes' : 'shell' }] }))}><Icon name="plus" size={12} /> Add tab</button>
                    <small>A plan only. Each agent tab still asks you before it starts.</small></div>
            </fieldset>
            <label className={`omo-build-lockrow${draft.locked ? ' is-on' : ''}`}>
                <input type="checkbox" data-testid="setup-lock" checked={draft.locked} onChange={ev => patch({ locked: ev.target.checked })} />
                <span className="omo-build-switch" aria-hidden="true" /><span><strong><Icon name="lock" size={12} /> Lock this desk</strong><small>Refuses moves, renames, removal and setup changes until unlocked.</small></span>
            </label>
            <footer>
                <button type="button" className="omo-build-discard" onClick={() => build.closeSetup()}>Cancel</button>
                <button type="button" className="omo-build-apply" data-testid="setup-save" disabled={!nameOk || !tabsOk || (locked && draft.locked)} onClick={save}>
                    {locked && !draft.locked ? 'Unlock' : 'Add to changes'}</button>
            </footer>
        </section>
    </div>;
}

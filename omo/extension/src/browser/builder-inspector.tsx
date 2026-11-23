/**
 * builder-ui — extra rows for the build inspector: the page a web wall opens, the tab layout of a desk,
 * Duplicate, and Delete with a confirmation step. Every change is a WorldOps proposal step through
 * BuildMode (nothing is saved until Apply; Ctrl+Z drops the step).
 */
import * as React from 'react';
import type { BuildMode } from './build-mode';
import type { TabKind, WorldEntity } from '../common/world-model';
import { BuildGlyph } from './build-glyphs';
import { Icon } from './icons';
import { entityTitle } from './world-store';
import { tabsFromKinds, webHomeUrl } from './build-catalog';
import { duplicateOps } from './builder-helpers';

const TAB_CHOICES: Array<{ kind: TabKind; label: string }> = [{ kind: 'hermes', label: 'Hermes' }, { kind: 'shell', label: 'Shell' }, { kind: 'claude', label: 'Claude' }, { kind: 'codex', label: 'Codex' }];

export function InspectorExtras(props: { build: BuildMode; entity: WorldEntity }): React.ReactElement {
    const { build, entity: e } = props;
    const locked = e.kind === 'station' && e.station.locked;
    const [confirming, setConfirming] = React.useState(false);
    React.useEffect(() => setConfirming(false), [e.id]);
    const world = build.store?.preview;
    const dup = world ? duplicateOps(world, e.id) : undefined;
    return <div className="omo-wb-inspect" data-testid="builder-inspector-extras">
        {e.kind === 'web-wall' && <WebHome build={build} id={e.id} home={e.home ?? ''} entity={e} />}
        {e.kind === 'station' && <DeskTabs build={build} entity={e} locked={locked} />}
        <div className="omo-build-actions">
            <button type="button" data-testid="builder-duplicate" disabled={!dup} title={dup ? 'Duplicate next to it' : 'Rooms cannot be duplicated'}
                onClick={() => { if (dup && build.proposeOps(dup, `Duplicate ${entityTitle(e)}`)) { const add = dup[0]; if (add.op === 'add') build.select(add.entity.id); } }}><Icon name="plus" size={14} /> Duplicate</button>
            {!confirming
                ? <button type="button" className="is-danger" data-testid="build-remove" disabled={locked} onClick={() => setConfirming(true)}><BuildGlyph name="trash" size={14} /> Delete…</button>
                : <span className="omo-wb-confirmrow" data-testid="builder-delete-confirm">
                    <span>Delete “{entityTitle(e)}”{e.kind === 'station' ? ' and its mirrors' : ''}?</span>
                    <button type="button" className="is-danger" data-testid="builder-delete-yes" onClick={() => { setConfirming(false); build.remove(); }}>Delete</button>
                    <button type="button" onClick={() => setConfirming(false)}>Keep</button>
                </span>}
        </div>
    </div>;
}

function WebHome(props: { build: BuildMode; id: string; home: string; entity: WorldEntity }): React.ReactElement {
    const { build, entity } = props;
    const [text, setText] = React.useState(props.home);
    React.useEffect(() => setText(props.home), [props.home]);
    const url = webHomeUrl(text), bad = text.trim() !== '' && !url;
    const commit = (): void => {
        if (bad || url === props.home || entity.kind !== 'web-wall') { if (bad) return; setText(props.home); return; }
        // No op edits `home` yet (NOTES-builder-ui.md): replace the wall with the same id, size and place.
        const next = { ...entity, ...(url ? { home: url } : {}) };
        if (!url) delete (next as { home?: string }).home;
        build.proposeOps([{ op: 'remove', id: entity.id }, { op: 'add', entity: next }], url ? `Web wall page → ${new URL(url).host}` : 'Web wall page cleared');
    };
    return <label className="omo-build-field"><span>Page</span>
        <input data-testid="builder-web-home" type="url" spellCheck={false} placeholder="https://example.com" value={text} aria-invalid={bad}
            onChange={ev => setText(ev.target.value)} onBlur={commit} onKeyDown={ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); commit(); } }} />
        <small>{bad ? 'Use an http:// or https:// address.' : 'The page this wall opens. Saved on Apply.'}</small></label>;
}

function DeskTabs(props: { build: BuildMode; entity: Extract<WorldEntity, { kind: 'station' }>; locked: boolean }): React.ReactElement {
    const { build, entity, locked } = props;
    const tabs = entity.station.tabs;
    const kinds = TAB_CHOICES.map(c => c.kind).filter(k => tabs.some(t => t.kind === k));
    const toggle = (kind: TabKind): void => {
        const on = kinds.includes(kind);
        if (on && tabs.length <= 1) return;
        const next = on ? tabs.filter(t => t.kind !== kind) : [...tabs, ...tabsFromKinds([kind]).map(t => ({ ...t, name: tabs.some(x => x.name === t.name) ? `${t.name} ${tabs.length + 1}` : t.name }))];
        if (!next.length || next.length > 8) return;
        build.proposeOps([{ op: 'update-station', id: entity.id, station: { tabs: next } }], `${entityTitle(entity)} tabs: ${next.map(t => t.name).join(', ')}`);
    };
    return <div className="omo-build-field"><span>Tab layout</span>
        <div className="omo-wb-toggles" role="group" aria-label="Desk tabs" data-testid="builder-desk-tabs">{TAB_CHOICES.map(c => {
            const on = kinds.includes(c.kind);
            return <button key={c.kind} type="button" aria-pressed={on} className={on ? 'is-on' : ''} disabled={locked || (on && tabs.length <= 1)}
                data-testid={`builder-inspect-tab-${c.kind}`} onClick={() => toggle(c.kind)}>{c.label}</button>;
        })}</div>
        <small>{tabs.map(t => t.name).join(' · ')}. Station Setup renames and orders tabs.</small></div>;
}

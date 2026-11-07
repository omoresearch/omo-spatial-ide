import * as React from 'react';
import type { AgentKind, IdleSleepSettings } from '../common/runtime-protocol';
import { AGENT_LABELS } from './runtime-console-controller';
import type { RecipeStationId, StationRecipe, StationRecipeTab } from './station-recipe';

export function StationRecipePanel(props: {
    recipes: StationRecipe[];
    stationId: RecipeStationId;
    /** w2:runtime — display name of this station (any station in the world). */
    stationName?: string;
    /** w2:runtime — the station's own StationConfig tabs as a recipe (offered, never auto-applied). */
    setup?: StationRecipe;
    /** w2:runtime — locked in the world's Station Setup (unlock there, not here). */
    worldLocked?: boolean;
    profile: string;
    onSave: (recipe: Omit<StationRecipe, 'version' | 'id'>) => void;
    onApply: (recipe: StationRecipe) => void;
    onDelete: (recipe: StationRecipe) => void;
    onClose: () => void;
    /** Host idle-sleep setting (undefined while the runtime is not ready). */
    idleSleep?: IdleSleepSettings;
    onIdleSleep?: (authorized: boolean, afterSeconds: number) => void;
    /** Station Lock for this desk. */
    locked?: boolean;
    onLock?: (locked: boolean) => void;
    /** w2:templates — export the saved world with this desk's setup (from the form) as a v2 preset. */
    onExportSetup?: (setup: { name: string; profile: string; tabs: StationRecipeTab[]; locked: boolean }) => void;
}): React.ReactElement {
    const frozen = !!props.locked;
    const [sleepMinutes, setSleepMinutes] = React.useState(Math.max(1, Math.round((props.idleSleep?.afterSeconds || 900) / 60)));
    const [name, setName] = React.useState('');
    const [profile, setProfile] = React.useState(props.profile);
    const [tabs, setTabs] = React.useState<StationRecipeTab[]>([{ kind: 'shell' }]);
    const add = (kind: AgentKind): void => { if (tabs.length < 8) setTabs([...tabs, { kind }]); };
    return <section className="omo-recipe-panel" data-testid="station-recipe-panel" aria-label="Station recipes">
        <div className="omo-console-row"><strong>Station recipes · {props.stationName ?? (props.stationId === 'terminal' ? 'Desk one' : props.stationId === 'terminal-2' ? 'Desk two' : props.stationId)}</strong><button type="button" data-testid="station-recipe-close" onClick={props.onClose}>Close</button></div>
        <p className="omo-console-hint">Saved for this project only. Save never launches a CLI. Apply shows the exact tabs and asks once before any agent starts.</p>
        <div className="omo-console-row" data-testid="station-lock">
            <label title="Locked desks refuse recipe and room-layout edits and tab close. Nothing running is stopped.">
                <input type="checkbox" data-testid="station-lock-toggle" disabled={!props.onLock} checked={frozen} onChange={event => props.onLock?.(event.target.checked)} /> Lock this desk</label>
            {frozen && <small data-testid="station-lock-note" role="note">🔒 Locked: recipes, room layout and tab close are blocked for this desk.</small>}
            {props.worldLocked && <small data-testid="station-world-lock-note" role="note">Locked in Station Setup. Unlock it in build mode.</small>}
        </div>
        {props.setup && <div className="omo-console-row" data-testid="station-setup-recipe"><span><strong>Station setup</strong> · {props.setup.profile} · {props.setup.tabs.map(tab => tab.name || AGENT_LABELS[tab.kind]).join(', ')}</span>
            <button type="button" data-testid="station-setup-apply" onClick={() => props.onApply(props.setup!)}>Apply…</button></div>}
        <div className="omo-console-row" data-testid="station-idle-sleep">
            <label title="Off by default. Only idle Hermes tabs you are not watching sleep; busy tabs and drafts block it. Looking at the desk wakes them.">
                <input type="checkbox" data-testid="station-idle-sleep-toggle" disabled={!props.idleSleep || !props.onIdleSleep} checked={!!props.idleSleep?.authorized}
                    onChange={event => props.onIdleSleep?.(event.target.checked, sleepMinutes * 60)} /> Let idle unseen Hermes tabs sleep after</label>
            <input type="number" aria-label="Idle sleep minutes" data-testid="station-idle-sleep-minutes" min={1} max={1440} value={sleepMinutes} style={{ width: 52 }}
                onChange={event => setSleepMinutes(Math.max(1, Math.min(1440, Number(event.target.value) || 1)))}
                onBlur={() => { if (props.idleSleep?.authorized) props.onIdleSleep?.(true, sleepMinutes * 60); }} /> min
            {!props.idleSleep && <small>(open a desk first)</small>}
        </div>
        <form data-testid="station-recipe-form" onSubmit={event => { event.preventDefault(); if (frozen) return; props.onSave({ name, stationId: props.stationId, profile, tabs }); setName(''); }}>
            <label>Name <input data-testid="station-recipe-name" maxLength={48} value={name} onChange={event => setName(event.target.value)} required /></label>
            <label>Hermes profile <input data-testid="station-recipe-profile" maxLength={80} value={profile} onChange={event => setProfile(event.target.value)} /></label>
            <div className="omo-console-row"><span>Initial tabs</span>{(['shell', 'hermes', 'claude', 'codex'] as AgentKind[]).map(kind => <button type="button" key={kind} data-testid={`station-recipe-add-${kind}`} disabled={tabs.length >= 8} onClick={() => add(kind)}>+ {AGENT_LABELS[kind]}</button>)}</div>
            <ul data-testid="station-recipe-tabs">{tabs.map((tab, index) => <li key={`${tab.kind}-${index}`}>{AGENT_LABELS[tab.kind]} <button type="button" aria-label={`Remove ${AGENT_LABELS[tab.kind]} tab ${index + 1}`} onClick={() => setTabs(tabs.filter((_, i) => i !== index))}>×</button></li>)}</ul>
            <button data-testid="station-recipe-save" disabled={frozen || !name.trim() || !profile.trim() || !tabs.length}>Save recipe</button>
            {props.onExportSetup && <button type="button" data-testid="station-setup-export" title="Exports desks, walls and this desk's setup. Never workspace ids, tokens or paths." disabled={!tabs.length} onClick={() => props.onExportSetup?.({ name: name.trim() || (props.stationId === 'terminal' ? 'Desk one' : 'Desk two'), profile, tabs, locked: frozen })}>Export desk setup (world v2)</button>}{/* w2:templates */}
        </form>
        <div data-testid="station-recipe-list">{props.recipes.map(recipe => <article key={recipe.id} className="omo-console-row"><span><strong>{recipe.name}</strong> · {recipe.profile} · {recipe.tabs.map(tab => AGENT_LABELS[tab.kind]).join(', ')}</span><button type="button" data-testid="station-recipe-apply" disabled={frozen} onClick={() => props.onApply(recipe)}>Apply…</button><button type="button" data-testid="station-recipe-delete" disabled={frozen} onClick={() => props.onDelete(recipe)}>Delete</button></article>)}</div>
    </section>;
}

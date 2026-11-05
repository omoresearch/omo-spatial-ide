import * as React from 'react';
import type { AgentKind } from '../common/runtime-protocol';
import { AGENT_LABELS } from './runtime-console-controller';
import type { RecipeStationId, StationRecipe, StationRecipeTab } from './station-recipe';

export function StationRecipePanel(props: {
    recipes: StationRecipe[];
    stationId: RecipeStationId;
    profile: string;
    onSave: (recipe: Omit<StationRecipe, 'version' | 'id'>) => void;
    onApply: (recipe: StationRecipe) => void;
    onDelete: (recipe: StationRecipe) => void;
    onClose: () => void;
}): React.ReactElement {
    const [name, setName] = React.useState('');
    const [profile, setProfile] = React.useState(props.profile);
    const [tabs, setTabs] = React.useState<StationRecipeTab[]>([{ kind: 'shell' }]);
    const add = (kind: AgentKind): void => { if (tabs.length < 8) setTabs([...tabs, { kind }]); };
    return <section className="omo-recipe-panel" data-testid="station-recipe-panel" aria-label="Station recipes">
        <div className="omo-console-row"><strong>Station recipes · {props.stationId === 'terminal' ? 'Desk one' : 'Desk two'}</strong><button type="button" data-testid="station-recipe-close" onClick={props.onClose}>Close</button></div>
        <p className="omo-console-hint">Saved for this project only. Save never launches a CLI. Apply shows the exact tabs and asks once before any agent starts.</p>
        <form data-testid="station-recipe-form" onSubmit={event => { event.preventDefault(); props.onSave({ name, stationId: props.stationId, profile, tabs }); setName(''); }}>
            <label>Name <input data-testid="station-recipe-name" maxLength={48} value={name} onChange={event => setName(event.target.value)} required /></label>
            <label>Hermes profile <input data-testid="station-recipe-profile" maxLength={80} value={profile} onChange={event => setProfile(event.target.value)} /></label>
            <div className="omo-console-row"><span>Initial tabs</span>{(['shell', 'hermes', 'claude', 'codex'] as AgentKind[]).map(kind => <button type="button" key={kind} data-testid={`station-recipe-add-${kind}`} disabled={tabs.length >= 8} onClick={() => add(kind)}>+ {AGENT_LABELS[kind]}</button>)}</div>
            <ul data-testid="station-recipe-tabs">{tabs.map((tab, index) => <li key={`${tab.kind}-${index}`}>{AGENT_LABELS[tab.kind]} <button type="button" aria-label={`Remove ${AGENT_LABELS[tab.kind]} tab ${index + 1}`} onClick={() => setTabs(tabs.filter((_, i) => i !== index))}>×</button></li>)}</ul>
            <button data-testid="station-recipe-save" disabled={!name.trim() || !profile.trim() || !tabs.length}>Save recipe</button>
        </form>
        <div data-testid="station-recipe-list">{props.recipes.map(recipe => <article key={recipe.id} className="omo-console-row"><span><strong>{recipe.name}</strong> · {recipe.profile} · {recipe.tabs.map(tab => AGENT_LABELS[tab.kind]).join(', ')}</span><button type="button" data-testid="station-recipe-apply" onClick={() => props.onApply(recipe)}>Apply…</button><button type="button" data-testid="station-recipe-delete" onClick={() => props.onDelete(recipe)}>Delete</button></article>)}</div>
    </section>;
}

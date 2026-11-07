/**
 * w2:templates — World preset panel: pick a world template, add room kits, preview an imported
 * world, and export the saved world as a v2 preset. Everything here only changes a PREVIEW; the
 * existing "Save room" button applies it and "Back to my room" discards it. Nothing here starts
 * an agent: stations only list their starting tabs.
 */
import * as React from 'react';
import type { WorldSpec } from '../common/world-model';
import { WORLD_TEMPLATES, describeWorld } from '../common/world-templates';
import { WORLD_KITS, insertKit, suggestKitAnchor } from '../common/world-kits';
import { previewWorldPreset, WORLD_PRESET_FORMAT, WORLD_PRESET_VERSION } from '../common/world-preset';
import { instantiateTemplate } from '../common/world-templates';
import '../../src/browser/world-preset.css';

export interface WorldPresetPanelProps {
    /** The world saved for this project (or the v1 room migrated), if any. */
    saved?: WorldSpec;
    /** The world currently in preview (not saved yet). */
    draft?: WorldSpec;
    /** Where the preview came from, e.g. "Template: Agent lab" or "Imported file". */
    draftSource?: string;
    disabled?: boolean;
    /** A desk is locked: previews that move desks cannot be saved. */
    locked?: boolean;
    onPreview: (world: WorldSpec, source: string) => void;
    onDiscard: () => void;
    onExport?: () => void;
    onError: (message: string) => void;
}

export function WorldPresetPanel(props: WorldPresetPanelProps): React.ReactElement {
    const [templateId, setTemplateId] = React.useState<string>(WORLD_TEMPLATES[0]?.id ?? '');
    const [kitId, setKitId] = React.useState<string>(WORLD_KITS[0]?.id ?? '');
    const template = WORLD_TEMPLATES.find(t => t.id === templateId);
    const kit = WORLD_KITS.find(k => k.id === kitId);
    const base = props.draft ?? props.saved;
    const previewTemplate = (): void => {
        const world = instantiateTemplate(templateId, { name: props.saved?.name });
        if (!world) { props.onError('That template could not be loaded.'); return; }
        props.onPreview(world, `Template: ${template?.label ?? templateId}`);
    };
    const addKit = (): void => {
        if (!base) { props.onError('Choose a template or save a room first, then add kits.'); return; }
        const result = insertKit(base, kitId, suggestKitAnchor(base, kitId));
        if (!result.ok) { props.onError(result.error); return; }
        props.onPreview(result.world, `${props.draftSource ?? 'Saved world'} + ${kit?.label ?? kitId}`);
    };
    const lines = props.draft ? previewWorldPreset({ format: WORLD_PRESET_FORMAT, version: WORLD_PRESET_VERSION, world: props.draft }) : [];
    return <div className="omo-world-preset" data-testid="world-preset-panel">
        <label className="omo-field">World template
            <select data-testid="world-template" aria-label="World template" value={templateId} disabled={props.disabled} onChange={event => setTemplateId(event.target.value)}>
                {WORLD_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <small>{template ? `${template.description} (${template.summary})` : ''}</small>
        </label>
        <button type="button" data-testid="world-template-preview" disabled={props.disabled || !template} onClick={previewTemplate}>Preview template</button>
        <label className="omo-field">Room kit to add
            <select data-testid="world-kit" aria-label="Room kit to add" value={kitId} disabled={props.disabled} onChange={event => setKitId(event.target.value)}>
                {WORLD_KITS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <small>{kit?.description ?? ''}</small>
        </label>
        <button type="button" data-testid="world-kit-add" disabled={props.disabled || !kit || !base} onClick={addKit}>Add kit to preview</button>
        {props.onExport && <button type="button" data-testid="world-preset-export" disabled={props.disabled || !props.saved} onClick={props.onExport}>Export world (v2)</button>}
        {props.draft && <section className="omo-world-preview" data-testid="world-preset-preview" aria-label="World preview">
            <strong>{props.draftSource ?? 'Preview'} · {describeWorld(props.draft)}</strong>
            <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
            {props.locked && <small role="note" data-testid="world-preset-locked">🔒 A desk is locked, so this world cannot be saved. Unlock it in Station recipes first.</small>}
            <button type="button" data-testid="world-preset-discard" onClick={props.onDiscard}>Discard preview</button>
        </section>}
    </div>;
}

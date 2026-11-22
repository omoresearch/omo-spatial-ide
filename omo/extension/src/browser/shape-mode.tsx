/**
 * shape — Shape mode: building the room is an experience, not an editor.
 *   Space (no screen focused) or the top-bar "Shape" button opens ONE floating glass prompt at the bottom
 *   centre with three quiet chips. Enter sends the text to the EXISTING admin planner (AdminController.ask:
 *   rules by default, Hermes only after its own confirmation). The proposal shows as build mode's pending
 *   preview in the room, with ONE caption card anchored above the change: one plain sentence + Keep (Enter)
 *   / Undo (Esc). Keep = AdminController.apply, Undo = AdminController.discard. Typing again refines (the
 *   ghost is replaced). Clicking a thing adds it as a pill. Kept changes become dots in a history strip;
 *   a dot undoes back to before it (the existing WorldStore undo). "Browse" shows the old World Builder.
 * Nothing here starts an agent, presses Enter in a terminal or changes the world without Keep.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import type { BuildMode } from './build-mode';
import type { AdminController, AdminState, AdminEntry } from './admin-controller';
import { threeOf } from './build-scene';
import { ambientHost } from './agent-avatars';
import { sceneControls } from './focus-screen';
import { entityTitle } from './world-store';
import type { WorldSpec } from '../common/world-model';
import { shapeStore, SHAPE_TOGGLE_EVENT, setShapeKeyHandler } from './shape-store';
import { ShapeTopButton, ShapeGlyph } from './shape-topbar';
import { ShapePill, captionFor, composePrompt, expandIdea, refinePrompt, resolveScreens, suggestionsFor } from './shape-logic';
import '../../src/browser/world-tokens.css';
import '../../src/browser/shape-mode.css';

interface Kept { id: string; sentence: string }
/** Kept changes of this window (the strip survives closing and reopening Shape). */
let keptLog: Kept[] = [];
/** The prompt of the pending proposal (a refinement builds on it) and the idea it came from. */
interface Turn { prompt: string; idea?: string; entryId?: string }

function useBump(): () => void { const [, bump] = React.useReducer((n: number) => n + 1, 0); return bump as () => void; }

export function ShapeMode(props: { build: BuildMode; admin?: AdminController; adminState?: AdminState }): React.ReactElement | null {
    const { build, admin, adminState } = props;
    const bump = useBump();
    const [open, setOpen] = React.useState(shapeStore.open);
    const [text, setText] = React.useState('');
    const [pills, setPills] = React.useState<ShapePill[]>([]);
    const [turn, setTurn] = React.useState<Turn | undefined>();
    const [browse, setBrowse] = React.useState(false);
    const [details, setDetails] = React.useState(false);
    const [kept, setKept] = React.useState<Kept[]>(keptLog);
    const input = React.useRef<HTMLInputElement>(null);
    const caption = React.useRef<HTMLDivElement>(null);
    const enteredBuild = React.useRef(false);
    const navBefore = React.useRef<'walk' | 'overview' | undefined>(undefined);
    const openRef = React.useRef(open); openRef.current = open;
    const browseRef = React.useRef(browse); browseRef.current = browse;

    // Follow build mode and its store (selection = a pointed thing; proposal = the ghost).
    React.useEffect(() => {
        let offStore: (() => void) | undefined;
        const follow = (): void => { offStore?.(); offStore = build.store?.onChange(() => bump()); };
        follow();
        const off = build.subscribe(() => { follow(); bump(); });
        return () => { off(); offStore?.(); };
    }, [build]);

    const entry: AdminEntry | undefined = adminState?.entries.find(e => e.id === adminState.activeId);
    const proposed = !!entry && entry.status === 'proposed' && !!entry.plan?.proposal && !!build.store?.proposal;
    const busy = !!adminState?.busy;

    const focusPrompt = (): void => { window.setTimeout(() => input.current?.focus({ preventScroll: true }), 0); };
    const setNav = (mode: 'walk' | 'overview'): void => {
        const canvas = threeOf(build.scene).canvas, wrap = canvas?.closest('.omo-scene-wrap');
        wrap?.querySelector<HTMLElement>(`[data-testid="${mode === 'walk' ? 'walk-mode' : 'overview-mode'}"]`)?.click();
    };

    const show = React.useCallback((next: boolean): void => {
        if (next === openRef.current) return;
        if (next) {
            build.sync();
            if (!build.store || !build.scene) return;
            const nav = threeOf(build.scene).navigation;
            navBefore.current = nav;
            if (nav === 'walk') setNav('overview'); // the camera rises to the three-quarter overview of the room
            if (!build.active) { build.enter(); enteredBuild.current = build.active; }
            setOpen(true); shapeStore.set(true); focusPrompt();
        } else {
            // A pending change is dropped (never applied) when Shape closes.
            const active = admin?.activeEntry;
            if (active?.status === 'proposed') admin?.discard(active.id);
            if (build.store?.proposal) build.discard();
            if (enteredBuild.current && build.active) build.exit(true);
            enteredBuild.current = false;
            if (navBefore.current === 'walk') setNav('walk');
            setOpen(false); shapeStore.set(false); setBrowse(false); setPills([]); setText(''); setTurn(undefined); setDetails(false);
        }
    }, [build, admin]);

    // Space (no screen focused, not typing) and the top-bar button toggle Shape.
    React.useEffect(() => {
        const toggle = (): void => show(!openRef.current);
        const key = (event: KeyboardEvent): boolean => {
            if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return false;
            build.sync();
            const canvas = threeOf(build.scene).canvas; if (!canvas) return false;
            const t = event.target;
            if (t !== canvas && t !== document.body && t !== document.documentElement) return false;
            const c = sceneControls(build.scene);
            if (c && (c.typing || c.cameraOwned)) return false; // a screen is focused: Space is the terminal's
            if (build.active && !openRef.current) return false; // plain build mode keeps its keys
            toggle(); return true;
        };
        setShapeKeyHandler(key);
        window.addEventListener(SHAPE_TOGGLE_EVENT, toggle);
        return () => { setShapeKeyHandler(undefined); window.removeEventListener(SHAPE_TOGGLE_EVENT, toggle); };
    }, [build, show]);
    // A click in the room (pointing at a thing) gives the keys back to the prompt, so typing never drives build keys.
    React.useEffect(() => {
        if (!open) return undefined;
        const up = (event: PointerEvent): void => { if (!browseRef.current && event.target === threeOf(build.scene).canvas) focusPrompt(); };
        window.addEventListener('pointerup', up, true);
        return () => window.removeEventListener('pointerup', up, true);
    }, [open, build]);
    React.useEffect(() => () => { if (openRef.current) shapeStore.set(false); document.body.classList.remove('omo-shape-browse'); }, []);
    React.useEffect(() => { document.body.classList.toggle('omo-shape-browse', open && browse); }, [open, browse]);
    // The room closed or was rebuilt (no store): leave Shape.
    React.useEffect(() => { if (open && !build.store) show(false); });

    // Point to refer: a click on a thing selects it in build mode; Shape turns that into a pill.
    const selected = build.state.selected;
    React.useEffect(() => {
        if (!open || browse || !selected) return;
        const e = build.store?.preview.entities.find(x => x.id === selected);
        if (e) setPills(list => list.some(p => p.id === e.id) ? list : [...list, { id: e.id, name: entityTitle(e) }].slice(-3));
        build.select(undefined);
        focusPrompt();
    }, [selected, open, browse]);

    // The ghost breathes and the caption follows the change on screen.
    const pendingIds = React.useMemo(() => pendingOf(build.store?.world, build.store?.preview), [proposed, build.store?.preview]);
    React.useEffect(() => {
        if (!open || !proposed || !pendingIds.length) return undefined;
        let frame = 0;
        const tick = (): void => {
            frame = requestAnimationFrame(tick);
            const t = threeOf(build.scene);
            breathe(t.scene, pendingIds);
            const card = caption.current; if (!card || !t.camera || !t.canvas) return;
            const at = anchorOf(build.store?.preview, pendingIds); if (!at) return;
            const r = t.canvas.getBoundingClientRect();
            const v = new THREE.Vector3(at.x, at.y, at.z).project(t.camera);
            const host = card.offsetParent?.getBoundingClientRect() ?? r;
            let x = r.left + (v.x + 1) / 2 * r.width - host.left, y = r.top + (1 - v.y) / 2 * r.height - host.top;
            if (v.z > 1) { x = host.width / 2; y = host.height * 0.3; }
            const w = card.offsetWidth, h = card.offsetHeight;
            x = Math.max(w / 2 + 16, Math.min(host.width - w / 2 - 16, x));
            y = Math.max(h + 72, Math.min(host.height - 190, y - 18));
            // Nothing covers the centre of the room: a card over the centre lifts above it (still above the change).
            const cx = host.width / 2, cy = host.height / 2;
            const zone = host.height * 0.07;
            if (Math.abs(x - cx) < w / 2 + host.width * 0.07 && y > cy - zone - 12 && y - h < cy + zone) y = Math.max(h + 72, cy - zone - 12);
            card.style.transform = `translate(${Math.round(x - w / 2)}px, ${Math.round(y - h)}px)`;
            card.dataset.anchor = `${Math.round(r.left + (v.x + 1) / 2 * r.width)},${Math.round(r.top + (1 - v.y) / 2 * r.height)}`;
        };
        tick();
        return () => { cancelAnimationFrame(frame); breathe(threeOf(build.scene).scene, []); };
    }, [open, proposed, pendingIds.join(',')]);

    if (!admin || !adminState) return null;
    const store = build.store;
    const topbarSide = typeof document !== 'undefined' ? document.querySelector('.omo-topbar .omo-topbar-side.is-right') : null;
    const button = topbarSide ? createPortal(<ShapeTopButton />, topbarSide) : null;
    if (!open || !store) return <>{button}</>;

    const send = (raw: string): void => {
        const typed = raw.trim();
        if ((!typed && !pills.length) || busy) return;
        const near = pills.length ? store.preview.entities.find(e => e.id === pills[0].id)?.transform : undefined;
        const base = resolveScreens(composePrompt(typed, pills), store.preview, near);
        const fresh = expandIdea(base);
        const refining = proposed && turn;
        const prompt = refining ? refinePrompt(turn!.prompt, fresh.prompt) : fresh.prompt;
        setTurn({ prompt, idea: refining ? turn!.idea ?? fresh.idea : fresh.idea });
        setText(''); setPills([]); setDetails(false);
        void admin.ask(prompt);
        focusPrompt();
    };
    const keep = (): void => {
        if (!entry || !proposed) return;
        const sentence = captionFor(entry.plan!.proposal!.summary, turn?.idea);
        admin.apply(entry.id);
        if (admin.activeEntry?.status === 'applied') { keptLog = [...keptLog, { id: entry.id, sentence }].slice(-24); setKept(keptLog); }
        setTurn(undefined); focusPrompt();
    };
    const undo = (): void => { if (entry && proposed) admin.discard(entry.id); setTurn(undefined); focusPrompt(); };
    const rewind = (index: number): void => {
        if (proposed) undo();
        let n = keptLog.length - index;
        while (n-- > 0 && store.canUndo) { build.undo(); keptLog = keptLog.slice(0, -1); }
        setKept(keptLog); focusPrompt();
    };
    const onKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            if (text.trim() || pills.length) send(text); else if (proposed) keep();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            if (proposed) undo(); else if (pills.length || text) { setPills([]); setText(''); } else show(false);
        } else if (event.key === 'Backspace' && !text && pills.length) { setPills(pills.slice(0, -1)); }
    };

    const proposal = proposed ? entry!.plan!.proposal! : undefined;
    const sentence = proposal ? captionFor(proposal.summary, turn?.idea) : '';
    const failed = !busy && entry && (entry.status === 'failed' || entry.status === 'answered' || entry.status === 'stale') ? firstSentence(entry.plan?.notes[0] ?? entry.outcome ?? entry.plan?.explanation ?? '') : '';
    const chips = suggestionsFor(store.world);
    const hermes = adminState.useHermes && adminState.hermesConfirmed;

    return <>{button}
        <div className="omo-shape" data-testid="shape-mode" data-proposed={String(proposed)} data-busy={String(busy)} onPointerDown={e => e.stopPropagation()}>
            {proposal && <div className="omo-shape-caption" ref={caption} data-testid="shape-caption" role="dialog" aria-label="Proposed change">
                <p data-testid="shape-caption-text">{sentence}</p>
                <div className="omo-shape-caption-row">
                    <button type="button" className="omo-shape-keep" data-testid="shape-keep" onMouseDown={e => e.preventDefault()} onClick={keep}>Keep <kbd>↵</kbd></button>
                    <button type="button" className="omo-shape-undo" data-testid="shape-undo" onMouseDown={e => e.preventDefault()} onClick={undo}>Undo <kbd>esc</kbd></button>
                    <button type="button" className="omo-shape-details-toggle" data-testid="shape-details-toggle" aria-expanded={details} onMouseDown={e => e.preventDefault()} onClick={() => setDetails(!details)}>Details</button>
                </div>
                {details && <ol className="omo-shape-details" data-testid="shape-details">{entry!.plan!.steps.map((s, i) => <li key={i}>{s}</li>)}{entry!.plan!.notes.map((n, i) => <li key={`n${i}`} className="is-note">{n}</li>)}</ol>}
                <i className="omo-shape-caption-stem" aria-hidden="true" />
            </div>}
            <div className="omo-shape-dock">
                {kept.length > 0 && <div className="omo-shape-history" data-testid="shape-history" role="list" aria-label="Kept changes">
                    {kept.map((k, i) => <button type="button" role="listitem" key={k.id} className="omo-shape-dot" data-testid="shape-history-dot" data-sentence={k.sentence}
                        aria-label={`Undo back to before: ${k.sentence}`} onMouseDown={e => e.preventDefault()} onClick={() => rewind(i)}><span className="omo-shape-tip">{k.sentence}<small>Click to undo back to here</small></span></button>)}
                </div>}
                {busy && <div className="omo-shape-status" role="status" data-testid="shape-thinking"><span className="omo-shape-spinner" aria-hidden="true" />{hermes ? 'Asking Hermes…' : 'Shaping…'}</div>}
                {!busy && failed && <div className="omo-shape-status is-note" role="status" data-testid="shape-note">{failed}</div>}
                <form className="omo-shape-prompt" data-testid="shape-prompt" onSubmit={e => { e.preventDefault(); send(text); }}>
                    <span className="omo-shape-mark" aria-hidden="true"><ShapeGlyph size={16} /></span>
                    {pills.map(p => <span key={p.id} className="omo-shape-pill" data-testid="shape-pill" data-entity={p.id}>{p.name}
                        <button type="button" aria-label={`Remove ${p.name}`} onMouseDown={e => e.preventDefault()} onClick={() => { setPills(pills.filter(x => x.id !== p.id)); focusPrompt(); }}>×</button></span>)}
                    <input ref={input} data-testid="shape-input" value={text} maxLength={400} spellCheck={false} autoComplete="off"
                        placeholder={proposed ? 'Refine it… or press Enter to keep' : pills.length ? 'Say what to do with it…' : 'Describe a change…'} aria-label="Describe a change"
                        onChange={e => setText(e.currentTarget.value)} onKeyDown={onKey} />
                    <button type="button" className="omo-shape-browse" data-testid="shape-browse" aria-pressed={browse} onMouseDown={e => e.preventDefault()} onClick={() => setBrowse(!browse)} title="Pick from the catalogue instead">Browse</button>
                </form>
                {!proposed && !busy && !pills.length && <div className="omo-shape-chips" data-testid="shape-chips">
                    {chips.map(c => <button type="button" key={c} className="omo-shape-chip" data-testid="shape-chip" onMouseDown={e => e.preventDefault()} onClick={() => send(c)}>{c}</button>)}
                </div>}
            </div>
        </div>
    </>;
}

function firstSentence(s: string): string { return (s.split(/(?<=[.!?])\s+/)[0] ?? '').trim(); }

/** Ids the pending proposal adds or changes (the preview differs from the applied world). */
function pendingOf(world: WorldSpec | undefined, preview: WorldSpec | undefined): string[] {
    if (!world || !preview || world === preview) return [];
    const base = new Map(world.entities.map(e => [e.id, JSON.stringify(e)]));
    return preview.entities.filter(e => base.get(e.id) !== JSON.stringify(e)).map(e => e.id);
}
function anchorOf(world: WorldSpec | undefined, ids: string[]): { x: number; y: number; z: number } | undefined {
    const ents = world?.entities.filter(e => ids.includes(e.id)) ?? [];
    if (!ents.length) return undefined;
    const x = ents.reduce((s, e) => s + e.transform.x, 0) / ents.length, z = ents.reduce((s, e) => s + e.transform.z, 0) / ents.length;
    return { x, y: 1.5, z };
}
/** The pending blueprints of build mode's layer pulse softly (a breathing ghost). Read-only lookup by name. */
function breathe(three: THREE.Scene | undefined, ids: string[]): void {
    const layer = three?.getObjectByName('omo-build-layer'); if (!layer) return;
    const k = ids.length ? 0.5 + 0.5 * Math.sin(performance.now() / 520) : 0;
    let touched = false;
    layer.traverse(node => {
        const id = node.userData?.buildEntityId as string | undefined; if (!id) return;
        const on = ids.includes(id);
        node.traverse(child => {
            const m = (child as THREE.Mesh).material as THREE.Material & { opacity?: number; color?: THREE.Color } | undefined;
            if (!m || Array.isArray(m)) return;
            if (m.userData.shapeBase === undefined) m.userData.shapeBase = m.opacity ?? 1;
            const base = m.userData.shapeBase as number;
            // The ghost glows through walls and the floor of the overview (x-ray), breathing between 40% and 100%.
            if (m.userData.shapeDepth === undefined) m.userData.shapeDepth = m.depthTest;
            const depth = on ? false : m.userData.shapeDepth as boolean;
            if (m.depthTest !== depth) { m.depthTest = depth; m.needsUpdate = true; child.renderOrder = on ? 20 : child.renderOrder; touched = true; }
            const next = on ? ((child as THREE.Mesh).isMesh ? 0.1 + 0.16 * k : 0.4 + 0.6 * k) : base;
            if (m.opacity !== next) { m.opacity = next; touched = true; }
        });
    });
    if (touched && three) ambientHost(three)?.invalidate();
}

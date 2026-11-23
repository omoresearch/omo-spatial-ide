/**
 * shape — Shape mode: building the room is an experience, not an editor.
 *   Space (no screen focused) or the top-bar "Shape" button opens ONE floating glass prompt at the bottom
 *   centre with three quiet chips. Enter sends the text to the EXISTING admin planner (AdminController.ask:
 *   rules by default, Hermes only after its own confirmation). The proposal shows as build mode's pending
 *   preview in the room, with ONE caption card beside the change (never over it): one plain sentence + Keep (Enter)
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
import type { WorldSpec, WorldEntity } from '../common/world-model';
import { activeKit, decorPropFor, kitProp } from '../common/world-style-kits';
import { decorKitPlan } from './world-scene-decor'; // beauty:foundation
import { shapeStore, SHAPE_TOGGLE_EVENT, setShapeKeyHandler } from './shape-store';
import { ShapeTopButton, ShapeGlyph } from './shape-topbar';
import { ShapePill, captionFor, composePrompt, expandIdea, refinePrompt, resolveScreens, spokenNames, suggestionsFor, whereOf } from './shape-logic';
import type { OmoAgent } from './omo-agent-ui';
import { clearBeam, showBeam } from './omo-agent-ui';
import { routeOmo } from '../common/omo-agent';
import type { DictationController } from './voice-dictation';
import { intoPrompt, isTalkKey, isTalkRelease, ShapeVoice } from './shape-voice';
import '../../src/browser/world-tokens.css';
import '../../src/browser/shape-mode.css';

interface Kept { id: string; sentence: string }
/** Kept changes of this window (the strip survives closing and reopening Shape). */
let keptLog: Kept[] = [];
/** Kept changes a dot took back, newest last (Redo puts them back in order; a new Keep clears them). */
let redoLog: Kept[] = [];
/** The prompt of the pending proposal (a refinement builds on it) and the idea it came from. */
interface Turn { prompt: string; idea?: string; where?: string; entryId?: string; /** promise-agent: a page made on request, shown on the new wall on Keep */ page?: { title: string; url: string } }
/** promise-agent: Omo's one-line answer (a place answer beams to its thing). */
interface Answer { text: string; target?: string; kind: 'answer' | 'note' }

function useBump(): () => void { const [, bump] = React.useReducer((n: number) => n + 1, 0); return bump as () => void; }

export function ShapeMode(props: { build: BuildMode; admin?: AdminController; adminState?: AdminState; agent?: OmoAgent; dictation?: DictationController }): React.ReactElement | null {
    const { build, admin, adminState, agent } = props;
    const bump = useBump();
    const [open, setOpen] = React.useState(shapeStore.open);
    const [text, setText] = React.useState('');
    const [pills, setPills] = React.useState<ShapePill[]>([]);
    const [turn, setTurn] = React.useState<Turn | undefined>();
    const [browse, setBrowse] = React.useState(false);
    const [details, setDetails] = React.useState(false);
    const [kept, setKept] = React.useState<Kept[]>(keptLog);
    const [redoable, setRedoable] = React.useState<Kept[]>(redoLog);
    const input = React.useRef<HTMLInputElement>(null);
    const caption = React.useRef<HTMLDivElement>(null);
    const leader = React.useRef<SVGSVGElement>(null);
    const tags = React.useRef<HTMLDivElement>(null);
    /** The proposal the camera is framed on ('' = the plain overview). */
    const framed = React.useRef('');
    /** promise-agent fix 2: the URL of a page just kept; its wall is framed next. */
    const wallFrame = React.useRef('');
    const enteredBuild = React.useRef(false);
    const navBefore = React.useRef<'walk' | 'overview' | undefined>(undefined);
    const openRef = React.useRef(open); openRef.current = open;
    // promise-agent: the answer card, page making, voice.
    const [answer, setAnswer] = React.useState<Answer | undefined>();
    const [making, setMaking] = React.useState('');
    const sendRef = React.useRef<(text: string) => void>(() => undefined);
    const voice = React.useMemo(() => props.dictation ? new ShapeVoice(props.dictation, intoPrompt(setText, text => sendRef.current(text))) : undefined, [props.dictation]);
    const [listening, setListening] = React.useState(false);
    React.useEffect(() => () => voice?.cancel(), [voice]);
    // The beam follows the answer: on while a place answer shows, gone with it (or Shape) after 20 s at most.
    React.useEffect(() => {
        const three = threeOf(build.scene).scene, canvas = threeOf(build.scene).canvas;
        const at = open && answer?.target ? build.store?.world.entities.find(e => e.id === answer.target)?.transform : undefined;
        if (!three || !at) { clearBeam(three); if (canvas) delete canvas.dataset.answerBeam; return undefined; }
        showBeam(three, at, 3.2, { room: build.scene, id: answer!.target! }); if (canvas) canvas.dataset.answerBeam = answer!.target!;
        const t = window.setTimeout(() => setAnswer(a => a === answer ? undefined : a), 20000);
        return () => { window.clearTimeout(t); clearBeam(three); if (canvas) delete canvas.dataset.answerBeam; };
    }, [open, answer, build.scene]);
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
            setOpen(false); shapeStore.set(false); setBrowse(false); setPills([]); setText(''); setTurn(undefined); setDetails(false); setAnswer(undefined); setMaking('');
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
    React.useEffect(() => { document.body.classList.toggle('omo-shape-open', open); return () => document.body.classList.remove('omo-shape-open'); }, [open]);
    React.useEffect(() => { document.body.classList.toggle('omo-shape-proposed', open && proposed); return () => document.body.classList.remove('omo-shape-proposed'); }, [open, proposed]);
    // Calm the world while shaping: the city backdrop dims and hazes so the room and the change are the hero.
    React.useEffect(() => {
        const three = threeOf(build.scene).scene;
        const bd = three?.getObjectByName('omo-kit-backdrop') as THREE.Mesh | undefined;
        const u = (bd?.material as THREE.ShaderMaterial | undefined)?.uniforms;
        if (!open || !u?.gain || !u?.haze) return undefined;
        const g0 = u.gain.value as number, h0 = u.haze.value as number;
        u.gain.value = g0 * 0.38; u.haze.value = Math.min(1, h0 + 0.4);
        if (three) ambientHost(three)?.invalidate();
        return () => { u.gain.value = g0; u.haze.value = h0; if (three) ambientHost(three)?.invalidate(); };
    }, [open, build.scene]);
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
        let frame = 0; const since = performance.now(), key = `${entry?.id ?? ''}:${pendingIds.join(',')}`;
        const tick = (): void => {
            frame = requestAnimationFrame(tick);
            const t = threeOf(build.scene);
            breathe(t.scene, pendingIds, build.store?.preview);
            // Frame the change: once its real models are drawn (or after 700 ms), the overview eases onto the ghost group.
            if (framed.current !== key && t.scene && t.navigation === 'overview' && (waitsForProp.size === 0 || ghostedAll(t.scene, pendingIds) || performance.now() - since > 700)) {
                const box = ghostBounds(t.scene, pendingIds);
                if (box) { framed.current = key; frameOn(build.scene, box); }
            }
            const card = caption.current; if (!card || !t.camera || !t.canvas) return;
            const main = pendingIds.slice(0, 1); // the leader points at the main thing (the first new or changed one)
            const r = t.canvas.getBoundingClientRect();
            const host = card.offsetParent?.getBoundingClientRect() ?? r;
            const toHost = (p: THREE.Vector3): { x: number; y: number; z: number } => { const v = p.clone().project(t.camera!); return { x: r.left + (v.x + 1) / 2 * r.width - host.left, y: r.top + (1 - v.y) / 2 * r.height - host.top, z: v.z }; };
            // The whole change on screen (all pending things): the card never covers it.
            const all = ghostBounds(t.scene, pendingIds);
            // A tiny name tag over each ghosted thing (the caption's nouns), only while the change is pending.
            // Tags never overlap: the lower ones (nearer the floor) stay put, a clashing tag steps up, then sideways.
            const placed: Array<{ l: number; t: number; r: number; b: number }> = [];
            const wanted = (Array.from(tags.current?.children ?? []) as HTMLElement[]).map(tag => {
                const b = ghostBounds(t.scene, [tag.dataset.id ?? '']);
                return { tag, q: b ? toHost(new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y + 0.08, (b.min.z + b.max.z) / 2)) : undefined };
            }).sort((m, n) => (n.q?.y ?? 0) - (m.q?.y ?? 0));
            for (const { tag, q } of wanted) {
                const on = !!q && q.z <= 1;
                if (tag.dataset.on !== String(on)) tag.dataset.on = String(on);
                if (!q || !on) continue;
                const tw = tag.offsetWidth, th = tag.offsetHeight, gapT = 4;
                const clash = (x: number, y: number): boolean => placed.some(o => x - tw / 2 < o.r + gapT && x + tw / 2 > o.l - gapT && y - th < o.b + gapT && y > o.t - gapT);
                let x = q.x, y = q.y;
                for (const [dx, dy] of [[0, 0], [0, -1], [-1, 0], [1, 0], [0, -2], [-1, -1], [1, -1]] as const) { // straight up first: the tag stays over its own thing
                    const o = placed.find(p => q.x - tw / 2 < p.r + gapT && q.x + tw / 2 > p.l - gapT);
                    const nx = q.x + dx * (o ? (tw / 2 + (o.r - o.l) / 2 + gapT) : tw), ny = q.y + dy * (th + gapT);
                    if (!clash(nx, ny)) { x = nx; y = ny; break; }
                }
                placed.push({ l: x - tw / 2, t: y - th, r: x + tw / 2, b: y });
                tag.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
                tag.dataset.at = `${Math.round(x + host.left)},${Math.round(y + host.top)}`;
                tag.dataset.box = [x - tw / 2 + host.left, y - th + host.top, x + tw / 2 + host.left, y + host.top].map(Math.round).join(',');
            }
            // The reticle sits on the floor at the group's front edge (on its contact shadow), never on a thing.
            const at = ghostFloor(t.scene, pendingIds, t.camera.position) ?? ghostAnchor(t.scene, main) ?? anchorOf(build.store?.preview, main); if (!at) return;
            const a = toHost(new THREE.Vector3(at.x, at.y, at.z));
            let g = { l: a.x - 30, t: a.y - 30, r: a.x + 30, b: a.y + 30 };
            if (all) {
                const xs: number[] = [], ys: number[] = [];
                for (const cx of [all.min.x, all.max.x]) for (const cy of [all.min.y, all.max.y]) for (const cz of [all.min.z, all.max.z]) { const q = toHost(new THREE.Vector3(cx, cy, cz)); if (q.z <= 1) { xs.push(q.x); ys.push(q.y); } }
                if (xs.length) g = { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };
            }
            const w = card.offsetWidth, h = card.offsetHeight, gap = 28, pad = 16, top = 72, bottom = host.height - 190;
            const cx = host.width / 2, cy = host.height / 2, zx = host.width * 0.07, zy = host.height * 0.07;
            const hits = (x: number, y: number, o: { l: number; t: number; r: number; b: number }, m = 0): boolean => x < o.r + m && x + w > o.l - m && y < o.b + m && y + h > o.t - m;
            const centre = { l: cx - zx, t: cy - zy, r: cx + zx, b: cy + zy };
            // Beside the change, never over it: above-left, above-right, then left, right, above, below.
            const lift = Math.min(h * 0.55, Math.max(0, (g.b - g.t) * 0.5));
            const spots: Array<[string, number, number]> = [
                ['above-left', g.l - gap - w, g.t - h + lift], ['above-right', g.r + gap, g.t - h + lift],
                ['left', g.l - gap - w, (g.t + g.b) / 2 - h / 2], ['right', g.r + gap, (g.t + g.b) / 2 - h / 2],
                ['above', (g.l + g.r) / 2 - w / 2, g.t - gap - h], ['below', (g.l + g.r) / 2 - w / 2, g.b + gap]
            ];
            // The free spot nearest the reticle wins (the order breaks ties), so the leader stays short.
            const lowLeft: [string, number, number] = ['low-left', g.l - gap - w, a.y - h / 2], lowRight: [string, number, number] = ['low-right', g.r + gap, a.y - h / 2];
            let pick: [string, number, number] | undefined, best = Infinity;
            for (const [i, [side, x0, y0]] of [...spots, lowLeft, lowRight].entries()) {
                const x = Math.max(pad, Math.min(host.width - w - pad, x0)), y = Math.max(top, Math.min(bottom - h, y0));
                if (hits(x, y, g, 8) || hits(x, y, centre)) continue;
                const dx = Math.max(x - a.x, 0, a.x - (x + w)), dy = Math.max(y - a.y, 0, a.y - (y + h)), d = Math.hypot(dx, dy) + i * 12;
                if (d < best) { best = d; pick = [side, x, y]; }
            }
            if (!pick) { // nowhere free: the corner farthest from the change
                const far = (g.l + g.r) / 2 > cx ? pad : host.width - w - pad;
                pick = ['corner', far, top];
            }
            const [side, x, y] = pick;
            card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
            card.dataset.side = side;
            card.dataset.anchor = `${Math.round(a.x + host.left)},${Math.round(a.y + host.top)}`;
            card.dataset.ghostRect = [g.l + host.left, g.t + host.top, g.r + host.left, g.b + host.top].map(Math.round).join(',');
            // A thin leader from the card's nearest edge to the change, ending in a soft ring on it.
            const lead = leader.current;
            if (lead) {
                const sx = Math.max(x, Math.min(x + w, a.x)), sy = Math.max(y, Math.min(y + h, a.y));
                lead.setAttribute('data-on', String(a.z <= 1));
                const line = lead.querySelector('line');
                line?.setAttribute('x1', String(Math.round(sx))); line?.setAttribute('y1', String(Math.round(sy)));
                line?.setAttribute('x2', String(Math.round(a.x))); line?.setAttribute('y2', String(Math.round(a.y)));
                for (const c of Array.from(lead.querySelectorAll('circle'))) { c.setAttribute('cx', String(Math.round(a.x))); c.setAttribute('cy', String(Math.round(a.y))); }
            }
        };
        tick();
        return () => { cancelAnimationFrame(frame); breathe(threeOf(build.scene).scene, []); };
    }, [open, proposed, pendingIds.join(',')]);
    // Keep / Undo / close: the camera eases back to the plain overview.
    // (A refinement keeps the frame while it thinks, then glides to the new change.)
    React.useEffect(() => { if ((!open || (!proposed && !busy)) && framed.current) { framed.current = ''; frameOn(build.scene, undefined); } }, [open, proposed, busy]);
    // promise-agent fix 2: after Keep of a made page, the camera eases to face its wall (solid walls drawn, the page fills the view).
    React.useEffect(() => {
        const url = wallFrame.current; if (!open || proposed || busy || !url) return;
        wallFrame.current = '';
        const wall = build.store?.world.entities.find(e => e.kind === 'web-wall' && e.home === url);
        if (wall && wall.kind === 'web-wall') { framed.current = `wall:${wall.id}`; frameWall(build.scene, wall); }
    }, [open, proposed, busy, kept]);

    if (!admin || !adminState) return null;
    const store = build.store;
    const topbarSide = typeof document !== 'undefined' ? document.querySelector('.omo-topbar .omo-topbar-side.is-right') : null;
    const button = topbarSide ? createPortal(<ShapeTopButton />, topbarSide) : null;
    if (!open || !store) return <>{button}</>;

    const send = (raw: string): void => {
        const typed = raw.trim();
        if ((!typed && !pills.length) || busy || making) return;
        setAnswer(undefined);
        // promise-agent: Omo first — a question about the room, a page, a walk; anything else is a change for the planner.
        const route = agent && !pills.length ? routeOmo(typed) : { kind: 'change' as const };
        if (agent && route.kind === 'ask') {
            const a = agent.answer(typed);
            if (a) { setAnswer({ text: a.text, target: a.target, kind: 'answer' }); setText(''); focusPrompt(); return; }
        }
        if (agent && (route.kind === 'goto' || route.kind === 'back')) {
            setText('');
            show(false); // walking happens in the room, not in Shape's overview
            const line = route.kind === 'goto' ? agent.takeMeTo(route.target) : agent.whereWasI();
            agent.say(line);
            return;
        }
        if (agent && route.kind === 'page') {
            setText(''); setMaking(`Making “${route.page.title}”…`);
            void agent.makePage(route.page).then(made => {
                setMaking('');
                setTurn({ prompt: made.prompt, idea: made.title, page: { title: made.title, url: made.url } });
                void admin.ask(made.prompt, made.spot ? { wallSpot: { x: made.spot.x, z: made.spot.z, rotation: made.spot.rotation, elevation: made.spot.elevation } } : {});
            }, error => { setMaking(''); setAnswer({ text: `The page was not made: ${error instanceof Error ? error.message : String(error)}`, kind: 'note' }); });
            focusPrompt();
            return;
        }
        const near = pills.length ? store.preview.entities.find(e => e.id === pills[0].id)?.transform : undefined;
        const base = resolveScreens(composePrompt(typed, pills), store.preview, near);
        const fresh = expandIdea(base);
        const refining = proposed && turn;
        const prompt = refining ? refinePrompt(turn!.prompt, fresh.prompt) : fresh.prompt;
        setTurn({ prompt, idea: refining ? turn!.idea ?? fresh.idea : fresh.idea, where: whereOf(typed) ?? (refining ? turn!.where : undefined) });
        setText(''); setPills([]); setDetails(false);
        void admin.ask(prompt);
        focusPrompt();
    };
    const keep = (): void => {
        if (!entry || !proposed) return;
        const sentence = turn?.page ? pageSentence(turn.page.title) : captionFor(entry.plan!.proposal!.summary, turn?.idea, turn?.where, spokenNames(entry.plan!.proposal!.ops));
        admin.apply(entry.id);
        if (admin.activeEntry?.status === 'applied' && turn?.page) { agent?.openPage(turn.page.url); wallFrame.current = turn.page.url; } // promise-agent: the kept wall shows its page, live; the camera frames it
        if (admin.activeEntry?.status === 'applied') { keptLog = [...keptLog, { id: entry.id, sentence }].slice(-24); setKept(keptLog); redoLog = []; setRedoable(redoLog); }
        setTurn(undefined); focusPrompt();
    };
    const undo = (): void => { if (entry && proposed) admin.discard(entry.id); setTurn(undefined); focusPrompt(); };
    const rewind = (index: number): void => {
        if (proposed) undo();
        let n = keptLog.length - index;
        while (n-- > 0 && store.canUndo) { build.undo(); redoLog = [...redoLog, keptLog[keptLog.length - 1]]; keptLog = keptLog.slice(0, -1); }
        setKept(keptLog); setRedoable(redoLog); focusPrompt();
    };
    const redo = (): void => {
        if (proposed || !redoLog.length || !store.canRedo) return;
        build.redo();
        keptLog = [...keptLog, redoLog[redoLog.length - 1]]; redoLog = redoLog.slice(0, -1);
        setKept(keptLog); setRedoable(redoLog); focusPrompt();
    };
    const onKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            // One meaning per key: with text, Enter refines and Ctrl/Cmd+Enter keeps; an empty prompt's Enter keeps.
            if (proposed && (event.ctrlKey || event.metaKey)) keep();
            else if (text.trim() || pills.length) send(text); else if (proposed) keep();
        } else if (isTalkKey(event)) { // promise-agent: hold Alt+T to talk to Omo (see SHAPE_TALK_KEY)
            event.preventDefault(); if (!event.repeat) holdVoice();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            if (answer) { setAnswer(undefined); return; }
            if (proposed) undo(); else if (pills.length || text) { setPills([]); setText(''); } else show(false);
        } else if (event.key === 'Backspace' && !text && pills.length) { setPills(pills.slice(0, -1));
        } else if (!text && (event.ctrlKey || event.metaKey) && ((event.key.toLowerCase() === 'z' && event.shiftKey) || event.key.toLowerCase() === 'y')) { event.preventDefault(); redo(); }
    };

    const typing = !!text.trim() || pills.length > 0;
    const proposal = proposed ? entry!.plan!.proposal! : undefined;
    const sentence = proposal ? (turn?.page ? pageSentence(turn.page.title) : captionFor(proposal.summary, turn?.idea, turn?.where, spokenNames(proposal.ops))) : '';
    sendRef.current = send;
    const holdVoice = (): void => { if (voice?.hold()) setListening(true); else if (voice) setAnswer({ text: voice.state.error || voice.state.notice || 'Voice is not available in this browser.', kind: 'note' }); };
    const releaseVoice = (): void => { if (!listening) return; setListening(false); voice?.release(); };
    const voiceOk = !!voice && voice.available;
    const failed = !busy && entry && (entry.status === 'failed' || entry.status === 'answered' || entry.status === 'stale') ? firstSentence(entry.plan?.notes[0] ?? entry.outcome ?? entry.plan?.explanation ?? '') : '';
    const chips = suggestionsFor(store.world);
    const hermes = adminState.useHermes && adminState.hermesConfirmed;

    return <>{button}
        <div className="omo-shape" data-testid="shape-mode" data-proposed={String(proposed)} data-busy={String(busy)} onPointerDown={e => e.stopPropagation()}>
            {proposal && <svg className="omo-shape-leader" ref={leader} aria-hidden="true" data-on="false"><line x1="0" y1="0" x2="0" y2="0" /><circle className="is-halo" r="16" cx="0" cy="0" /><circle r="4.5" cx="0" cy="0" /></svg>}
            {proposal && <div className="omo-shape-tags" ref={tags} aria-hidden="true">{pendingIds.map(id => <span key={id} className="omo-shape-tag" data-testid="shape-ghost-tag" data-id={id} data-on="false">{tagName(store.preview.entities.find(e => e.id === id))}</span>)}</div>}
            {proposal && <div className="omo-shape-caption" ref={caption} data-testid="shape-caption" role="dialog" aria-label="Proposed change">
                <p data-testid="shape-caption-text">{sentence}</p>
                <div className="omo-shape-caption-row">
                    <button type="button" className="omo-shape-keep" data-testid="shape-keep" onMouseDown={e => e.preventDefault()} onClick={keep}>Keep {typing ? <kbd data-testid="shape-keep-key">Ctrl ↵</kbd> : <kbd data-testid="shape-keep-key">↵</kbd>}</button>
                    <button type="button" className="omo-shape-undo" data-testid="shape-undo" onMouseDown={e => e.preventDefault()} onClick={undo}>Undo <kbd>esc</kbd></button>
                    <button type="button" className="omo-shape-details-toggle" data-testid="shape-details-toggle" aria-expanded={details} onMouseDown={e => e.preventDefault()} onClick={() => setDetails(!details)}>Details</button>
                </div>
                {details && <ol className="omo-shape-details" data-testid="shape-details">{entry!.plan!.steps.map((s, i) => <li key={i}>{s}</li>)}{entry!.plan!.notes.map((n, i) => <li key={`n${i}`} className="is-note">{n}</li>)}</ol>}
                <i className="omo-shape-caption-stem" aria-hidden="true" />
            </div>}
            <div className="omo-shape-dock">
                {(kept.length > 0 || redoable.length > 0) && <div className="omo-shape-history" data-testid="shape-history" role="list" aria-label={`${kept.length} kept change${kept.length === 1 ? '' : 's'}`}>
                    <span className="omo-shape-history-label" aria-hidden="true">{kept.length} kept</span>
                    {kept.map((k, i) => <button type="button" role="listitem" key={k.id} className="omo-shape-dot" data-testid="shape-history-dot" data-sentence={k.sentence}
                        aria-label={`Return to before: ${k.sentence} (you can redo)`} onMouseDown={e => e.preventDefault()} onClick={() => rewind(i)}>
                        <span className="omo-shape-tip"><b>{i + 1}.</b> {k.sentence}<small>Return to this point (you can redo)</small></span></button>)}
                    <span className="omo-shape-now" aria-hidden="true">Now</span>
                    {redoable.length > 0 && !proposed && <button type="button" className="omo-shape-redo" data-testid="shape-redo" title="Redo (Ctrl+Shift+Z)" onMouseDown={e => e.preventDefault()} onClick={redo}>Redo</button>}
                </div>}
                {busy && <div className="omo-shape-status" role="status" data-testid="shape-thinking"><span className="omo-shape-spinner" aria-hidden="true" />{hermes ? 'Asking Hermes…' : 'Shaping…'}</div>}
                {!busy && failed && !answer && <div className="omo-shape-status is-note" role="status" data-testid="shape-note">{failed}</div>}
                {making && <div className="omo-shape-status" role="status" data-testid="omo-making"><span className="omo-shape-spinner" aria-hidden="true" />{making}</div>}
                {answer && <div className={`omo-shape-answer${answer.kind === 'note' ? ' is-note' : ''}`} role="status" data-testid="omo-answer" data-target={answer.target ?? ''}>
                    <span className="omo-shape-answer-mark" aria-hidden="true">◈</span><span data-testid="omo-answer-text">{answer.text}</span>
                    <button type="button" aria-label="Dismiss" onMouseDown={e => e.preventDefault()} onClick={() => { setAnswer(undefined); focusPrompt(); }}>×</button></div>}
                {listening && <div className="omo-shape-status" role="status" data-testid="omo-listening"><span className="omo-shape-rec" aria-hidden="true" />{voice?.state.interim ? `“${voice.state.interim}”` : 'Listening… release to send'}</div>}
                <form className="omo-shape-prompt" data-testid="shape-prompt" onSubmit={e => { e.preventDefault(); send(text); }}>
                    <span className="omo-shape-mark" aria-hidden="true"><ShapeGlyph size={16} /></span>
                    {pills.map(p => <span key={p.id} className="omo-shape-pill" data-testid="shape-pill" data-entity={p.id}>{p.name}
                        <button type="button" aria-label={`Remove ${p.name}`} onMouseDown={e => e.preventDefault()} onClick={() => { setPills(pills.filter(x => x.id !== p.id)); focusPrompt(); }}>×</button></span>)}
                    <input ref={input} data-testid="shape-input" value={text} maxLength={400} spellCheck={false} autoComplete="off"
                        placeholder={listening ? 'Listening…' : proposed ? 'Refine it… or press Enter to keep' : pills.length ? 'Say what to do with it…' : 'Describe a change…'} aria-label="Describe a change"
                        onChange={e => setText(e.currentTarget.value)} onKeyDown={onKey} onKeyUp={e => { if (isTalkRelease(e)) releaseVoice(); }} />
                    {voice && <button type="button" className={`omo-shape-mic${listening ? ' is-on' : ''}`} data-testid="shape-mic" aria-pressed={listening} aria-disabled={!voiceOk}
                        title={voiceOk ? 'Hold to talk to Omo (or hold Alt+T)' : (voice.state.notice || 'On-device speech is not available in this browser')}
                        onMouseDown={e => e.preventDefault()} onPointerDown={e => { e.preventDefault(); holdVoice(); }} onPointerUp={releaseVoice} onPointerLeave={releaseVoice}>
                        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg></button>}
                    {typing && <kbd className="omo-shape-enter" data-testid="shape-enter-hint" aria-hidden="true">{proposed ? 'Enter = refine' : '↵'}</kbd>}
                    <button type="button" className="omo-shape-browse" data-testid="shape-browse" aria-pressed={browse} onMouseDown={e => e.preventDefault()} onClick={() => setBrowse(!browse)} title="Pick from the catalogue instead">Browse</button>
                </form>
                {!proposed && !busy && !pills.length && <div className="omo-shape-chips" data-testid="shape-chips">
                    {chips.map(c => <button type="button" key={c} className="omo-shape-chip" data-testid="shape-chip" onMouseDown={e => e.preventDefault()} onClick={() => send(c)}>{c}</button>)}
                </div>}
            </div>
        </div>
    </>;
}

/** promise-agent: the caption for a page made on request. */
function pageSentence(title: string): string { return `A live page on a new wall: ${title}.`; }
/** The tag over a ghosted thing: its name in sentence case ("Floor lamp"), as the caption says it. */
function tagName(e: WorldEntity | undefined): string {
    if (!e) return '';
    if (e.kind !== 'decor') return entityTitle(e);
    const name = e.label ?? kitProp(e.prop)?.label ?? e.decor;
    return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
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
const GHOST = 0x4fd2ff;
/** World-space bounds of the pending things: the real models once drawn, else build mode's blueprints. */
function ghostBounds(three: THREE.Scene | undefined, ids: string[]): THREE.Box3 | undefined {
    if (!three) return undefined;
    const box = new THREE.Box3(), one = new THREE.Box3();
    const layer = three.getObjectByName('omo-build-layer');
    layer?.updateMatrixWorld(true);
    for (const id of ids) {
        const real = realModel(three, id);
        if (real) { one.setFromObject(real); if (!one.isEmpty()) { box.union(one); continue; } }
        layer?.traverse(node => { if (node.userData?.buildEntityId === id) box.expandByObject(node); });
    }
    return box.isEmpty() ? undefined : box;
}
/**
 * The floor point of the whole pending group nearest the camera (world space): its footprint centre moved
 * toward the camera to just inside the footprint's edge, at floor height — where the contact shadow is.
 */
function ghostFloor(three: THREE.Scene | undefined, ids: string[], eye: THREE.Vector3): { x: number; y: number; z: number } | undefined {
    const box = ghostBounds(three, ids); if (!box) return undefined;
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2, hw = (box.max.x - box.min.x) / 2, hd = (box.max.z - box.min.z) / 2;
    const dx = eye.x - cx, dz = eye.z - cz, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
    const reach = Math.min(Math.abs(ux) > 1e-3 ? hw / Math.abs(ux) : Infinity, Math.abs(uz) > 1e-3 ? hd / Math.abs(uz) : Infinity) + 0.25;
    return { x: cx + ux * reach, y: Math.max(0.02, box.min.y + 0.02), z: cz + uz * reach };
}
/** True when every pending id is drawn with its real model (no kit prop still loading). */
function ghostedAll(three: THREE.Scene, ids: string[]): boolean { return ids.every(id => !!realModel(three, id)); }
/** shape — ease the room's overview camera onto a box (the change), or back (undefined): RoomScene.frameFocus. */
function frameOn(scene: BuildMode['scene'], box: THREE.Box3 | undefined): void {
    scene?.frameFocus(box, 500);
    const canvas = threeOf(scene).canvas; if (canvas) { canvas.dataset.shapeFramed = box ? 'true' : 'false'; delete canvas.dataset.framedWall; }
}
/**
 * promise-agent fix 2 — face a web wall: the camera turns square to its screen at a low angle, close enough that
 * the page fills ~70% of the view width, with the kit's solid walls and ceiling drawn (no dollhouse cut).
 */
function frameWall(scene: BuildMode['scene'], wall: Extract<WorldEntity, { kind: 'web-wall' }>): void {
    const t = threeOf(scene); if (!scene || !t.camera) return;
    const half = THREE.MathUtils.degToRad(t.camera.fov / 2), hHalf = Math.atan(Math.tan(half) * t.camera.aspect);
    const distance = Math.max((wall.width / 2) / 0.72 / Math.tan(hHalf), (wall.height / 2) / 0.62 / Math.tan(half), 2.2);
    const target = { x: wall.transform.x, y: wall.elevation + wall.height / 2, z: wall.transform.z };
    scene.frameFocus(undefined, 700, { azimuth: wall.transform.rotation, elevation: 0.16, distance, target, solid: true });
    if (t.canvas) { t.canvas.dataset.shapeFramed = 'true'; t.canvas.dataset.framedWall = wall.id; }
}
/** Top centre of the pending things (world space): the caption points here. */
function ghostAnchor(three: THREE.Scene | undefined, ids: string[]): { x: number; y: number; z: number } | undefined {
    const box = ghostBounds(three, ids); if (!box) return undefined;
    const c = box.getCenter(new THREE.Vector3());
    return { x: c.x, y: box.max.y, z: c.z };
}

// ---- the ghost: the room's real furniture for a pending id, drawn as tinted glass with a contact shadow

/** The room scene's drawn root for an entity when it holds a real model (a kit world's decor waits for its CC0 prop). */
function realModel(three: THREE.Scene, id: string): THREE.Object3D | undefined {
    const root = three.getObjectByName(`omo-entity:${id}`);
    if (!root) return undefined;
    let meshes = 0; root.traverse(n => { if ((n as THREE.Mesh).isMesh) meshes++; });
    if (!meshes) return undefined;
    // A kit world draws decor with its CC0 catalogue model once it loads: until then the blueprint stays.
    if (root.userData.kind === 'decor' && !root.userData.prop && waitsForProp.has(id)) return undefined;
    return root;
}
/** Pending decor ids whose kit catalogue model is still on its way (set each frame from the preview world). */
let waitsForProp = new Set<string>();
function propsAwaited(world: WorldSpec | undefined, ids: string[]): Set<string> {
    if (!world) return new Set();
    // beauty:foundation — decor waits for its CC0 kit model in every world (not only kit worlds).
    const kit = activeKit(world);
    return new Set(world.entities.filter(e => ids.includes(e.id) && e.kind === 'decor' && !!decorKitPlan(e.decor, e.id, e.prop ?? (kit ? decorPropFor(kit, e)?.id : undefined))).map(e => e.id));
}
let ghostMaterial: THREE.ShaderMaterial | undefined;
function ghostGlass(): THREE.ShaderMaterial {
    if (ghostMaterial) return ghostMaterial;
    ghostMaterial = new THREE.ShaderMaterial({
        name: 'omo-shape-ghost',
        uniforms: { uColor: { value: new THREE.Color(GHOST) }, uOpacity: { value: 0.56 } },
        vertexShader: `
            #include <common>
            #include <skinning_pars_vertex>
            varying vec3 vN; varying vec3 vV;
            void main() {
                #include <beginnormal_vertex>
                #include <skinbase_vertex>
                #include <skinnormal_vertex>
                #include <defaultnormal_vertex>
                #include <begin_vertex>
                #include <skinning_vertex>
                #include <project_vertex>
                vN = normalize(transformedNormal); vV = normalize(-mvPosition.xyz);
            }`,
        fragmentShader: `
            uniform vec3 uColor; uniform float uOpacity;
            varying vec3 vN; varying vec3 vV;
            void main() {
                float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
                // a solid cyan fill (~0.5) with a bright near-white rim: every ghosted thing reads as a shape
                vec3 c = mix(uColor * 0.9, vec3(0.86, 0.98, 1.0), clamp(f * 1.1, 0.0, 1.0));
                gl_FragColor = vec4(c, clamp(uOpacity * 0.92 + 0.42 * f, 0.0, 0.96));
            }`,
        transparent: true, depthWrite: false, side: THREE.FrontSide
    });
    return ghostMaterial;
}
let shadowTexture: THREE.CanvasTexture | undefined;
function contactShadowTexture(): THREE.CanvasTexture {
    if (shadowTexture) return shadowTexture;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!, grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.62)'); grad.addColorStop(0.45, 'rgba(0,0,0,0.38)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    shadowTexture = new THREE.CanvasTexture(c);
    return shadowTexture;
}
/** Meshes now drawn as ghost glass (original material and shadow flag kept in userData to restore). */
const ghosted = new Set<THREE.Mesh>();
function ghostShadows(three: THREE.Scene): THREE.Group {
    let g = three.getObjectByName('omo-shape-ghost-shadows') as THREE.Group | undefined;
    if (!g) { g = new THREE.Group(); g.name = 'omo-shape-ghost-shadows'; three.add(g); }
    return g;
}
function restoreMesh(mesh: THREE.Mesh): void {
    if (mesh.userData.shapeOrig) { mesh.material = mesh.userData.shapeOrig as THREE.Material; mesh.castShadow = !!mesh.userData.shapeCast; mesh.renderOrder = mesh.userData.shapeOrder as number ?? 0; }
    delete mesh.userData.shapeOrig; delete mesh.userData.shapeCast; delete mesh.userData.shapeOrder;
    ghosted.delete(mesh);
}
/** Each frame: the pending things' real meshes become breathing cyan glass over a soft contact shadow. */
function ghostReal(three: THREE.Scene, ids: string[], k: number): { present: Set<string>; touched: boolean } {
    const present = new Set<string>(); let touched = false;
    const live = new Set<THREE.Mesh>();
    const shadows = ghostShadows(three);
    const used = new Set<string>();
    for (const id of ids) {
        const root = realModel(three, id); if (!root) continue;
        present.add(id);
        root.traverse(n => {
            const mesh = n as THREE.Mesh; if (!mesh.isMesh) return;
            if (n.name === 'omo-shape-shadow' || n.name === 'omo-lamp-pool') return; // a lamp's light pool is not furniture
            live.add(mesh);
            if (!mesh.userData.shapeOrig) {
                mesh.userData.shapeOrig = mesh.material; mesh.userData.shapeCast = mesh.castShadow; mesh.userData.shapeOrder = mesh.renderOrder;
                mesh.material = ghostGlass(); mesh.castShadow = false; mesh.renderOrder = 21;
                ghosted.add(mesh); touched = true;
            }
        });
        const b = new THREE.Box3().setFromObject(root); if (b.isEmpty()) continue;
        const key = `shadow:${id}`; used.add(key);
        let disc = shadows.getObjectByName(key) as THREE.Mesh | undefined;
        if (!disc) {
            disc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false, toneMapped: false }));
            disc.name = key; disc.rotation.x = -Math.PI / 2; disc.renderOrder = 19; disc.raycast = () => undefined;
            shadows.add(disc); touched = true;
        }
        const w = Math.max(0.4, (b.max.x - b.min.x) * 1.25), d = Math.max(0.4, (b.max.z - b.min.z) * 1.25);
        disc.position.set((b.min.x + b.max.x) / 2, Math.max(0.012, b.min.y + 0.012), (b.min.z + b.max.z) / 2);
        disc.scale.set(w, d, 1);
        (disc.material as THREE.MeshBasicMaterial).opacity = 0.75 + 0.2 * k;
    }
    // The scope on the floor: one faint cyan outline (and a whisper of fill) round the whole group.
    const group = new THREE.Box3();
    for (const id of present) { const root = realModel(three, id); if (root) group.expandByObject(root); }
    if (!group.isEmpty() && present.size > 1) {
        used.add('omo-shape-footprint');
        let foot = shadows.getObjectByName('omo-shape-footprint') as THREE.Group | undefined;
        if (!foot) {
            foot = new THREE.Group(); foot.name = 'omo-shape-footprint';
            const pts: THREE.Vector3[] = [], r = 0.18;
            for (let q = 0; q < 4; q++) for (let i = 0; i <= 6; i++) {
                const a = (q + i / 6) * Math.PI / 2, cx = q === 0 || q === 3 ? 0.5 - r : -0.5 + r, cz = q < 2 ? 0.5 - r : -0.5 + r;
                pts.push(new THREE.Vector3(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r));
            }
            pts.push(pts[0].clone());
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9be8ff, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }));
            line.name = 'omo-shape-footprint-line'; line.renderOrder = 22; line.raycast = () => undefined;
            const fill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: GHOST, transparent: true, opacity: 0.07, depthWrite: false, toneMapped: false }));
            fill.rotation.x = -Math.PI / 2; fill.renderOrder = 18; fill.raycast = () => undefined;
            foot.add(fill, line); shadows.add(foot); touched = true;
        }
        const m = 0.3, w = group.max.x - group.min.x + 2 * m, d = group.max.z - group.min.z + 2 * m;
        foot.position.set((group.min.x + group.max.x) / 2, Math.max(0.015, group.min.y + 0.015), (group.min.z + group.max.z) / 2);
        foot.scale.set(w, 1, d);
        ((foot.children[1] as THREE.Line).material as THREE.LineBasicMaterial).opacity = 0.6 + 0.3 * k;
    }
    for (const disc of [...shadows.children]) if (!used.has(disc.name)) { shadows.remove(disc); disc.traverse(n => { const o = n as THREE.Mesh; o.geometry?.dispose(); (o.material as THREE.Material | undefined)?.dispose?.(); }); touched = true; }
    if (!shadows.children.length) three.remove(shadows);
    for (const mesh of [...ghosted]) if (!live.has(mesh)) { restoreMesh(mesh); touched = true; }
    if (ghostMaterial) { const o = 0.52 + 0.08 * k; if (ghostMaterial.uniforms.uOpacity.value !== o) { ghostMaterial.uniforms.uOpacity.value = o; touched = true; } }
    return { present, touched };
}
/** The pending change breathes: real models as ghost glass; build mode's blueprint boxes only while a model loads. */
function breathe(three: THREE.Scene | undefined, ids: string[], world?: WorldSpec): void {
    if (!three) return;
    waitsForProp = propsAwaited(world, ids);
    const k = ids.length ? 0.5 + 0.5 * Math.sin(performance.now() / 520) : 0;
    const real = ghostReal(three, ids, k);
    let touched = real.touched;
    const layer = three.getObjectByName('omo-build-layer');
    layer?.traverse(node => {
        const id = node.userData?.buildEntityId as string | undefined; if (!id) return;
        const on = ids.includes(id);
        // The real model is the ghost: its blueprint box steps aside (kept as the fallback while it loads).
        const hide = on && real.present.has(id);
        if (node.visible === hide) { node.visible = !hide; touched = true; }
        node.traverse(child => {
            const m = (child as THREE.Mesh).material as THREE.Material & { opacity?: number; color?: THREE.Color } | undefined;
            if (!m || Array.isArray(m)) return;
            if (m.userData.shapeBase === undefined) m.userData.shapeBase = m.opacity ?? 1;
            const base = m.userData.shapeBase as number;
            // The ghost glows through walls and the floor of the overview (x-ray), breathing between 40% and 100%.
            if (m.userData.shapeDepth === undefined) m.userData.shapeDepth = m.depthTest;
            const depth = on ? false : m.userData.shapeDepth as boolean;
            if (m.depthTest !== depth) { m.depthTest = depth; m.needsUpdate = true; child.renderOrder = on ? 20 : child.renderOrder; touched = true; }
            if (m.color && m.userData.shapeColor === undefined) m.userData.shapeColor = m.color.getHex();
            if (m.color) { const c = on ? GHOST : m.userData.shapeColor as number; if (m.color.getHex() !== c) { m.color.setHex(c); touched = true; } }
            const next = on ? ((child as THREE.Mesh).isMesh ? 0.38 + 0.24 * k : 0.8 + 0.2 * k) : base;
            if (m.opacity !== next) { m.opacity = next; touched = true; }
        });
    });
    if (touched || ids.length) ambientHost(three)?.invalidate(real.touched);
    const canvas = document.querySelector<HTMLElement>('canvas[data-testid="omo-world-canvas"]');
    if (canvas) {
        const r = [...real.present].join(','), n = String(ghosted.size);
        const props = (world?.entities ?? []).filter(e => ids.includes(e.id) && e.kind === 'decor').map(e => `${e.id}:${e.kind === 'decor' ? e.prop ?? e.decor : ''}`).join(',');
        if (canvas.dataset.ghostReal !== r) canvas.dataset.ghostReal = r; if (canvas.dataset.ghostMeshes !== n) canvas.dataset.ghostMeshes = n; if (canvas.dataset.ghostProps !== props) canvas.dataset.ghostProps = props;
        const foot = String(!!three.getObjectByName('omo-shape-footprint')); if (canvas.dataset.ghostFootprint !== foot) canvas.dataset.ghostFootprint = foot;
    }
}

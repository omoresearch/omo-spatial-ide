/**
 * Build mode (w2 build lane) — the in-world equivalent of Harry's Minecraft Linker + Station Setup.
 *
 * Toggle with B (walking or overview) or the Build button. While it is on:
 * - a palette item makes a ghost that follows the crosshair on the floor (mouse in overview);
 *   R / Shift+R turns it, a click places it — as a step of the pending WorldStore proposal;
 * - a click on an existing thing selects it: move (M), turn (R), delete (Del), rename / resize /
 *   Station Setup in the panel;
 * - the Link tool (K): pick a station, then pick monitor walls / mirrors to make them follow it;
 * - every change is a WorldStore proposal with a diff summary and explicit Apply / Discard;
 *   Ctrl+Z / Ctrl+Shift+Z undo / redo (inside a draft Ctrl+Z drops its last step);
 * - locked stations show a lock and refuse edits (only Unlock is offered).
 *
 * Nothing here starts an agent or sends input to a terminal: build clicks never reach a monitor.
 */
import type { RoomScene } from './room-scene';
import type { FirstPersonControls } from './first-person-controls';
import { sceneControls } from './focus-screen';
import type { WorldStore, WorldStoreChange } from './world-store';
import { entityTitle, describeChange } from './world-store';
import type { WorldEntity, WorldOp, WorldSpec, StationConfig, Transform, RoomEntity, WallSide } from '../common/world-model';
import { applyWorldOps, ROOM_MIN, ROOM_MAX } from '../common/world-model';
import { BuildLayer, GhostSpec, rendererApi, hasWorldRenderer, threeOf } from './build-scene';
import { PaletteId, paletteItem, makeEntity, placement, footprint, normalizeRotation, defaultLinkTarget } from './build-catalog';
import { growFor, roomFromDrag, quarterTurn, roomWalls, polygonHitsWalls, shrinkProblem, shellSizeOps } from './build-room'; // w3:build

export type BuildTool = 'select' | 'place' | 'move' | 'link';
export interface BuildState {
    active: boolean;
    tool: BuildTool;
    item?: PaletteId;
    /** Rotation used for the next placed item (radians). */
    rotation: number;
    selected?: string;
    hover?: string;
    /** Link tool: the station screens will follow. */
    linkSource?: string;
    ghostValid: boolean;
    ghostReason: string;
    /** Station Setup dialog open for this station id. */
    setupFor?: string;
    /** True when the renderer draws the WorldSpec (RoomScene.setWorld exists). */
    worldRenderer: boolean;
    /** Where the ghost is (inspection data for tests and the HUD). */
    ghostAt?: Transform;
    /** Bumps when profile names arrive (re-renders Station Setup). */
    profilesVersion: number;
    /** Short status line for the build HUD. */
    hint: string;
    /** Shown briefly when something was refused. */
    notice: string;
    noticeTone: 'info' | 'warn';
}

export interface BuildModeOptions {
    scene: () => RoomScene | undefined;
    store: () => WorldStore | undefined;
    /** Hermes profiles found on this computer (host status). Names only. */
    profiles: () => string[];
    /** Read-only host status (profile names). Called when Station Setup opens and no desk has read them yet. */
    loadProfiles?: () => Promise<string[]>;
    /** One-line room feedback (footer). */
    message: (text: string) => void;
}

const QUARTER = Math.PI / 2;
const isLinkable = (e: WorldEntity | undefined): boolean => e?.kind === 'monitor-wall' || e?.kind === 'mirror';
const isLocked = (e: WorldEntity | undefined): boolean => e?.kind === 'station' && e.station.locked;

export class BuildMode {
    state: BuildState = { active: false, tool: 'select', rotation: 0, ghostValid: false, ghostReason: '', worldRenderer: false, profilesVersion: 0, hint: '', notice: '', noticeTone: 'info' };
    readonly layer = new BuildLayer();
    private listeners = new Set<() => void>();
    private bound?: { scene: RoomScene; controls?: FirstPersonControls; off: Array<() => void> };
    private boundStore?: { store: WorldStore; off: () => void };
    private ghost?: GhostSpec;
    private lastAim = { x: NaN, z: NaN, rot: NaN, key: '' };
    private pointer?: { x: number; y: number };
    private overviewDown?: { x: number; y: number };
    private noticeTimer?: number;
    private globalOff: Array<() => void> = [];
    private aimFrame = 0;
    /** w3:build — shell ops the current ghost needs (the world grows to fit it on Apply). */
    private ghostGrow: WorldOp[] = [];
    /** w3:build — Room tool: the first corner (drag start or first click) and whether this press set it. */
    private roomAnchor?: { x: number; z: number };
    private roomPress?: { fresh: boolean };

    constructor(private options: BuildModeOptions) {
        // Each drawn frame (walking turns the view): keep the ghost / hover under the crosshair. Cached, so cheap.
        this.layer.onFrame = () => { if (this.state.active && threeOf(this.bound?.scene).navigation === 'walk') this.aim(); };
        if (typeof window === 'undefined') return;
        // Overview mode has no FirstPersonControls: take B / build keys and clicks from the canvas here.
        const key = (event: KeyboardEvent): void => {
            const canvas = threeOf(this.bound?.scene).canvas;
            if (!canvas) return;
            const lost = this.state.active && (event.target === document.body || event.target === document.documentElement);
            if (!lost && (event.target !== canvas || this.bound?.controls?.enabled)) return;
            if (this.handleKey(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
        };
        const down = (event: PointerEvent): void => {
            if (this.roomDown(event)) return; // w3:build: Room tool owns the press (no orbit / look while drawing)
            const t = threeOf(this.bound?.scene);
            if (event.target === t.canvas && t.navigation === 'overview' && event.button === 0) this.overviewDown = { x: event.clientX, y: event.clientY };
        };
        const up = (event: PointerEvent): void => {
            if (this.roomUp(event)) return; // w3:build
            const t = threeOf(this.bound?.scene), start = this.overviewDown; this.overviewDown = undefined;
            // RoomScene's own pointerup still runs (it needs it to end an orbit); its workstation select is swallowed by `ownsClicks`.
            if (!start || event.target !== t.canvas || t.navigation !== 'overview') return;
            if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 5) this.click(event.clientX, event.clientY);
        };
        const move = (event: PointerEvent): void => {
            const t = threeOf(this.bound?.scene);
            if (event.target === t.canvas) { this.pointer = { x: event.clientX, y: event.clientY }; if (this.state.active && t.navigation === 'overview') this.scheduleAim(); }
        };
        const storage = (event: StorageEvent): void => { const store = this.boundStore?.store; if (store && event.key === store.key) store.reloadExternal(event.newValue); };
        window.addEventListener('keydown', key, true); window.addEventListener('pointerdown', down, true);
        window.addEventListener('pointerup', up, true); window.addEventListener('pointermove', move, true);
        window.addEventListener('storage', storage);
        this.globalOff.push(() => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointermove', move, true); window.removeEventListener('storage', storage); });
    }

    get active(): boolean { return this.state.active; }
    /** True while build mode owns clicks: the host must not open a workstation for a scene click. */
    get ownsClicks(): boolean { return this.state.active; }
    get store(): WorldStore | undefined { return this.boundStore?.store; }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

    /** Follow the current scene and store. Cheap; safe to call often. */
    sync(): void {
        const store = this.options.store();
        if (store !== this.boundStore?.store) {
            // Room closed or reconfigured: leave build mode (dropping its draft) while the old store is still bound.
            if (this.state.active) this.exit(true);
            this.boundStore?.off();
            this.boundStore = store ? { store, off: store.onChange(change => this.storeChanged(change)) } : undefined;
            if (store && !store.loaded) store.load();
            this.pushWorld();
        }
        const scene = this.options.scene();
        if (scene !== this.bound?.scene) {
            this.unbindScene();
            if (scene) {
                const controls = sceneControls(scene);
                const off: Array<() => void> = [];
                if (controls) {
                    controls.buildClick = (x, y) => this.state.active ? (this.click(x, y), true) : false;
                    controls.buildKey = event => this.handleKey(event);
                    off.push(() => { if (controls.buildClick) controls.buildClick = undefined; if (controls.buildKey) controls.buildKey = undefined; });
                }
                this.bound = { scene, controls, off };
                this.pushWorld(); this.markWrap(this.state.active);
            }
            this.set({ worldRenderer: hasWorldRenderer(scene) });
        }
        // The THREE.Scene can change under the same RoomScene only on rebuild; attach is idempotent.
        if (this.state.active) this.layer.attach(threeOf(this.bound?.scene).scene);
        else this.layer.detach();
    }

    dispose(): void {
        this.unbindScene(); this.boundStore?.off(); this.boundStore = undefined;
        this.layer.dispose(); this.globalOff.forEach(off => off()); this.globalOff = [];
        if (this.noticeTimer !== undefined) window.clearTimeout(this.noticeTimer);
        cancelAnimationFrame(this.aimFrame); this.listeners.clear();
    }

    // ------------------------------------------------------------------ enter / exit

    toggle(): void { if (this.state.active) this.exit(); else this.enter(); }
    enter(): void {
        this.sync();
        const store = this.store;
        if (!store) { this.options.message('Create your room first, then press B to build.'); return; }
        if (!this.bound) { this.options.message('The 3D room is not ready yet.'); return; }
        this.bound.controls?.releaseTyping();
        this.set({ active: true, tool: 'select', item: undefined, selected: undefined, hover: undefined, linkSource: undefined, setupFor: undefined, notice: '' });
        this.layer.attach(threeOf(this.bound.scene).scene);
        this.markWrap(true); this.pushWorld();
        this.render();
        this.options.message('Build mode · Pick something from the palette · Click a thing to select it · B to leave.');
    }
    /** Leave build mode. A pending draft must be applied or discarded first, unless forced (room closed). */
    exit(force = false): boolean {
        if (!this.state.active) return true;
        if (!force && this.store?.proposal) { this.warn('Apply or discard your changes before you leave build mode.'); return false; }
        if (force) this.store?.discard();
        this.ghost = undefined;
        this.set({ active: false, tool: 'select', item: undefined, selected: undefined, hover: undefined, linkSource: undefined, setupFor: undefined });
        this.layer.render(this.view()); this.layer.detach();
        this.markWrap(false); this.pushWorld();
        this.bound?.controls?.element.focus({ preventScroll: true });
        this.options.message('Build mode off.');
        return true;
    }

    // ------------------------------------------------------------------ tools

    choose(item: PaletteId): void {
        if (!this.state.active) this.enter();
        if (!this.state.active) return;
        const meta = paletteItem(item);
        if (item === 'mirror' && !this.store?.preview.entities.some(e => e.kind === 'station')) { this.warn('Add a desk first. A mirror follows one desk.'); return; }
        this.set({ tool: 'place', item, setupFor: undefined, linkSource: undefined });
        this.lastAim.key = ''; this.roomAnchor = undefined;
        this.focusCanvas(); this.aim();
        this.options.message(item === 'room' ? 'Room · Drag on the floor to draw it (or click two corners) · R turns its doorway · Esc to stop.' : `${meta.title} · Aim at the floor · Click to place · R to turn · Esc to stop.`);
    }
    selectTool(): void { this.roomAnchor = undefined; this.set({ tool: 'select', item: undefined, linkSource: undefined }); this.ghost = undefined; this.render(); }
    linkTool(): void {
        if (!this.state.active) this.enter();
        const sel = this.entity(this.state.selected);
        this.set({ tool: 'link', item: undefined, linkSource: sel?.kind === 'station' ? sel.id : undefined });
        this.ghost = undefined; this.render(); this.focusCanvas();
        this.options.message(this.state.linkSource ? `Link · Now click monitor walls or mirrors to follow ${entityTitle(sel)}.` : 'Link · Click a desk first, then click the monitor walls or mirrors that should follow it.');
    }
    select(id: string | undefined): void {
        this.set({ selected: id, tool: this.state.tool === 'move' ? 'select' : this.state.tool });
        this.ghost = undefined; this.render();
    }
    startMove(): void {
        const e = this.entity(this.state.selected); if (!e) return;
        if (isLocked(e)) { this.warn(`${entityTitle(e)} is locked. Unlock it in Station Setup to move it.`); return; }
        this.set({ tool: 'move', rotation: e.transform.rotation }); this.lastAim.key = ''; this.focusCanvas(); this.aim();
        this.options.message(`Moving ${entityTitle(e)} · Click to put it down · R to turn · Esc to cancel.`);
    }
    rotate(direction: 1 | -1 = 1): void {
        if (this.state.tool === 'place' || this.state.tool === 'move') { this.set({ rotation: normalizeRotation(this.state.rotation + direction * QUARTER) }); this.lastAim.key = ''; this.aim(); return; }
        const e = this.entity(this.state.selected); if (!e) return;
        const rotation = e.kind === 'room' ? quarterTurn(e.transform.rotation + direction * QUARTER) : normalizeRotation(e.transform.rotation + direction * QUARTER); // w3:build: rooms turn in exact quarters
        const turned = { ...e, transform: { ...e.transform, rotation } } as WorldEntity;
        const problem = e.kind === 'room' ? this.fitProblem(this.preview(), turned, true, growFor(this.preview(), turned).ops) : '';
        if (problem) { this.warn(problem); return; }
        this.propose([...(e.kind === 'room' ? growFor(this.preview(), turned).ops : []), { op: 'move', id: e.id, transform: turned.transform }], `Turn ${entityTitle(e)}`);
    }
    remove(): void {
        const e = this.entity(this.state.selected); if (!e) return;
        if (this.propose([{ op: 'remove', id: e.id }], `Remove ${entityTitle(e)}`)) this.set({ selected: undefined, setupFor: undefined });
    }
    rename(id: string, label: string): void {
        const e = this.entity(id), clean = label.trim().slice(0, 60);
        if (!e || !clean || clean === e.label) return;
        const ops: WorldOp[] = [{ op: 'rename', id, label: clean }];
        // A desk's label and its Station Setup name stay the same thing.
        if (e.kind === 'station' && e.station.name !== clean) ops.push({ op: 'update-station', id, station: { name: clean } });
        this.propose(ops, `Rename ${entityTitle(e)} to “${clean}”`);
    }
    resize(id: string, size: { width: number; height: number; elevation: number }): void {
        const e = this.entity(id); if (!e || (e.kind !== 'monitor-wall' && e.kind !== 'web-wall')) return;
        if (e.width === size.width && e.height === size.height && e.elevation === size.elevation) return;
        this.propose([{ op: 'resize', id, width: size.width, height: size.height, elevation: size.elevation }], `Resize ${entityTitle(e)}`);
    }
    /** w3:build — World size: set the shell to width x depth (refused, with the reason, if it cuts something off). */
    resizeWorld(width: number, depth: number): boolean {
        const world = this.preview(), shell = world.shell;
        if (width === shell.width && depth === shell.depth) return false;
        const problem = shrinkProblem(world, width, depth, e => entityTitle(e));
        if (problem) { this.warn(problem); return false; } // growing never cuts anything off; shrinking names what is in the way
        return this.propose(shellSizeOps(width, depth), `World size ${width} × ${depth} m`);
    }
    /** w3:build — open world (no outer walls) on / off. */
    setOpenWorld(open: boolean): void {
        if (!!this.preview().shell.open === open) return;
        this.propose([{ op: 'shell', shell: { open } }], open ? 'Open world' : 'Walled world');
    }
    /** w3:build — Room inspector: size, doorways and theme as one 'reshape' step (the world grows if it must). */
    reshapeRoom(id: string, next: { width: number; depth: number; doors: WallSide[]; theme?: RoomEntity['theme'] }): void {
        const e = this.entity(id); if (e?.kind !== 'room') return;
        const width = Math.min(ROOM_MAX, Math.max(ROOM_MIN, next.width)), depth = Math.min(ROOM_MAX, Math.max(ROOM_MIN, next.depth));
        const sameDoors = JSON.stringify([...(e.doors ?? ['front'])].sort()) === JSON.stringify([...next.doors].sort());
        if (e.width === width && e.depth === depth && sameDoors && (next.theme === undefined || next.theme === e.theme)) return;
        const shaped: RoomEntity = { ...e, width, depth, doors: [...next.doors], ...(next.theme ? { theme: next.theme } : {}) };
        const grow = growFor(this.preview(), shaped);
        const problem = grow.refused ?? this.fitProblem(this.preview(), shaped, true, grow.ops);
        if (problem) { this.warn(problem); return; }
        this.propose([...grow.ops, { op: 'reshape', id, width, depth, doors: [...next.doors], ...(next.theme ? { theme: next.theme } : {}) }], `Reshape ${entityTitle(e)}`);
    }
    unlink(id: string): void { const e = this.entity(id); if (e?.kind === 'monitor-wall' && e.link) this.propose([{ op: 'link', id }], `Unlink ${entityTitle(e)}`); }
    link(id: string, to: string): void {
        const e = this.entity(id), target = this.entity(to);
        if (!e || target?.kind !== 'station') return;
        if (!isLinkable(e)) { this.warn(`${entityTitle(e)} cannot follow a desk. Pick a monitor wall or a mirror.`); return; }
        if ((e.kind === 'mirror' || e.kind === 'monitor-wall') && e.link === to) { this.note(`${entityTitle(e)} already follows ${entityTitle(target)}.`); return; }
        if (this.propose([{ op: 'link', id, to }], `Link ${entityTitle(e)} → ${entityTitle(target)}`)) this.layer.burst(this.preview(), id, to);
    }

    // ------------------------------------------------------------------ Station Setup

    openSetup(id?: string): void {
        const e = this.entity(id ?? this.state.selected);
        if (e?.kind !== 'station') { this.warn('Station Setup is for desks. Select a desk first.'); return; }
        this.bound?.controls?.releaseTyping();
        this.set({ setupFor: e.id, selected: e.id });
        if (!this.options.profiles().length && !this.fetchedProfiles.length && this.options.loadProfiles) {
            void this.options.loadProfiles().then(list => { this.fetchedProfiles = list; this.set({ profilesVersion: this.state.profilesVersion + 1 }); }, () => undefined);
        }
    }
    private fetchedProfiles: string[] = [];
    closeSetup(): void { this.set({ setupFor: undefined }); this.focusCanvas(); }
    /** Save Station Setup as one proposal step. Locked desks only accept `{ locked: false }`. */
    saveSetup(id: string, next: StationConfig, label?: string): boolean {
        const e = this.entity(id); if (e?.kind !== 'station') return false;
        const cur = e.station, ops: WorldOp[] = [];
        if (cur.locked) {
            // A locked desk takes exactly one change: unlock. Edit it after that.
            if (next.locked) { this.warn(`${entityTitle(e)} is locked. Unlock it first.`); return false; }
            const ok = this.propose([{ op: 'update-station', id, station: { locked: false } }], `Unlock ${entityTitle(e)}`);
            if (ok) this.set({ setupFor: undefined });
            return ok;
        }
        const change: Partial<StationConfig> = {};
        if (next.name !== cur.name) change.name = next.name;
        if (next.kind !== cur.kind) change.kind = next.kind;
        if (next.profile !== cur.profile) change.profile = next.profile;
        if (JSON.stringify(next.tabs) !== JSON.stringify(cur.tabs)) change.tabs = next.tabs.map(t => ({ ...t }));
        // `profile: undefined` must be an explicit key so the merge clears it.
        if ('profile' in change || Object.keys(change).length) ops.push({ op: 'update-station', id, station: change });
        const newLabel = (label ?? next.name).trim();
        if (newLabel && newLabel !== e.label) ops.push({ op: 'rename', id, label: newLabel.slice(0, 60) });
        if (next.locked) ops.push({ op: 'update-station', id, station: { locked: true } });
        if (!ops.length) { this.closeSetup(); return true; }
        const ok = this.propose(ops, `Station Setup · ${next.name}`);
        if (ok) this.set({ setupFor: undefined });
        return ok;
    }
    setLocked(id: string, locked: boolean): void {
        const e = this.entity(id); if (e?.kind !== 'station' || e.station.locked === locked) return;
        this.propose([{ op: 'update-station', id, station: { locked } }], `${locked ? 'Lock' : 'Unlock'} ${entityTitle(e)}`);
    }
    profiles(): string[] { return [...new Set([...this.options.profiles(), ...this.fetchedProfiles])].filter(p => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p)); }

    // ------------------------------------------------------------------ proposal

    apply(): void {
        const store = this.store; if (!store?.proposal) return;
        const count = store.proposal.diff.length;
        const result = store.apply();
        this.focusCanvas();
        if (result.ok) this.note(`Applied ${count} change${count === 1 ? '' : 's'}. Ctrl+Z to undo. Nothing was started.`);
        else this.warn(result.error);
    }
    discard(): void { const store = this.store; if (!store?.proposal) return; store.discard(); this.focusCanvas(); this.note('Changes discarded. The world is as it was.'); }
    undo(): void {
        const store = this.store; if (!store) return;
        if (store.proposal) { store.dropLastStep(); this.note('Removed the last unapplied step.'); return; }
        const label = store.undoLabel; const r = store.undo();
        if (r.ok) this.note(`Undid “${label}”.`); else this.warn(r.error);
    }
    redo(): void {
        const store = this.store; if (!store) return;
        if (store.proposal) { this.warn('Apply or discard the pending change before you redo.'); return; }
        const label = store.redoLabel; const r = store.redo();
        if (r.ok) this.note(`Redid “${label}”.`); else this.warn(r.error);
    }

    // ------------------------------------------------------------------ input

    /** Keys while build mode may act (walking, not typing, not attached). True = handled. */
    handleKey(event: KeyboardEvent): boolean {
        const k = event.key.toLowerCase(), plain = !event.ctrlKey && !event.metaKey && !event.altKey;
        if (k === 'b' && plain && !event.shiftKey) { if (!event.repeat) this.toggle(); return true; }
        if (!this.state.active) return false;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && k === 'z') { if (!event.repeat) { if (event.shiftKey) this.redo(); else this.undo(); } return true; }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && k === 'y') { if (!event.repeat) this.redo(); return true; }
        if ((event.ctrlKey || event.metaKey) && k === 'enter') { this.apply(); return true; }
        if (!plain) return false;
        if (k === 'escape') { this.escape(); return true; }
        if (k === 'r') { if (!event.repeat || this.state.tool === 'place' || this.state.tool === 'move') this.rotate(event.shiftKey ? -1 : 1); return true; }
        if (k === 'delete' || k === 'backspace') { this.remove(); return true; }
        if (k === 'm' && !event.shiftKey) { this.startMove(); return true; }
        if (k === 'k' && !event.shiftKey) { this.linkTool(); return true; }
        if (k === 'v' && !event.shiftKey) { this.selectTool(); return true; }
        if (k === 'enter' && !event.shiftKey && this.state.selected && this.entity(this.state.selected)?.kind === 'station') { this.openSetup(); return true; }
        return false;
    }
    private escape(): void {
        if (this.state.setupFor) { this.closeSetup(); return; }
        if (this.roomAnchor) { this.roomAnchor = undefined; this.lastAim.key = ''; this.aim(); this.note('Room corner dropped. Drag or click again to draw a room.'); return; } // w3:build
        if (this.state.tool === 'place' || this.state.tool === 'move' || this.state.tool === 'link') { this.selectTool(); this.options.message('Build mode · Click a thing to select it · B to leave.'); return; }
        if (this.state.selected) { this.select(undefined); return; }
        this.exit();
    }

    /** A plain click on the room while build mode is on. */
    click(clientX: number, clientY: number): void {
        if (!this.state.active) return;
        const { tool } = this.state;
        // Walking: the ghost sits under the crosshair, so that is where it goes. Overview: under the mouse.
        if (tool === 'place' && this.state.item === 'room' && !this.roomAnchor) { // w3:build: walking — the first click sets a corner
            this.lastAim.key = ''; this.aim();
            const t = threeOf(this.bound?.scene), r = t.canvas?.getBoundingClientRect();
            const p = t.camera && t.canvas && r ? this.layer.floorPoint(t.camera, t.canvas, r.left + r.width / 2, r.top + r.height / 2) : undefined;
            if (!p) { this.note('Aim at the floor to set the first corner.'); return; }
            this.roomAnchor = { x: Math.round(p.x * 2) / 2, z: Math.round(p.z * 2) / 2 }; this.lastAim.key = ''; this.aim();
            this.note('First corner set · Aim at the opposite corner and click · Esc to cancel.'); return;
        }
        if (tool === 'place' || tool === 'move') { this.lastAim.key = ''; if (threeOf(this.bound?.scene).navigation === 'overview') this.aim(clientX, clientY); else this.aim(); this.commitGhost(); return; }
        const id = this.pick(clientX, clientY);
        const e = this.entity(id);
        if (tool === 'link') {
            if (!e) { this.note('Click a desk, a monitor wall or a mirror.'); return; }
            if (e.kind === 'station') { this.set({ linkSource: e.id, selected: e.id }); this.render(); this.note(`Linking to ${entityTitle(e)} · Click the monitor walls or mirrors that should follow it · Esc when done.`); return; }
            if (!this.state.linkSource) { this.warn('Pick a desk first, then the screens that follow it.'); return; }
            this.link(e.id, this.state.linkSource); return;
        }
        this.select(e?.id);
        if (e) this.options.message(`${entityTitle(e)} selected · M move · R turn · Del remove${e.kind === 'station' ? ' · Enter Station Setup' : ''}${isLocked(e) ? ' · Locked' : ''}.`);
    }

    // ------------------------------------------------------------------ internals

    private propose(ops: WorldOp[], label: string): boolean {
        const store = this.store; if (!store) return false;
        const target = ops.map(o => 'id' in o ? this.entity(o.id) : undefined).find(isLocked);
        if (target && !ops.every(o => o.op === 'update-station' && Object.keys(o.station).length === 1 && o.station.locked === false)) {
            this.warn(`${entityTitle(target)} is locked. Unlock it in Station Setup first.`); return false;
        }
        const result = store.amend(ops, label);
        if (!result.ok) { this.warn(friendly(result.error, this.preview())); return false; }
        return true;
    }
    private commitGhost(): void {
        const store = this.store, g = this.ghost; if (!store || !g) { this.note('Aim at the floor inside the room.'); return; }
        if (!g.valid) { this.warn(this.state.ghostReason || 'It does not fit there.'); return; }
        if (this.state.tool === 'move') {
            const id = g.entity.id, e = this.entity(id);
            if (this.propose([...this.ghostGrow, { op: 'move', id, transform: { ...g.entity.transform } }], `Move ${entityTitle(e)}`)) { this.set({ tool: 'select' }); this.ghost = undefined; this.render(); }
            return;
        }
        this.roomAnchor = undefined; // w3:build
        if (this.propose([...this.ghostGrow, { op: 'add', entity: g.entity }], `${g.entity.kind === 'room' ? 'Build' : 'Place'} ${entityTitle(g.entity)}`)) { // w3:build: grow first, then add
            this.lastAim.key = ''; this.aim();
            this.options.message(`Placed ${entityTitle(g.entity)} · Click to place another · Esc to stop · Apply when ready.`);
        }
    }
    private pick(clientX: number, clientY: number): string | undefined {
        const scene = this.bound?.scene;
        const api = rendererApi(scene);
        if (typeof api.entityAt === 'function') {
            const hit = api.entityAt(clientX, clientY);
            const id = typeof hit === 'string' ? hit : hit?.id;
            if (id && this.entity(id)) return id;
        }
        const t = threeOf(scene); if (!t.camera || !t.canvas) return undefined;
        return this.layer.pick(t.camera, t.canvas, clientX, clientY);
    }
    private scheduleAim(): void { if (this.aimFrame) return; this.aimFrame = requestAnimationFrame(() => { this.aimFrame = 0; this.aim(); }); }
    /** Recompute the ghost (and hover) from the crosshair (walking) or the mouse (overview). */
    private aim(clientX?: number, clientY?: number): void {
        if (!this.state.active) return;
        const t = threeOf(this.bound?.scene); const store = this.store;
        if (!t.camera || !t.canvas || !store) return;
        let x = clientX, y = clientY;
        if (x === undefined || y === undefined) {
            if (t.navigation === 'walk') { const r = t.canvas.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
            else if (this.pointer) { x = this.pointer.x; y = this.pointer.y; }
            else return;
        }
        const tool = this.state.tool;
        if (tool === 'select' || tool === 'link') {
            const hover = this.pick(x, y);
            if (hover !== this.state.hover) { this.set({ hover }); this.render(); }
            return;
        }
        // t2:worldui — the overview camera orbits ~24-40 m out; the 14 m walking reach made every overview aim miss the floor.
        const floor = this.layer.floorPoint(t.camera, t.canvas, x, y, t.navigation === 'overview' ? 2500 : undefined); // w4:big
        const key = floor ? `${Math.round(floor.x * 8)}:${Math.round(floor.z * 8)}:${this.state.rotation}:${tool}:${this.state.item}:${this.state.selected}:${store.preview.revision}:${store.proposal?.steps.length ?? 0}:${this.roomAnchor ? `${this.roomAnchor.x},${this.roomAnchor.z}` : ''}` : 'none';
        if (key === this.lastAim.key) return;
        this.lastAim.key = key;
        if (!floor) { this.ghost = undefined; this.set({ ghostValid: false, ghostReason: 'Aim at the floor inside the room.' }); this.render(); return; }
        const world = store.preview;
        let entity: WorldEntity | undefined; let wall = false; let snapped = false;
        if (tool === 'move') {
            const e = this.entity(this.state.selected); if (!e) { this.selectTool(); return; }
            wall = e.kind === 'monitor-wall' || e.kind === 'web-wall' || e.kind === 'mirror' || e.kind === 'review-screen' || (e.kind === 'decor' && (e.decor === 'bookshelf' || e.decor === 'window'));
            const fp = footprint(e);
            const p = placement(world, floor, this.state.rotation, wall, fp);
            entity = { ...e, transform: p.transform } as WorldEntity; snapped = p.snapped === 'wall';
            if (entity.kind === 'room') entity.transform = { ...entity.transform, rotation: quarterTurn(entity.transform.rotation) }; // w3:build
        } else if (this.state.item === 'room') {
            entity = this.roomGhost(world, floor); // w3:build
        } else if (this.state.item) {
            const meta = paletteItem(this.state.item);
            const probe = makeEntity(this.state.item, world, { x: floor.x, z: floor.z, rotation: this.state.rotation }, defaultLinkTarget(world, floor, this.state.selected));
            if (!probe) { this.ghost = undefined; this.set({ ghostValid: false, ghostReason: 'Add a desk first. A mirror follows one desk.' }); this.render(); return; }
            const p = placement(world, floor, this.state.rotation, meta.wallMounted, footprint(probe));
            entity = { ...probe, transform: p.transform } as WorldEntity;
            wall = meta.wallMounted; snapped = p.snapped === 'wall';
        }
        if (!entity) return;
        // w3:build — near or past the edge: the world grows (symmetrically) to fit it, up to SHELL_MAX.
        const grow = growFor(world, entity, snapped);
        this.ghostGrow = grow.ops;
        const reason = grow.refused ?? this.fitProblem(world, entity, tool === 'move', grow.ops);
        this.ghost = { entity, valid: !reason, grow: grow.size };
        this.set({ ghostValid: !reason, ghostReason: reason, ghostAt: entity.transform });
        this.render();
    }
    // ------------------------------------------------------------------ w3:build Room tool

    /** The room the Room tool would build for this floor point (from the anchor corner when one is set). */
    private roomGhost(world: WorldSpec, floor: { x: number; z: number }): WorldEntity | undefined {
        const rotation = quarterTurn(this.state.rotation);
        const a = this.roomAnchor ?? { x: floor.x - ROOM_MIN / 2, z: floor.z - ROOM_MIN / 2 }, b = this.roomAnchor ? floor : { x: floor.x + ROOM_MIN / 2, z: floor.z + ROOM_MIN / 2 };
        const r = roomFromDrag(a, b, ROOM_MIN, ROOM_MAX);
        const probe = makeEntity('room', world, { x: r.x, z: r.z, rotation });
        if (probe?.kind !== 'room') return undefined;
        // A quarter turn swaps the room's own width and depth, so the floor plan stays as drawn.
        const turned = Math.abs(Math.round(rotation / QUARTER)) % 2 === 1;
        return { ...probe, width: turned ? r.depth : r.width, depth: turned ? r.width : r.depth };
    }
    /** Floor point for a press: the mouse in overview, the crosshair while walking. */
    private pressPoint(event: PointerEvent): { x: number; z: number } | undefined {
        const t = threeOf(this.bound?.scene); if (!t.camera || !t.canvas) return undefined;
        const r = t.canvas.getBoundingClientRect();
        const x = t.navigation === 'walk' ? r.left + r.width / 2 : event.clientX, y = t.navigation === 'walk' ? r.top + r.height / 2 : event.clientY;
        return this.layer.floorPoint(t.camera, t.canvas, x, y, t.navigation === 'overview' ? 2500 : undefined); // w4:big
    }
    private roomDown(event: PointerEvent): boolean {
        const t = threeOf(this.bound?.scene);
        // Overview only: walking keeps its look-drag, and draws a room with two clicks (see click()).
        if (!this.state.active || this.state.tool !== 'place' || this.state.item !== 'room' || event.button !== 0 || event.target !== t.canvas || t.navigation !== 'overview') return false;
        const p = this.pressPoint(event);
        if (!p) return false;
        event.stopImmediatePropagation(); event.preventDefault();
        const fresh = !this.roomAnchor;
        if (fresh) this.roomAnchor = { x: Math.round(p.x * 2) / 2, z: Math.round(p.z * 2) / 2 };
        this.roomPress = { fresh };
        this.lastAim.key = ''; this.aim(t.navigation === 'overview' ? event.clientX : undefined, t.navigation === 'overview' ? event.clientY : undefined);
        return true;
    }
    private roomUp(event: PointerEvent): boolean {
        const press = this.roomPress; if (!press) return false;
        this.roomPress = undefined; event.stopImmediatePropagation();
        const t = threeOf(this.bound?.scene), p = this.pressPoint(event), a = this.roomAnchor;
        if (!a || !p) return true;
        // A plain click sets the first corner; a drag, or a second click, builds the room.
        if (press.fresh && Math.hypot(p.x - a.x, p.z - a.z) < 0.75) { this.note('First corner set · Click the opposite corner (or drag) · Esc to cancel.'); return true; }
        this.lastAim.key = ''; this.aim(t.navigation === 'overview' ? event.clientX : undefined, t.navigation === 'overview' ? event.clientY : undefined);
        if (this.ghost?.valid) this.commitGhost();
        else { this.roomAnchor = undefined; this.warn(this.state.ghostReason || 'The room does not fit there.'); this.lastAim.key = ''; this.aim(); }
        return true;
    }

    /** Why `entity` cannot go where it is ('' = it fits). */
    private fitProblem(world: WorldSpec, entity: WorldEntity, moving: boolean, grow: WorldOp[] = []): string {
        const ops: WorldOp[] = [...grow, moving ? { op: 'move', id: entity.id, transform: entity.transform } : { op: 'add', entity }];
        const r = applyWorldOps(world, ops);
        if (!r.ok) return friendly(r.error, world);
        const solid = (e: WorldEntity): boolean => e.kind === 'station' || (e.kind === 'decor' && e.decor !== 'rug' && e.decor !== 'window');
        const wallish = (e: WorldEntity): boolean => !solid(e) && e.kind !== 'room' && !(e.kind === 'decor' && e.decor === 'rug'); // w3:build: a room is a floor
        // w3:build — rooms: no overlap with another room; solid things may stand inside, only the room walls block them.
        for (const other of world.entities) {
            if (other.id === entity.id) continue;
            if (entity.kind === 'room' && other.kind === 'room' && overlaps(entity, other)) return `Overlaps ${entityTitle(other)}.`;
            if (entity.kind === 'room' && solid(other) && polygonHitsWalls(corners(other), roomWalls(entity))) return `A wall would cut through ${entityTitle(other)}.`;
            if (other.kind === 'room' && solid(entity) && polygonHitsWalls(corners(entity), roomWalls(other))) return `That is on a wall of ${entityTitle(other)}.`;
        }
        const pose = this.bound?.scene.getPlayerPose();
        if (solid(entity) && pose && threeOf(this.bound?.scene).navigation === 'walk' && inside(entity, pose)) return 'You are standing there. Step back a little.';
        for (const other of world.entities) {
            if (other.id === entity.id) continue;
            const clash = (solid(entity) && solid(other)) || (wallish(entity) && wallish(other) && Math.abs(entity.transform.rotation - other.transform.rotation) < 0.01);
            if (clash && overlaps(entity, other)) return `Too close to ${entityTitle(other)}.`;
        }
        return '';
    }
    private storeChanged(change: WorldStoreChange): void {
        this.pushWorld();
        if (change.reason === 'error' && change.error) this.warn(change.error);
        // A selected thing that no longer exists (removed, undone) is dropped.
        if (this.state.selected && !this.entity(this.state.selected)) this.set({ selected: undefined, setupFor: undefined });
        if (this.state.linkSource && this.entity(this.state.linkSource)?.kind !== 'station') this.set({ linkSource: undefined });
        if (change.reason === 'external') this.note('This world was changed in another window. You see the latest version.');
        this.lastAim.key = '';
        if (this.state.active) this.aim();
        this.render();
    }
    /** Hand the renderer the world to draw: the preview while building, the applied world otherwise. */
    private pushWorld(): void {
        const store = this.store, api = rendererApi(this.bound?.scene);
        if (!store || typeof api.setWorld !== 'function') return;
        try { api.setWorld(this.state.active ? store.preview : store.world); } catch (error) { this.warn(`The room could not draw this world: ${error instanceof Error ? error.message : String(error)}`); }
    }
    private view(): Parameters<BuildLayer['render']>[0] {
        const store = this.store;
        const world = store?.preview ?? emptyWorld;
        const pending = new Set<string>();
        if (store?.proposal) {
            const base = new Map(store.world.entities.map(e => [e.id, JSON.stringify(e)]));
            for (const e of world.entities) if (base.get(e.id) !== JSON.stringify(e)) pending.add(e.id);
        }
        const moving = this.state.tool === 'move' ? this.state.selected : undefined;
        return {
            world: moving ? { ...world, entities: world.entities.filter(e => e.id !== moving) } : world,
            pending, ghost: this.state.active ? this.ghost : undefined, selected: this.state.selected, hover: this.state.hover,
            linkSource: this.state.tool === 'link' ? this.state.linkSource : undefined, solid: !this.state.worldRenderer
        };
    }
    private render(): void {
        if (this.state.active) { this.layer.attach(threeOf(this.bound?.scene).scene); this.layer.render(this.view()); }
        this.set({ hint: this.hintText() });
    }
    private hintText(): string {
        const { tool, item, ghostValid, ghostReason } = this.state;
        if (!this.state.active) return '';
        const grows = ghostValid && this.ghost?.grow ? ` · The world grows to ${this.ghost.grow.width} × ${this.ghost.grow.depth} m` : ''; // w3:build
        if (tool === 'place' && item === 'room') return ghostValid ? (this.roomAnchor ? `Release or click to build ${this.ghost?.entity.kind === 'room' ? `${this.ghost.entity.width} × ${this.ghost.entity.depth} m` : 'it'}${grows} · Esc cancel` : `Drag on the floor to draw a room (at least ${ROOM_MIN} m)${grows} · R turns its doorway`) : ghostReason || 'Aim at the floor'; // w3:build
        if (tool === 'place') return ghostValid ? `Click to place ${paletteItem(item ?? 'agent-desk').title}${grows} · R turn · Esc stop` : ghostReason || 'Aim at the floor';
        if (tool === 'move') return ghostValid ? `Click to put it down${grows} · R turn · Esc cancel` : ghostReason || 'Aim at the floor';
        if (tool === 'link') return this.state.linkSource ? `Click screens to follow ${entityTitle(this.entity(this.state.linkSource))} · Esc done` : 'Click a desk to link from';
        return this.state.selected ? 'M move · R turn · Del remove · Esc deselect' : 'Click a thing to select it · B leave';
    }
    private unbindScene(): void {
        if (!this.bound) return;
        this.bound.off.forEach(off => off());
        this.layer.detach();
        this.bound = undefined;
    }
    /** `data-building` on the scene wrapper: crosshair cursor, dimmed workstation labels (build-mode.css). */
    private markWrap(on: boolean): void { const wrap = threeOf(this.bound?.scene).canvas?.closest('.omo-scene-wrap') as HTMLElement | null; if (wrap) wrap.dataset.building = String(on); }
    private focusCanvas(): void { const c = threeOf(this.bound?.scene).canvas; c?.focus({ preventScroll: true }); }
    private entity(id: string | undefined): WorldEntity | undefined { return id ? this.store?.preview.entities.find(e => e.id === id) : undefined; }
    private preview(): WorldSpec { return this.store?.preview ?? emptyWorld; }
    private note(text: string): void { this.flash(text, 'info'); }
    private warn(text: string): void { this.flash(text, 'warn'); }
    private flash(text: string, tone: 'info' | 'warn'): void {
        this.options.message(text);
        if (this.noticeTimer !== undefined) window.clearTimeout(this.noticeTimer);
        this.set({ notice: text, noticeTone: tone });
        this.noticeTimer = window.setTimeout(() => { this.noticeTimer = undefined; this.set({ notice: '' }); }, 4200);
    }
    private set(patch: Partial<BuildState>): void {
        const next = { ...this.state, ...patch };
        if ((Object.keys(patch) as Array<keyof BuildState>).every(k => next[k] === this.state[k])) return;
        this.state = next;
        for (const l of [...this.listeners]) { try { l(); } catch { /* UI listener errors stay in the UI */ } }
    }
    /** Called by the panel on every animation-free update: keeps the walking ghost under the crosshair. */
    follow(): void { if (this.state.active) this.aim(); }
    /** Summary lines for the pending proposal (fresh, for the panel). */
    diff(): string[] { const s = this.store; return s?.proposal ? describeChange(s.world, s.preview) : []; }
}

const emptyWorld: WorldSpec = { version: 2, name: 'World', shell: { theme: 'station', width: 12, depth: 10 }, entities: [], revision: 0 };

/** Contract errors in words a person reads. */
function friendly(error: string, world: WorldSpec): string {
    const id = /^([a-z0-9-]+) (is locked|does not exist|already exists)/.exec(error);
    if (id) { const e = world.entities.find(x => x.id === id[1]); return `${entityTitle(e, id[1])} ${id[2]}.`; }
    if (/Entity .* is invalid/.test(error)) return 'It does not fit there.';
    return error;
}

/** Rotated footprint rectangles overlap (separating axis test, 2D). */
function overlaps(a: WorldEntity, b: WorldEntity): boolean {
    const ca = corners(a), cb = corners(b);
    for (const poly of [ca, cb]) for (let i = 0; i < 2; i++) {
        const p = poly[i], q = poly[i + 1], ax = { x: -(q.z - p.z), z: q.x - p.x };
        const proj = (pts: Array<{ x: number; z: number }>): [number, number] => { let lo = Infinity, hi = -Infinity; for (const c of pts) { const d = c.x * ax.x + c.z * ax.z; lo = Math.min(lo, d); hi = Math.max(hi, d); } return [lo, hi]; };
        const [a0, a1] = proj(ca), [b0, b1] = proj(cb);
        if (a1 <= b0 + 1e-3 || b1 <= a0 + 1e-3) return false;
    }
    return true;
}
/** Point inside an entity's footprint (with a small body margin). */
function inside(e: WorldEntity, p: { x: number; z: number }): boolean {
    const fp = footprint(e), t = e.transform, c = Math.cos(t.rotation), s = Math.sin(t.rotation);
    const dx = p.x - t.x, dz = p.z - t.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
    return Math.abs(lx) < fp.width / 2 + 0.25 && Math.abs(lz - fp.offsetZ) < fp.depth / 2 + 0.25;
}
function corners(e: WorldEntity): Array<{ x: number; z: number }> {
    const fp = footprint(e), t: Transform = e.transform, c = Math.cos(t.rotation), s = Math.sin(t.rotation);
    const hw = fp.width / 2 - 0.05, z0 = fp.offsetZ - fp.depth / 2 + 0.05, z1 = fp.offsetZ + fp.depth / 2 - 0.05;
    // THREE rotation.y: x' = x cos + z sin, z' = -x sin + z cos.
    return [[-hw, z0], [hw, z0], [hw, z1], [-hw, z1]].map(([x, z]) => ({ x: t.x + x * c + z * s, z: t.z - x * s + z * c }));
}

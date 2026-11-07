/**
 * w2:admin — the in-world Hermes admin console controller.
 *
 * The user types a request; the backend plans a WorldProposal (rules by default, the local Hermes
 * CLI only when the user turned on "Use Hermes" AND confirmed). The proposal is shown, never
 * applied, until the user presses Apply. Apply and Discard go through the world store
 * (WorldStore.propose / apply / discard from the build lane).
 *
 * STUB NOTE: the build lane's WorldStore is not in this branch yet. `AdminWorldStore` below is
 * the minimal interface this console needs; `LocalAdminWorldStore` is a stand-in that keeps the
 * world in localStorage under the shared `worldStorageKey` (migrating the v1 room on first use).
 * At merge time pass the real WorldStore (it should satisfy AdminWorldStore, or wrap it).
 * If the store has `preview(proposal | undefined)` (build lane ghost preview), the console calls
 * it to highlight the proposed changes in the room; otherwise the preview is the op list only.
 */
import { applyWorldOps, validateWorld, worldFromRoomV1, worldStorageKey } from '../common/world-model';
import type { WorldProposal, WorldResult, WorldSpec } from '../common/world-model';
import type { RoomState } from '../common/room-state';
import type { WorldAdminHermesStatus, WorldAdminPlan, WorldAdminService } from '../common/world-admin-protocol';
import { WORLD_ADMIN_PROFILE_RE, WORLD_ADMIN_PROMPT_MAX } from '../common/world-admin-protocol';

/** What the admin console needs from the world store (build lane). */
export interface AdminWorldStore {
    /** The current applied world, or undefined before a room exists. */
    readonly world: WorldSpec | undefined;
    /** Register a pending proposal (shown, not applied). */
    propose(proposal: WorldProposal): void;
    /** Apply a registered proposal atomically. Must refuse if the world moved past baseRevision. */
    apply(proposalId: string): WorldResult;
    /** Drop a pending proposal. */
    discard(proposalId: string): void;
    /** Optional: show ghost previews for a proposal in the room (undefined clears). */
    preview?(proposal: WorldProposal | undefined): void;
    /** Optional: called when the world changes outside the console. Returns an unsubscribe. */
    subscribe?(listener: () => void): () => void;
}

/** STUB until the build lane's WorldStore lands: world v2 kept in localStorage, v1 room migrated. */
export class LocalAdminWorldStore implements AdminWorldStore {
    private pending = new Map<string, WorldProposal>();
    private listeners = new Set<() => void>();
    private current: WorldSpec | undefined;

    constructor(private readonly storage: Storage | undefined, readonly projectUri: string, room: RoomState | undefined) {
        this.current = this.load(room); this.lastRoom = room;
    }
    get world(): WorldSpec | undefined { return this.current; }
    private load(room: RoomState | undefined): WorldSpec | undefined {
        try {
            const raw = this.storage?.getItem(worldStorageKey(this.projectUri));
            if (raw) { const parsed = validateWorld(JSON.parse(raw)); if (parsed.ok) return parsed.world; }
        } catch { /* fall back to the v1 room */ }
        return room ? worldFromRoomV1(room) : undefined;
    }
    private lastRoom: RoomState | undefined;
    /** The v1 room changed (Customise room): re-migrate only if no v2 world was saved yet. */
    syncRoom(room: RoomState | undefined): void {
        if (room === this.lastRoom) return;
        this.lastRoom = room;
        const saved = (() => { try { return this.storage?.getItem(worldStorageKey(this.projectUri)); } catch { return undefined; } })();
        if (!saved) { this.current = room ? worldFromRoomV1(room) : undefined; this.emit(); }
    }
    propose(proposal: WorldProposal): void { this.pending.set(proposal.id, proposal); }
    discard(proposalId: string): void { this.pending.delete(proposalId); }
    apply(proposalId: string): WorldResult {
        const proposal = this.pending.get(proposalId);
        if (!proposal) return { ok: false, error: 'This proposal is no longer pending.' };
        if (!this.current) return { ok: false, error: 'There is no world yet. Create your room first.' };
        if (proposal.baseRevision !== this.current.revision) return { ok: false, error: 'The world changed since this plan was made. Ask again for a fresh plan.' };
        const result = applyWorldOps(this.current, proposal.ops);
        if (!result.ok) return result;
        try { this.storage?.setItem(worldStorageKey(this.projectUri), JSON.stringify(result.world)); }
        catch { return { ok: false, error: 'The world could not be saved: browser storage is unavailable.' }; }
        this.current = result.world; this.pending.delete(proposalId); this.emit();
        return result;
    }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private emit(): void { for (const l of [...this.listeners]) { try { l(); } catch { /* listener */ } } }
}

export type AdminEntryStatus = 'thinking' | 'proposed' | 'applied' | 'discarded' | 'stale' | 'failed' | 'answered';
export interface AdminEntry {
    id: string;
    prompt: string;
    at: number;
    planner: 'rules' | 'hermes';
    status: AdminEntryStatus;
    plan?: WorldAdminPlan;
    /** Result text after Apply/Discard, or the error. */
    outcome?: string;
}

export interface AdminState {
    open: boolean;
    entries: AdminEntry[];
    /** The entry whose proposal is being previewed (latest pending). */
    activeId?: string;
    useHermes: boolean;
    /** True once the user confirmed Hermes use in this panel session. Reset when Hermes is turned off. */
    hermesConfirmed: boolean;
    /** True while the confirmation step is showing. */
    confirmingHermes: boolean;
    profile: string;
    hermes?: WorldAdminHermesStatus;
    busy: boolean;
    error: string;
}

export interface AdminControllerHost {
    service: WorldAdminService;
    store: () => AdminWorldStore | undefined;
    onChange: (state: AdminState) => void;
    /** Short status line for the footer / toast. */
    message?: (text: string) => void;
    storage?: Storage;
}

const MAX_ENTRIES = 30;
const PROFILE_KEY = 'omo.admin.profile.v1';
let entrySeq = 0;

export class AdminController {
    state: AdminState = { open: false, entries: [], useHermes: false, hermesConfirmed: false, confirmingHermes: false, profile: 'default', busy: false, error: '' };
    private epoch = 0;
    private offStore?: () => void;

    constructor(private readonly host: AdminControllerHost) {
        try { const saved = host.storage?.getItem(PROFILE_KEY); if (saved && WORLD_ADMIN_PROFILE_RE.test(saved)) this.state.profile = saved; } catch { /* default */ }
    }

    private emit(patch: Partial<AdminState>): void { this.state = { ...this.state, ...patch }; this.host.onChange(this.state); }
    private patchEntry(id: string, patch: Partial<AdminEntry>): void {
        this.emit({ entries: this.state.entries.map(e => e.id === id ? { ...e, ...patch } : e) });
    }

    get activeEntry(): AdminEntry | undefined { return this.state.entries.find(e => e.id === this.state.activeId); }

    toggle(open = !this.state.open): void {
        if (open === this.state.open) return;
        if (open) {
            const store = this.host.store();
            this.offStore?.();
            this.offStore = store?.subscribe?.(() => this.worldChanged());
            this.emit({ open: true, error: '' });
            this.showPreview();
        } else {
            this.host.store()?.preview?.(undefined);
            this.offStore?.(); this.offStore = undefined;
            this.emit({ open: false, confirmingHermes: false });
        }
    }

    /** The world changed (another edit or apply): pending plans built on an older revision go stale. */
    private worldChanged(): void {
        const world = this.host.store()?.world;
        if (!world) return;
        const entries = this.state.entries.map(e => e.status === 'proposed' && e.plan?.proposal && e.plan.proposal.baseRevision !== world.revision
            ? { ...e, status: 'stale' as const, outcome: 'The world changed after this plan was made. Ask again for a fresh plan.' } : e);
        this.emit({ entries });
        this.showPreview();
    }

    // ---- Hermes opt-in -------------------------------------------------------------------
    setUseHermes(on: boolean): void {
        if (!on) { this.emit({ useHermes: false, hermesConfirmed: false, confirmingHermes: false }); return; }
        // Turning it on only opens the confirmation step. Nothing starts.
        this.emit({ confirmingHermes: true, error: '' });
        void this.refreshHermes();
    }
    confirmHermes(): void {
        if (this.state.hermes && (!this.state.hermes.available || this.state.hermes.busy)) { this.emit({ confirmingHermes: false, error: this.state.hermes.message }); return; }
        this.emit({ useHermes: true, hermesConfirmed: true, confirmingHermes: false });
    }
    cancelHermes(): void { this.emit({ useHermes: false, hermesConfirmed: false, confirmingHermes: false }); }
    setProfile(profile: string): void {
        const value = profile.trim().toLowerCase().slice(0, 64);
        // A different profile needs its own confirmation.
        this.emit({ profile: value, ...(value !== this.state.profile ? { hermesConfirmed: false, useHermes: false } : {}), hermes: undefined });
        if (WORLD_ADMIN_PROFILE_RE.test(value)) { try { this.host.storage?.setItem(PROFILE_KEY, value); } catch { /* memory only */ } }
    }
    async refreshHermes(): Promise<void> {
        const profile = this.state.profile || 'default';
        if (!WORLD_ADMIN_PROFILE_RE.test(profile)) { this.emit({ hermes: { available: false, busy: false, profile, message: 'Profile names use a–z, 0–9, dot, dash and underscore.' } }); return; }
        try { const hermes = await this.host.service.hermesStatus(profile); if (profile === this.state.profile) this.emit({ hermes }); }
        catch (error) { this.emit({ hermes: { available: false, busy: false, profile, message: `Hermes status is unavailable: ${String(error)}` } }); }
    }

    // ---- Asking ----------------------------------------------------------------------------
    async ask(prompt: string): Promise<void> {
        const text = prompt.trim();
        if (!text || this.state.busy) return;
        if (text.length > WORLD_ADMIN_PROMPT_MAX) { this.emit({ error: `Keep the request under ${WORLD_ADMIN_PROMPT_MAX} characters.` }); return; }
        const store = this.host.store();
        const world = store?.world;
        if (!store || !world) { this.emit({ error: 'Create your room first. The admin edits a saved world.' }); return; }
        const useHermes = this.state.useHermes && this.state.hermesConfirmed;
        const id = `e${Date.now().toString(36)}${(++entrySeq).toString(36)}`;
        // A new request replaces the pending one (it is discarded, never applied).
        const prev = this.activeEntry;
        if (prev?.status === 'proposed' && prev.plan?.proposal) { store.discard(prev.plan.proposal.id); }
        const entries = this.state.entries.map(e => e.id === prev?.id && e.status === 'proposed' ? { ...e, status: 'discarded' as const, outcome: 'Replaced by a newer request.' } : e);
        const entry: AdminEntry = { id, prompt: text, at: Date.now(), planner: useHermes ? 'hermes' : 'rules', status: 'thinking' };
        store.preview?.(undefined);
        this.emit({ entries: [...entries, entry].slice(-MAX_ENTRIES), activeId: id, busy: true, error: '' });
        const epoch = ++this.epoch;
        try {
            const plan = await this.host.service.plan({ world, prompt: text, ...(useHermes ? { useHermes: true, confirmedHermes: true, profile: this.state.profile || 'default' } : {}) });
            if (epoch !== this.epoch) return;
            if (plan.proposal) {
                const now = this.host.store()?.world;
                if (!now || now.revision !== plan.proposal.baseRevision) {
                    this.patchEntry(id, { plan, status: 'stale', outcome: 'The world changed while the plan was made. Ask again.' });
                } else {
                    this.host.store()?.propose(plan.proposal);
                    this.patchEntry(id, { plan, status: 'proposed' });
                }
            } else {
                this.patchEntry(id, { plan, status: plan.error ? 'failed' : 'answered' });
            }
        } catch (error) {
            if (epoch === this.epoch) this.patchEntry(id, { status: 'failed', outcome: `The admin could not plan this: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            if (epoch === this.epoch) { this.emit({ busy: false }); this.showPreview(); }
        }
    }

    private showPreview(): void {
        const entry = this.activeEntry;
        this.host.store()?.preview?.(this.state.open && entry?.status === 'proposed' ? entry.plan?.proposal ?? undefined : undefined);
    }

    apply(entryId: string): void {
        const entry = this.state.entries.find(e => e.id === entryId);
        const store = this.host.store();
        const proposal = entry?.plan?.proposal;
        if (!entry || entry.status !== 'proposed' || !proposal || !store) return;
        store.preview?.(undefined);
        const result = store.apply(proposal.id);
        if (result.ok) {
            this.patchEntry(entryId, { status: 'applied', outcome: `Applied ${proposal.ops.length} change${proposal.ops.length === 1 ? '' : 's'}. Nothing was started.` });
            this.host.message?.(`World updated: ${proposal.summary}`);
        } else {
            this.patchEntry(entryId, { status: /changed since/.test(result.error) ? 'stale' : 'failed', outcome: `Not applied: ${result.error}` });
        }
        this.showPreview();
    }

    discard(entryId: string): void {
        const entry = this.state.entries.find(e => e.id === entryId);
        if (!entry || entry.status !== 'proposed') return;
        if (entry.plan?.proposal) this.host.store()?.discard(entry.plan.proposal.id);
        this.patchEntry(entryId, { status: 'discarded', outcome: 'Discarded. The world was not changed.' });
        this.showPreview();
    }

    clear(): void {
        const store = this.host.store();
        for (const e of this.state.entries) if (e.status === 'proposed' && e.plan?.proposal) store?.discard(e.plan.proposal.id);
        store?.preview?.(undefined);
        ++this.epoch;
        this.emit({ entries: [], activeId: undefined, busy: false, error: '' });
    }

    dispose(): void {
        ++this.epoch;
        this.host.store()?.preview?.(undefined);
        this.offStore?.(); this.offStore = undefined;
    }
}

/** Key binding: H while walking in the room (canvas focused, not typing on a screen), or Alt+Shift+H anywhere in the World. */
export const ADMIN_TOGGLE_EVENT = 'omo:admin-toggle';
export function bindAdminKeys(isWalking: () => boolean, inWorld: (target: EventTarget | null) => boolean): () => void {
    const down = (event: KeyboardEvent): void => {
        if (event.ctrlKey || event.metaKey || event.repeat) return;
        const anywhere = event.altKey && event.shiftKey && event.code === 'KeyH' && inWorld(event.target);
        const walking = !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'h' && isWalking();
        if (!anywhere && !walking) return;
        event.preventDefault(); event.stopImmediatePropagation();
        window.dispatchEvent(new CustomEvent(ADMIN_TOGGLE_EVENT));
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
}

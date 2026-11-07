/**
 * w2:admin — the in-world "Hermes admin" protocol.
 *
 * The user asks for a change in plain words ("add a third desk for Codex and a big monitor wall
 * linked to it"). The backend answers with a WorldProposal: a list of WorldOps against the
 * world the user sent. Nothing is applied here. The user applies or discards it in the Admin
 * panel, through the world store.
 *
 * Two planners:
 *  - 'rules'  deterministic, no model, always available (default);
 *  - 'hermes' the user's local Hermes CLI, one non-interactive call with no tools. Only used when
 *    the user turned on "Use Hermes" in the Admin panel AND confirmed (`confirmedHermes: true`).
 *    The backend refuses a profile that holds a live Hermes turn lease.
 */
import type { WorldProposal, WorldSpec } from './world-model';

export const OMO_WORLD_ADMIN_PATH = '/services/omo-world-admin';
export const WorldAdminService = Symbol('WorldAdminService');

export const WORLD_ADMIN_PROMPT_MAX = 2000;
/** Hermes profile names the admin may use: lower case, the form Hermes itself resolves. */
export const WORLD_ADMIN_PROFILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type WorldAdminPlanner = 'rules' | 'hermes';

export interface WorldAdminRequest {
    /** The world as the user sees it now. The proposal's baseRevision is this world's revision. */
    world: WorldSpec;
    prompt: string;
    /** Hermes profile for the 'hermes' planner; omitted = 'default'. Never a path. */
    profile?: string;
    /** Ask the local Hermes CLI instead of the rule-based planner. */
    useHermes?: boolean;
    /** Must be true when useHermes is true: the user confirmed the Hermes call in the panel. */
    confirmedHermes?: boolean;
}

export interface WorldAdminPlan {
    /** null when nothing could be planned (see explanation / error). */
    proposal: WorldProposal | null;
    /** Plain-language answer for the conversation list. */
    explanation: string;
    planner: WorldAdminPlanner;
    /** One readable line per op, same order as proposal.ops. */
    steps: string[];
    /** Parts of the request the planner did not understand or could not do. */
    notes: string[];
    /** Set when the request was refused or the planner failed. */
    error?: string;
}

export interface WorldAdminHermesStatus {
    /** A Hermes executable was found on this machine. The path is never sent. */
    available: boolean;
    /** The profile currently holds a live Hermes turn lease (another turn is running). */
    busy: boolean;
    profile: string;
    message: string;
}

export interface WorldAdminService {
    plan(request: WorldAdminRequest): Promise<WorldAdminPlan>;
    /** Read-only check for the panel: is Hermes installed and is the profile free? Starts nothing. */
    hermesStatus(profile?: string): Promise<WorldAdminHermesStatus>;
}

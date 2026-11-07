/**
 * w2:onboard — optional "Plan with Hermes" path through the admin lane's planner.
 *
 * The admin lane owns `common/world-admin-protocol.ts` with `WorldAdminService.plan(...)`. It is not
 * merged into this branch yet, so onboarding depends only on the small structural interface below and
 * an optional DI token. When nothing is bound, the "Plan with Hermes" box is disabled and the offline
 * planner (onboarding-planner.ts) is the only path.
 *
 * Rules: the admin planner is called ONLY after the user ticks "Plan with Hermes" AND confirms the
 * dialog. Its answer is only a proposal: it is validated by the shared contract, cleaned of unsafe
 * URLs, shown in step 2 for review, and saved only when the user presses Create. No agent starts.
 *
 * MERGE (admin lane): in omo-frontend-module.ts add one line, for example
 *   bind(OnboardingPlanBackend).toDynamicValue(ctx => adaptWorldAdmin(ctx.container.get(WorldAdminService))).inSingletonScope(); // w2:onboard
 * `adaptWorldAdmin` accepts any object with a `plan(request)` method returning a WorldSpec, a
 * WorldProposal / { ops }, or { world } / { proposal }.
 */
import { applyWorldOps, validateWorld } from '../common/world-model';
import type { WorldOp, WorldSpec } from '../common/world-model';
import type { RoomTheme } from '../common/room-state';
import { applyOnboardingEdit, emptyWorld, safeHomeUrl, sanitizePlanText } from './onboarding-planner';
import type { PlanResult } from './onboarding-planner';

export const OnboardingPlanBackend = Symbol('OnboardingPlanBackend');

export interface OnboardingPlanRequest {
    prompt: string;
    name: string;
    theme?: RoomTheme;
    /** Optional starting world (re-planning an existing room). */
    base?: WorldSpec;
    source: 'onboarding';
    /** The user ticked "Plan with Hermes" and confirmed. */
    useHermes: true;
}

export interface OnboardingPlanBackend {
    plan(request: OnboardingPlanRequest): Promise<unknown>;
}

/** Wrap the admin lane's WorldAdminService (any `plan` signature taking one request object). */
export function adaptWorldAdmin(service: { plan: (request: never) => Promise<unknown> }): OnboardingPlanBackend {
    return { plan: request => (service.plan as (r: unknown) => Promise<unknown>)(request) };
}

const PLAN_TIMEOUT_MS = 60_000;

/** Ask the backend, then turn whatever it returns into a validated, arranged PlanResult. */
export async function planWithBackend(backend: OnboardingPlanBackend, request: OnboardingPlanRequest): Promise<PlanResult> {
    const prompt = sanitizePlanText(request.prompt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Hermes did not answer within 60 seconds. Nothing was changed.')), PLAN_TIMEOUT_MS); });
    let answer: unknown;
    try { answer = await Promise.race([backend.plan({ ...request, prompt }), timeout]); }
    finally { if (timer) clearTimeout(timer); }
    return normalizePlanAnswer(answer, { ...request, prompt });
}

export function normalizePlanAnswer(answer: unknown, request: OnboardingPlanRequest): PlanResult {
    const base = request.base ?? emptyWorld(request.name, request.theme ?? 'station');
    const a = answer as { world?: unknown; proposal?: { ops?: unknown; summary?: unknown }; ops?: unknown; summary?: unknown; notes?: unknown; ok?: boolean; error?: unknown } | undefined;
    if (a && a.ok === false) throw new Error(typeof a.error === 'string' ? a.error : 'Hermes could not plan this world.');
    let world: WorldSpec | undefined;
    const summary = typeof a?.proposal?.summary === 'string' ? a.proposal.summary : typeof a?.summary === 'string' ? a.summary : undefined;
    const ops = Array.isArray(a?.proposal?.ops) ? a!.proposal!.ops as WorldOp[] : Array.isArray(a?.ops) ? a!.ops as WorldOp[] : undefined;
    if (ops) {
        const applied = applyWorldOps(base, ops);
        if (!applied.ok) throw new Error(`Hermes proposed a world that is not valid: ${applied.error}`);
        world = applied.world;
    } else {
        const candidate = (a && typeof a === 'object' && 'world' in a ? a.world : answer) as WorldSpec;
        const checked = validateWorld(candidate);
        if (!checked.ok) throw new Error(`Hermes proposed a world that is not valid: ${checked.error}`);
        world = JSON.parse(JSON.stringify(checked.world)) as WorldSpec;
    }
    const warnings: string[] = [];
    for (const e of world.entities) {
        if (e.kind === 'web-wall' && e.home) {
            const safe = safeHomeUrl(e.home);
            if (safe !== e.home) { warnings.push(`${e.label ?? e.id}: the web address was shortened to keep private parts out.`); if (safe) e.home = safe; else delete e.home; }
        }
    }
    // Keep Hermes' layout when it is valid; only tidy when everything was stacked at one point.
    const stacked = world.entities.length > 1 && world.entities.every(e => e.transform.x === world!.entities[0].transform.x && e.transform.z === world!.entities[0].transform.z);
    if (stacked) { const tidy = applyOnboardingEdit(world, []); if (tidy.ok) world = tidy.world; }
    const notes = Array.isArray(a?.notes) ? (a!.notes as unknown[]).filter((n): n is string => typeof n === 'string').slice(0, 12) : [];
    if (summary) notes.unshift(summary);
    if (!notes.length) notes.push('Planned by Hermes. Review it before you create.');
    return { world: { ...world, plan: request.prompt.slice(0, 4000), revision: 0 }, notes, warnings };
}

/**
 * w2:onboard — where onboarding saves the world it built.
 *
 * Preferred: the build lane's WorldStore, bound to `OnboardingWorldSink` (see MERGE note below).
 * Fallback (used today, because WorldStore is not merged yet): browser localStorage under the shared
 * contract key `worldStorageKey(projectUri)`, next to the v1 room key. Either way the world is validated
 * by the shared contract and checked for secrets / host paths first. Saving never starts anything.
 *
 * MERGE (build lane): in omo-frontend-module.ts add
 *   bind(OnboardingWorldSink).toDynamicValue(ctx => ({ save: (uri, w) => ctx.container.get(WorldStore).replace(uri, w) }))
 * (or whatever WorldStore's "set the whole world" call is named). Until then the fallback below runs.
 */
import { validateWorld, worldStorageKey } from '../common/world-model';
import type { WorldSpec } from '../common/world-model';

export const OnboardingWorldSink = Symbol('OnboardingWorldSink');
export interface OnboardingWorldSink {
    /** Persist the whole world for a project. Rejects on failure. */
    save(projectUri: string, world: WorldSpec): Promise<void> | void;
    /** Optional: the saved world for a project. */
    load?(projectUri: string): Promise<WorldSpec | undefined> | WorldSpec | undefined;
}

/** Things that must never be inside a shared WorldSpec. Returns a reason, or undefined when clean. */
export function unsafeWorldContent(world: WorldSpec): string | undefined {
    const json = JSON.stringify(world);
    if (/\b(sk|ghp|gho|github_pat|xox[abprs]|glpat|AKIA|AIza)[-_A-Za-z0-9]{12,}/.test(json)) return 'The world looks like it contains a key or token.';
    if (/(?:"|\s)(?:\/home\/|\/Users\/|\/root\/|[A-Za-z]:\\\\)/.test(json)) return 'The world looks like it contains a file path from this computer.';
    for (const e of world.entities) if (e.kind === 'web-wall' && e.home && /[?#@]/.test(e.home.replace(/^https?:\/\//, ''))) return `${e.label ?? e.id} has a web address with private parts (query, fragment or login).`;
    return undefined;
}

export function readLocalWorld(storage: Storage | undefined, projectUri: string): WorldSpec | undefined {
    try {
        const raw = storage?.getItem(worldStorageKey(projectUri));
        if (!raw) return undefined;
        const checked = validateWorld(JSON.parse(raw));
        return checked.ok ? checked.world : undefined;
    } catch { return undefined; }
}

export function writeLocalWorld(storage: Storage | undefined, projectUri: string, world: WorldSpec): void {
    if (!storage) throw new Error('Browser storage is unavailable, so the world could not be saved.');
    storage.setItem(worldStorageKey(projectUri), JSON.stringify(world));
}

/** Validate, refuse secrets, then save through the sink (WorldStore) or the local fallback. */
export async function saveOnboardingWorld(world: WorldSpec, projectUri: string, sink: OnboardingWorldSink | undefined, storage: Storage | undefined): Promise<{ via: 'world-store' | 'local-storage' }> {
    const checked = validateWorld(world);
    if (!checked.ok) throw new Error(`The world is not valid: ${checked.error}`);
    const unsafe = unsafeWorldContent(checked.world);
    if (unsafe) throw new Error(`${unsafe} Remove it, then create again.`);
    if (sink) { await sink.save(projectUri, checked.world); return { via: 'world-store' }; }
    writeLocalWorld(storage, projectUri, checked.world);
    return { via: 'local-storage' };
}

export async function loadOnboardingWorld(projectUri: string, sink: OnboardingWorldSink | undefined, storage: Storage | undefined): Promise<WorldSpec | undefined> {
    try { const fromSink = sink?.load ? await sink.load(projectUri) : undefined; if (fromSink && validateWorld(fromSink).ok) return fromSink; } catch { /* fall back to local */ }
    return readLocalWorld(storage, projectUri);
}

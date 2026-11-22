/**
 * world-ui (g) — the world a new room starts in. New rooms, onboarding and the create-room path start in the
 * skyline penthouse (template `nyc-skyscraper`, drawn with the baked `skyline-penthouse` style kit), not the
 * old low-poly station room.
 *
 * Opt-out: localStorage `omo.starter` = `classic` keeps the classic two-desk station room as the starter.
 * Legacy real-app drivers set it, because their walking routes and click points are written for that room.
 */
import type { RoomTheme } from '../common/room-state';
import type { WorldSpec } from '../common/world-model';
import { instantiateTemplate } from '../common/world-templates';

export const STARTER_PREF = 'omo.starter';
export const STARTER_TEMPLATE = 'nyc-skyscraper';

type Store = Pick<Storage, 'getItem'> | undefined;
const defaultStore = (): Store => { try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; } };

/** True when new rooms start in the skyline penthouse (the default). */
export function penthouseStarter(storage: Store = defaultStore()): boolean {
    try { return storage?.getItem(STARTER_PREF) !== 'classic'; } catch { return true; }
}
/** The theme a new room starts with. */
export function starterTheme(storage: Store = defaultStore()): RoomTheme { return penthouseStarter(storage) ? 'skyline' : 'station'; }
/** The starter world for a new room called `name`, or undefined when the classic room is the starter. */
export function starterWorld(name: string, storage: Store = defaultStore()): WorldSpec | undefined {
    if (!penthouseStarter(storage)) return undefined;
    return instantiateTemplate(STARTER_TEMPLATE, { name: name.trim() || 'My workspace' });
}
export const STARTER_NOTE = 'Skyline penthouse: three desks facing the city, a docs wall and plants';

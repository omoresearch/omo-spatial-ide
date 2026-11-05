import type { AgentKind } from '../common/runtime-protocol';

export const STATION_RECIPE_VERSION = 1 as const;
export const STATION_RECIPE_MAX_BYTES = 16 * 1024;
export const STATION_RECIPE_MAX_COUNT = 12;
export const STATION_RECIPE_MAX_TABS = 8;
export const STATION_RECIPE_NAME_MAX = 48;
export type RecipeStationId = 'terminal' | 'terminal-2';

export interface StationRecipeTab {
    kind: AgentKind;
    name?: string;
}
export interface StationRecipe {
    version: typeof STATION_RECIPE_VERSION;
    id: string;
    name: string;
    stationId: RecipeStationId;
    profile: string;
    tabs: StationRecipeTab[];
}

export interface RecipeStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const PREFIX = 'omo.station-recipes.v1:';
const KINDS: AgentKind[] = ['shell', 'hermes', 'claude', 'codex'];
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const bytes = (value: string): number => new TextEncoder().encode(value).length;

export function stationRecipeKey(projectUri: string): string {
    return `${PREFIX}${JSON.stringify(projectUri)}`;
}

function copyRecipe(value: StationRecipe): StationRecipe {
    return { ...value, tabs: value.tabs.map(tab => ({ ...tab })) };
}

export function validateStationRecipe(value: unknown): value is StationRecipe {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const recipe = value as Partial<StationRecipe>;
    if (recipe.version !== STATION_RECIPE_VERSION || !text(recipe.id, 80) || !text(recipe.name, STATION_RECIPE_NAME_MAX)
        || (recipe.stationId !== 'terminal' && recipe.stationId !== 'terminal-2') || !text(recipe.profile, 80)
        || !Array.isArray(recipe.tabs) || recipe.tabs.length < 1 || recipe.tabs.length > STATION_RECIPE_MAX_TABS) return false;
    return recipe.tabs.every(tab => !!tab && typeof tab === 'object' && KINDS.includes((tab as StationRecipeTab).kind)
        && ((tab as StationRecipeTab).name === undefined || text((tab as StationRecipeTab).name, 24)));
}

export function readStationRecipes(storage: RecipeStorage | undefined, projectUri: string): StationRecipe[] {
    if (!storage || !text(projectUri, 2048)) return [];
    try {
        const raw = storage.getItem(stationRecipeKey(projectUri));
        if (!raw || bytes(raw) > STATION_RECIPE_MAX_BYTES) return [];
        const value = JSON.parse(raw);
        if (!Array.isArray(value) || value.length > STATION_RECIPE_MAX_COUNT) return [];
        const recipes = value.filter(validateStationRecipe).map(copyRecipe);
        return recipes.length === value.length ? recipes : [];
    } catch { return []; }
}

export function writeStationRecipes(storage: RecipeStorage | undefined, projectUri: string, recipes: readonly StationRecipe[]): boolean {
    if (!storage || !text(projectUri, 2048) || !Array.isArray(recipes) || recipes.length > STATION_RECIPE_MAX_COUNT
        || recipes.some(recipe => !validateStationRecipe(recipe))) return false;
    const raw = JSON.stringify(recipes.map(copyRecipe));
    if (bytes(raw) > STATION_RECIPE_MAX_BYTES) return false;
    try { storage.setItem(stationRecipeKey(projectUri), raw); return true; } catch { return false; }
}

export function makeStationRecipe(input: { name: string; stationId: RecipeStationId; profile: string; tabs: StationRecipeTab[]; id?: string }): StationRecipe {
    const recipe: StationRecipe = {
        version: STATION_RECIPE_VERSION,
        id: input.id ?? `recipe-${Math.random().toString(36).slice(2, 12)}`,
        name: input.name.trim().slice(0, STATION_RECIPE_NAME_MAX),
        stationId: input.stationId,
        profile: input.profile.trim().slice(0, 80),
        tabs: input.tabs.map(tab => ({ kind: tab.kind, ...(tab.name ? { name: tab.name.trim().slice(0, 24) } : {}) })).slice(0, STATION_RECIPE_MAX_TABS)
    };
    if (!validateStationRecipe(recipe)) throw new Error('Invalid station recipe');
    return recipe;
}

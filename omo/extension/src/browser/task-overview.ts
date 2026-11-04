import { readTaskRun, taskRunKey } from './agent-task-run';
import type { AgentTaskTarget, TaskRun, TaskDraftStorage } from './agent-task-run';

export interface TaskOverviewStorage {
    getItem(key: string): string | null;
    key(index: number): string | null;
    readonly length: number;
}

export interface TaskOverviewResult {
    entries: TaskRun[];
    storageUnavailable: boolean;
    truncated: boolean;
}

export const TASK_OVERVIEW_MAX_KEYS = 5000;
export const TASK_OVERVIEW_MAX_ENTRIES = 50;
export const TASK_OVERVIEW_MAX_RAW_KEY_BYTES = 32 * 1024;

const TASK_RUN_KEY_PREFIX = 'omo.agent-task-run.v1:';
const TARGET_STRING_LIMIT = 4096;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const OVERVIEW_VIEW_ID = 'task-overview';

function isWellFormed(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return false;
        }
    }
    return true;
}

function utf8Bytes(value: string): number {
    let bytes = 0;
    for (const character of value) {
        const code = character.codePointAt(0)!;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}

function validString(value: unknown, allowEmpty = false): value is string {
    return typeof value === 'string'
        && (allowEmpty || value.length > 0)
        && value.length <= TARGET_STRING_LIMIT
        && isWellFormed(value)
        && !UNSAFE_CONTROL.test(value);
}

function isStorage(value: unknown): value is TaskOverviewStorage {
    try {
        return !!value
            && typeof (value as TaskOverviewStorage).getItem === 'function'
            && typeof (value as TaskOverviewStorage).key === 'function';
    } catch {
        return false;
    }
}

interface KeyTarget {
    key: string;
    target: AgentTaskTarget;
}

/**
 * Read the current browser tab's latest task records for one exact project.
 * Key metadata is checked before any record value is requested. This function
 * never writes, migrates, or reads a foreign project's task text.
 */
export function collectTaskOverview(storage: TaskOverviewStorage | TaskDraftStorage | undefined, projectUri: string): TaskOverviewResult {
    if (!validString(projectUri) || !isStorage(storage)) {
        return { entries: [], storageUnavailable: !isStorage(storage), truncated: false };
    }

    let length: number;
    try {
        length = storage.length;
    } catch {
        return { entries: [], storageUnavailable: true, truncated: false };
    }
    if (!Number.isSafeInteger(length) || length < 0) {
        return { entries: [], storageUnavailable: true, truncated: false };
    }

    const truncatedByKeys = length > TASK_OVERVIEW_MAX_KEYS;
    const candidates: KeyTarget[] = [];
    const seenKeys = new Set<string>();
    let storageUnavailable = false;
    const readStorage = {
        getItem: (key: string): string | null => {
            try {
                return storage.getItem(key);
            } catch {
                storageUnavailable = true;
                return null;
            }
        },
    } as TaskDraftStorage;
    const count = Math.min(length, TASK_OVERVIEW_MAX_KEYS);
    for (let index = 0; index < count; index++) {
        let rawKey: string | null;
        try {
            rawKey = storage.key(index);
        } catch {
            storageUnavailable = true;
            break;
        }
        const candidate = parseOwnedKey(rawKey, projectUri);
        if (candidate && !seenKeys.has(candidate.key)) {
            seenKeys.add(candidate.key);
            candidates.push(candidate);
        }
    }

    candidates.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const validEntries: TaskRun[] = [];
    for (const candidate of candidates) {
        // readTaskRun is called only after parseOwnedKey has proved the exact
        // project tuple. It also validates and clones the stored record.
        const entry = readTaskRun(readStorage, candidate.target);
        if (entry) validEntries.push(entry);
    }

    const truncatedByEntries = validEntries.length > TASK_OVERVIEW_MAX_ENTRIES;
    return {
        entries: validEntries.slice(0, TASK_OVERVIEW_MAX_ENTRIES),
        storageUnavailable,
        truncated: truncatedByKeys || truncatedByEntries,
    };
}

function parseOwnedKey(rawKey: string | null, projectUri: string): KeyTarget | undefined {
    if (typeof rawKey !== 'string'
        || !isWellFormed(rawKey)
        || utf8Bytes(rawKey) > TASK_OVERVIEW_MAX_RAW_KEY_BYTES
        || !rawKey.startsWith(TASK_RUN_KEY_PREFIX)) return undefined;
    const encoded = rawKey.slice(TASK_RUN_KEY_PREFIX.length);
    let tuple: unknown;
    try {
        tuple = JSON.parse(encoded);
    } catch {
        return undefined;
    }
    if (!Array.isArray(tuple) || tuple.length !== 4 || tuple.some(value => !validString(value))) return undefined;
    const [tupleProject, stationId, workspaceId, tabId] = tuple as [string, string, string, string];
    if (tupleProject !== projectUri) return undefined;
    const target: AgentTaskTarget = { projectUri, stationId, workspaceId, tabId, viewId: OVERVIEW_VIEW_ID };
    // Require the canonical key. This rejects duplicate encodings and any
    // JSON shape that could make a parser disagree with taskRunKey.
    if (taskRunKey(target) !== rawKey) return undefined;
    return { key: rawKey, target };
}

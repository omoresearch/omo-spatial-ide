/** The snapshot of the runtime destination used by task preparation. */
export interface AgentTaskTarget {
    projectUri: string;
    stationId: string;
    workspaceId: string;
    tabId: string;
    viewId: string;
}

export interface TaskDraftStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export const TASK_DRAFT_LIMIT_BYTES = 32 * 1024;
const TASK_DRAFT_KEY_PREFIX = 'omo.agent-task-draft.v1:';
const TARGET_STRING_LIMIT = 4096;
const UNSAFE_DRAFT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function isWellFormed(text: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(index + 1);
            if (index + 1 >= text.length || next < 0xdc00 || next > 0xdfff) return false;
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return false;
        }
    }
    return true;
}

function utf8Bytes(text: string): number {
    let bytes = 0;
    for (const character of text) {
        const code = character.codePointAt(0)!;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}

function validBoundedString(value: unknown, allowEmpty = false): value is string {
    return typeof value === 'string'
        && (allowEmpty || value.length > 0)
        && value.length <= TARGET_STRING_LIMIT
        && isWellFormed(value)
        && !UNSAFE_DRAFT_CONTROL.test(value);
}

function validTarget(target: AgentTaskTarget): boolean {
    return !!target
        && validBoundedString(target.projectUri)
        && validBoundedString(target.stationId)
        && validBoundedString(target.workspaceId)
        && validBoundedString(target.tabId)
        && validBoundedString(target.viewId);
}

function validDraftText(text: unknown): text is string {
    return typeof text === 'string'
        && isWellFormed(text)
        && !UNSAFE_DRAFT_CONTROL.test(text)
        && utf8Bytes(text) <= TASK_DRAFT_LIMIT_BYTES;
}

/** A key with a JSON tuple avoids delimiter collisions and never contains viewId. */
export function taskDraftKey(target: AgentTaskTarget): string {
    if (!validTarget(target)) return '';
    return `${TASK_DRAFT_KEY_PREFIX}${JSON.stringify([target.projectUri, target.stationId, target.workspaceId, target.tabId])}`;
}

/** Read only from the storage object supplied by the caller. */
export function readTaskDraft(storage: TaskDraftStorage, target: AgentTaskTarget): string {
    const key = taskDraftKey(target);
    if (!key || !storage || typeof storage.getItem !== 'function') return '';
    try {
        const raw = storage.getItem(key);
        if (!raw) return '';
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
        const record = value as { version?: unknown; text?: unknown };
        return record.version === 1 && validDraftText(record.text) ? record.text : '';
    } catch {
        return '';
    }
}

/** Write a validated draft, returning false for invalid text or unavailable storage. */
export function writeTaskDraft(storage: TaskDraftStorage, target: AgentTaskTarget, text: string): boolean {
    const key = taskDraftKey(target);
    if (!key || !storage || typeof storage.setItem !== 'function' || !validDraftText(text)) return false;
    try {
        storage.setItem(key, JSON.stringify({ version: 1, text }));
        return true;
    } catch {
        return false;
    }
}

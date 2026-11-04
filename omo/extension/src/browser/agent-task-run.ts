import type { GitReviewSnapshot } from '../common/git-review-protocol';
import type { AgentTaskTarget, TaskDraftStorage } from './agent-task-draft';

export type { AgentTaskTarget, TaskDraftStorage } from './agent-task-draft';
export type { GitReviewSnapshot } from '../common/git-review-protocol';

export type TaskRunPhase = 'prepared' | 'submitted' | 'review-ready' | 'accepted' | 'changes-requested';

export interface TaskRunReview {
    projectUri: string;
    head?: string;
    changeCount: number;
    truncated: boolean;
}

export interface TaskRun {
    version: 1;
    id: string;
    target: AgentTaskTarget;
    text: string;
    phase: TaskRunPhase;
    review?: TaskRunReview;
}

export const TASK_RUN_STORAGE_LIMIT_BYTES = 64 * 1024;
const TASK_RUN_KEY_PREFIX = 'omo.agent-task-run.v1:';
const TARGET_STRING_LIMIT = 4096;
const TASK_TEXT_LIMIT_BYTES = 32 * 1024;
const TASK_ID_LIMIT = 128;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const ID_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PHASES: readonly TaskRunPhase[] = ['prepared', 'submitted', 'review-ready', 'accepted', 'changes-requested'];
const TERMINAL_PHASES: readonly TaskRunPhase[] = ['accepted', 'changes-requested'];
const REVIEW_PHASES: readonly TaskRunPhase[] = ['review-ready', 'accepted', 'changes-requested'];
const TARGET_KEYS = ['projectUri', 'stationId', 'workspaceId', 'tabId', 'viewId'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
    const allowed = new Set([...required, ...optional]);
    return Object.keys(value).every(key => allowed.has(key)) && required.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isWellFormed(text: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(index + 1);
            if (index + 1 >= text.length || next < 0xdc00 || next > 0xdfff) return false;
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
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

function validString(value: unknown, max: number, allowEmpty = false): value is string {
    return typeof value === 'string'
        && (allowEmpty || value.length > 0)
        && value.length <= max
        && isWellFormed(value)
        && !UNSAFE_CONTROL.test(value);
}

function validTarget(value: unknown): value is AgentTaskTarget {
    if (!isObject(value) || !hasExactKeys(value, TARGET_KEYS)) return false;
    return validString(value.projectUri, TARGET_STRING_LIMIT)
        && validString(value.stationId, TARGET_STRING_LIMIT)
        && validString(value.workspaceId, TARGET_STRING_LIMIT)
        && validString(value.tabId, TARGET_STRING_LIMIT)
        && validString(value.viewId, TARGET_STRING_LIMIT);
}

function validTaskText(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.trim().length > 0
        && isWellFormed(value)
        && !UNSAFE_CONTROL.test(value)
        && utf8Bytes(value) <= TASK_TEXT_LIMIT_BYTES;
}

function validId(value: unknown): value is string {
    return validString(value, TASK_ID_LIMIT) && !ID_CONTROL.test(value);
}

/** Stable identity intentionally excludes the transient attached monitor view. */
function samePersistentTarget(a: AgentTaskTarget, b: AgentTaskTarget): boolean {
    return a.projectUri === b.projectUri && a.stationId === b.stationId
        && a.workspaceId === b.workspaceId && a.tabId === b.tabId;
}

function sameExactTarget(a: AgentTaskTarget, b: AgentTaskTarget): boolean {
    return samePersistentTarget(a, b) && a.viewId === b.viewId;
}

function invalidInput(): Error { return new Error('Invalid task run data.'); }
function invalidContext(): Error { return new Error('Task run context does not match.'); }
function invalidTransition(): Error { return new Error('Task run transition is not allowed.'); }

function cloneTarget(target: AgentTaskTarget): AgentTaskTarget {
    return Object.freeze({
        projectUri: target.projectUri,
        stationId: target.stationId,
        workspaceId: target.workspaceId,
        tabId: target.tabId,
        viewId: target.viewId,
    });
}

function cloneReview(review: TaskRunReview): TaskRunReview {
    const copy: TaskRunReview = { projectUri: review.projectUri, changeCount: review.changeCount, truncated: review.truncated };
    if (review.head !== undefined) copy.head = review.head;
    return Object.freeze(copy);
}

function cloneRun(run: TaskRun): TaskRun {
    const copy: TaskRun = {
        version: 1,
        id: run.id,
        target: cloneTarget(run.target),
        text: run.text,
        phase: run.phase,
    };
    if (run.review) copy.review = cloneReview(run.review);
    return Object.freeze(copy);
}

function validateReview(value: unknown, projectUri: string): value is TaskRunReview {
    if (!isObject(value) || !hasExactKeys(value, ['projectUri', 'changeCount', 'truncated'], ['head'])) return false;
    return value.projectUri === projectUri
        && validString(value.projectUri, TARGET_STRING_LIMIT)
        && (value.head === undefined || validString(value.head, TARGET_STRING_LIMIT))
        && typeof value.changeCount === 'number' && Number.isInteger(value.changeCount) && value.changeCount >= 0 && value.changeCount <= 10000
        && typeof value.truncated === 'boolean';
}

function validateRun(value: unknown): value is TaskRun {
    if (!isObject(value) || !hasExactKeys(value, ['version', 'id', 'target', 'text', 'phase'], ['review'])) return false;
    if (value.version !== 1 || !validId(value.id) || !validTarget(value.target) || !validTaskText(value.text)
        || !PHASES.includes(value.phase as TaskRunPhase)) return false;
    const hasReview = Object.prototype.hasOwnProperty.call(value, 'review') && value.review !== undefined;
    if (REVIEW_PHASES.includes(value.phase as TaskRunPhase) !== hasReview) return false;
    return !hasReview || validateReview(value.review, value.target.projectUri);
}

function validatedRun(value: unknown): TaskRun {
    if (!validateRun(value)) throw invalidInput();
    return cloneRun(value);
}

function reviewFromSnapshot(snapshot: GitReviewSnapshot, projectUri: string): TaskRunReview {
    if (!isObject(snapshot)) throw invalidInput();
    if (snapshot.projectUri !== projectUri) throw invalidContext();
    if (!validString(snapshot.projectUri, TARGET_STRING_LIMIT)
        || !validString(snapshot.branch, TARGET_STRING_LIMIT)
        || !Array.isArray(snapshot.changes) || snapshot.changes.length > 10000
        || typeof snapshot.truncated !== 'boolean'
        || (snapshot.head !== undefined && !validString(snapshot.head, TARGET_STRING_LIMIT))) throw invalidInput();
    const changeCount = snapshot.changes.length;
    return cloneReview({ projectUri, ...(snapshot.head === undefined ? {} : { head: snapshot.head }), changeCount, truncated: snapshot.truncated });
}

function assertStableContext(run: TaskRun, currentTarget: AgentTaskTarget): void {
    if (!validTarget(currentTarget) || !samePersistentTarget(run.target, currentTarget)) throw invalidContext();
}

/** A collision-safe latest-record key. The transient view is not part of identity. */
export function taskRunKey(target: AgentTaskTarget): string {
    if (!validTarget(target)) return '';
    return `${TASK_RUN_KEY_PREFIX}${JSON.stringify([target.projectUri, target.stationId, target.workspaceId, target.tabId])}`;
}

export function createTaskRun(target: AgentTaskTarget, text: string, id: string): TaskRun {
    if (!validTarget(target) || !validTaskText(text) || !validId(id)) throw invalidInput();
    return cloneRun({ version: 1, id, target: cloneTarget(target), text, phase: 'prepared' });
}

export function markTaskSubmitted(run: TaskRun, currentTarget: AgentTaskTarget): TaskRun {
    const checked = validatedRun(run);
    assertStableContext(checked, currentTarget);
    if (checked.phase !== 'prepared' || checked.review !== undefined) throw invalidTransition();
    return cloneRun({ ...checked, phase: 'submitted', target: cloneTarget(checked.target) });
}

export function attachTaskReview(run: TaskRun, currentTarget: AgentTaskTarget, snapshot: GitReviewSnapshot): TaskRun {
    const checked = validatedRun(run);
    assertStableContext(checked, currentTarget);
    if (checked.phase !== 'submitted' && checked.phase !== 'review-ready') throw invalidTransition();
    const review = reviewFromSnapshot(snapshot, checked.target.projectUri);
    return cloneRun({ ...checked, phase: 'review-ready', target: cloneTarget(checked.target), review });
}

export function decideTaskRun(run: TaskRun, currentTarget: AgentTaskTarget, decision: 'accepted' | 'changes-requested'): TaskRun {
    const checked = validatedRun(run);
    assertStableContext(checked, currentTarget);
    if (checked.phase !== 'review-ready' || !checked.review || !samePersistentTarget(checked.target, currentTarget)
        || checked.review.projectUri !== currentTarget.projectUri || !TERMINAL_PHASES.includes(decision)) throw invalidTransition();
    return cloneRun({ ...checked, phase: decision, target: cloneTarget(checked.target), review: cloneReview(checked.review) });
}

export function readTaskRun(storage: TaskDraftStorage | undefined, target: AgentTaskTarget): TaskRun | undefined {
    const key = taskRunKey(target);
    if (!key || !storage || typeof storage.getItem !== 'function') return undefined;
    try {
        const raw = storage.getItem(key);
        if (typeof raw !== 'string' || !raw || !isWellFormed(raw) || utf8Bytes(raw) > TASK_RUN_STORAGE_LIMIT_BYTES) return undefined;
        const value: unknown = JSON.parse(raw);
        if (!validateRun(value) || !samePersistentTarget(value.target, target)) return undefined;
        return cloneRun(value);
    } catch {
        return undefined;
    }
}

export function writeTaskRun(storage: TaskDraftStorage | undefined, target: AgentTaskTarget, run: TaskRun): boolean {
    const key = taskRunKey(target);
    if (!key || !storage || typeof storage.setItem !== 'function' || !validTarget(target)) return false;
    try {
        const checked = validatedRun(run);
        if (!samePersistentTarget(checked.target, target)) return false;
        const raw = JSON.stringify(checked);
        if (utf8Bytes(raw) > TASK_RUN_STORAGE_LIMIT_BYTES) return false;
        storage.setItem(key, raw);
        return true;
    } catch {
        return false;
    }
}

/** Kept private from the UI: this is the only comparison that includes a transient view. */
export function sameTaskRunTarget(a: AgentTaskTarget, b: AgentTaskTarget): boolean {
    return validTarget(a) && validTarget(b) && sameExactTarget(a, b);
}

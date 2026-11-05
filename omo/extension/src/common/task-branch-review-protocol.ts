export const TaskBranchReviewService = Symbol('TaskBranchReviewService');

export interface TaskBranchReviewInput {
    worktreeUri: string;
    baseHead: string;
    /** Optional manifest branch. When supplied, the worktree must still be attached to it. */
    branch?: string;
}

export interface TaskBranchReviewChange {
    path: string;
    status: string;
    uri?: string;
}

export interface TaskBranchReviewSnapshot {
    worktreeUri: string;
    branch: string;
    baseHead: string;
    head: string;
    changes: TaskBranchReviewChange[];
    truncated: boolean;
}

export interface TaskBranchReviewPatch {
    worktreeUri: string;
    baseHead: string;
    path: string;
    status: string;
    patch: string;
}

/** Read-only review of a registered task branch against its captured base commit. */
export interface TaskBranchReviewService {
    list(input: TaskBranchReviewInput): Promise<TaskBranchReviewSnapshot>;
    diff(input: TaskBranchReviewInput & { path: string }): Promise<TaskBranchReviewPatch>;
}

export const OMO_GIT_REVIEW_PATH = '/services/omo-git-review';
export const GitReviewService = Symbol('GitReviewService');
export interface GitChange {
    /** Literal project-relative path; no URI decoding or normalization by clients. */
    path: string;
    /** Git's two-character porcelain index/worktree status. */
    status: string;
    /** Present only for an existing regular file confined to this project. */
    uri?: string;
}
export interface GitReviewSnapshot {
    projectUri: string;
    branch: string;
    head?: string;
    changes: GitChange[];
    truncated: boolean;
}
export interface GitReviewPatch { projectUri: string; path: string; status: string; patch: string }
/** Read-only local workspace review. No stage, commit, revert, checkout or provider operations. */
export interface GitReviewService {
    list(projectUri: string): Promise<GitReviewSnapshot>;
    diff(input: { projectUri: string; path: string }): Promise<GitReviewPatch>;
}

export const OMO_TASK_WORKSPACE_PATH = '/services/omo-task-workspaces';
export const TaskWorkspaceService = Symbol('TaskWorkspaceService');

export interface TaskWorkspace {
    id: string;
    sourceProjectUri: string;
    worktreeUri: string;
    branch: string;
    baseHead: string;
    name: string;
    createdAt: string;
    sourceHasChanges: boolean;
}

export interface TaskWorkspaceService {
    list(projectUri: string): Promise<TaskWorkspace[]>;
    create(input: { projectUri: string; name: string; confirmedCreate: boolean }): Promise<TaskWorkspace>;
    /** Read-only authority for a previously registered canonical worktree. */
    getTaskWorkspace(worktreeUri: string): Promise<TaskWorkspace | undefined>;
}

/**
 * promise:onboarding — "Bring your mind with you": the local chat importer's wire contract.
 *
 * The backend reads chats that are already on this machine (Hermes sessions, Claude Code projects), groups them
 * into a few topics and answers with short, redacted titles and summaries. No model is called, nothing is sent
 * anywhere: the importer has no network code at all (see extension/test/mind-import.test.cjs). Raw chat text
 * never leaves the backend; only redacted titles (<= 60 chars) and summaries (<= 140 chars) do.
 */
export const OMO_MIND_IMPORT_PATH = '/services/omo-mind-import';
export const MindImportService = Symbol('MindImportService');

/** Hard caps on what the importer returns. */
export const MIND_MAX_ROOMS = 6;
export const MIND_MAX_SCREENS = 4;
export const MIND_TITLE_MAX = 60;
export const MIND_SUMMARY_MAX = 140;

export interface MindImportRequest {
    /** Read Hermes chats (~/.hermes/sessions). Default true. */
    hermes?: boolean;
    /** Read Claude Code chats (~/.claude/projects). Default true. */
    claude?: boolean;
}

export interface MindScreen { title: string; summary: string }
export interface MindRoom { title: string; source: 'hermes' | 'claude'; chats: number; screens: MindScreen[] }

export interface MindImportCounts {
    /** Chats with at least one user message that were read. */
    chats: number;
    rooms: number;
    screens: number;
    /** Things the world will hold for them: one sign per room + its note boards. */
    notes: number;
    /** Files opened (and files skipped: too big, unreadable, not a chat). */
    files: number;
    skipped: number;
    /** Always 0: the importer has no network code. Proven by the zero-network unit test. */
    bytesSent: 0;
}

export interface MindImportResult {
    rooms: MindRoom[];
    counts: MindImportCounts;
    /** Which sources were found on this machine (folders exist). Paths are never sent. */
    found: { hermes: boolean; claude: boolean };
    /** Time the read took on this machine, in ms. */
    ms: number;
}

export interface MindImportService {
    importMind(request: MindImportRequest): Promise<MindImportResult>;
}

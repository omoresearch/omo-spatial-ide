/**
 * promise:onboarding — "Bring your mind with you". Reads chats that are ALREADY on this machine and turns them
 * into a few topics (rooms) with short note screens. Local only:
 *   - reads ONLY <home>/.hermes/sessions/*.json(l) and <home>/.claude/projects/<folder>/*.jsonl;
 *   - imports only fs / path / os: no http, https, net, tls, dns, child_process, fetch, no model call;
 *     extension/test/mind-import.test.cjs stubs every network door to throw and runs this on a fixture;
 *   - every string that leaves this file goes through redactText (keys, tokens, emails, home paths -> ~)
 *     and is capped (titles 60, summaries 140 characters, at most 6 rooms x 4 screens);
 *   - big files are read only at the head (Claude) or skipped (Hermes > 8 MB); the whole read stops at a deadline.
 * `<home>` is the user's home folder, or OMO_MIND_HOME (tests and the real-browser check point it at a fixture).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MIND_MAX_ROOMS, MIND_MAX_SCREENS, MIND_SUMMARY_MAX, MIND_TITLE_MAX } from '../common/mind-import-protocol';
import type { MindImportRequest, MindImportResult, MindImportService, MindRoom, MindScreen } from '../common/mind-import-protocol';

export interface MindImportOptions {
    /** Home folder to read from. Default: OMO_MIND_HOME, else os.homedir(). Read at call time. */
    home?: string;
    /** Stop opening new files after this many ms (default 15 s). */
    deadlineMs?: number;
    /** Newest files read per source (default 300). */
    maxFiles?: number;
}

const HERMES_MAX_BYTES = 8 * 1024 * 1024;
const CLAUDE_HEAD_BYTES = 384 * 1024;
const USER_TEXT_MAX = 2000;

// ------------------------------------------------------------------------------------------------ redaction
const SECRET_KEY_NAMES = '(?:api[_-]?key|apikey|access[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|pwd|pass|private[_-]?key|session[_-]?key|cookie)';
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[secret]'],
    // URLs: keep the host, drop path, query and credentials (they often hold tokens).
    [/\b(https?):\/\/(?:[^\s/@]+@)?([A-Za-z0-9.-]+)(?::\d+)?[^\s)\]}>"']*/g, '$1://$2'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
    [/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{8,}/g, '[secret]'],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '[secret]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[secret]'],
    [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, '[secret]'],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[secret]'],
    [/\bAIza[0-9A-Za-z_-]{20,}/g, '[secret]'],
    [/\b(?:whsec|rk_live|sk_live|sk_test|pk_live|pk_test)_[A-Za-z0-9]{8,}/g, '[secret]'],
    [/\bnpm_[A-Za-z0-9]{20,}\b/g, '[secret]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[secret]'],
    [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [secret]'],
    [new RegExp(`\\b${SECRET_KEY_NAMES}\\b(["']?\\s*[:=]\\s*["']?)[^\\s"',;}]{4,}`, 'gi'), '[secret]'],
    [/\b[A-Fa-f0-9]{32,}\b/g, '[secret]'],
    [/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{36,}={0,2}/g, '[secret]'],
    // Home folders -> ~ (any user), Windows profiles too.
    [/(?:\/home\/[^/\s"'`]+|\/Users\/[^/\s"'`]+|\/root)(?=\/|\b|$)/g, '~'],
    [/\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, '~'],
    [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
    [/\+?\d(?:[ -]?\d){8,}/g, '[number]']
];

/** Remove secrets and personal paths from one string. Pure; used on every string the importer returns. */
export function redactText(input: string): string {
    let s = String(input ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
    for (const [re, to] of REDACTIONS) s = s.replace(re, to);
    return s.replace(/\s+/g, ' ').trim();
}

/** Redact, then cut to `max` characters on a word boundary with an ellipsis. */
export function capText(input: string, max: number): string {
    const s = redactText(input);
    if (s.length <= max) return s;
    const cut = s.slice(0, max - 1), sp = cut.lastIndexOf(' ');
    return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

// ------------------------------------------------------------------------------------------------ reading chats
interface Chat { source: 'hermes' | 'claude'; topic?: string; title?: string; texts: string[]; mtime: number }

/** Plain text of a chat message's content (string, or parts with text). */
function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' && /^(text|input_text)?$/.test(String((p as { type?: unknown }).type ?? ''))) ? (p as { text: string }).text : '').filter(Boolean).join(' ');
    return '';
}

/** A human message worth reading: no harness wrappers, no tool output, not empty. */
function cleanUserText(raw: string): string | undefined {
    let s = raw.slice(0, 20000);
    if (/^\s*<(local-command|command-name|command-message|bash-|tool_|user-prompt-submit-hook)/.test(s)) return undefined;
    if (/^\s*Caveat:/.test(s)) return undefined;
    s = s.replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+|ide_[a-z_]+)[^>]*>[\s\S]*?<\/\1>/g, ' ');
    s = s.replace(/<[^>\n]{1,80}>/g, ' ');
    s = s.replace(/^(?:\s*\[[^\]\n]{0,120}\]\s*)+/, ''); // "[ROUTED …]" / "[Harry]" prefixes
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length < 3 || /^(yes|no|ok|okay|thanks|continue|go|y|n)\.?$/i.test(s)) return undefined;
    return s.slice(0, USER_TEXT_MAX);
}

function userTextsFromMessages(list: unknown[], limit = 2): string[] {
    const out: string[] = [];
    for (const m of list) {
        if (!m || typeof m !== 'object') continue;
        const o = m as { role?: unknown; type?: unknown; content?: unknown; message?: { role?: unknown; content?: unknown }; isMeta?: unknown };
        if (o.isMeta === true) continue;
        const role = o.message?.role ?? o.role ?? (o.type === 'user' ? 'user' : undefined);
        if (role !== 'user') continue;
        const t = cleanUserText(textOf(o.message?.content ?? o.content));
        if (t) { out.push(t); if (out.length >= limit) break; }
    }
    return out;
}

/** The message list inside one Hermes session file (several shapes are in use). */
function hermesMessages(json: unknown): unknown[] {
    const o = json as Record<string, unknown> | undefined;
    if (Array.isArray(json)) return json;
    if (!o || typeof o !== 'object') return [];
    const body = (o.request as { body?: Record<string, unknown> } | undefined)?.body;
    for (const c of [o.messages, o.history, o.conversation, o.transcript, body?.messages, body?.input]) if (Array.isArray(c)) return c;
    return [];
}

async function listFiles(dir: string, test: (name: string) => boolean): Promise<Array<{ file: string; mtime: number; size: number }>> {
    let names: string[] = [];
    try { names = await fs.promises.readdir(dir); } catch { return []; }
    const out: Array<{ file: string; mtime: number; size: number }> = [];
    for (const name of names) {
        if (!test(name)) continue;
        const file = path.join(dir, name);
        try { const st = await fs.promises.stat(file); if (st.isFile()) out.push({ file, mtime: st.mtimeMs, size: st.size }); } catch { /* unreadable */ }
    }
    return out;
}

async function readHead(file: string, bytes: number): Promise<string> {
    const fh = await fs.promises.open(file, 'r');
    try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
}

interface ReadStats { files: number; skipped: number }

async function readHermes(home: string, until: number, maxFiles: number, stats: ReadStats): Promise<{ chats: Chat[]; found: boolean }> {
    const dir = path.join(home, '.hermes', 'sessions');
    const found = fs.existsSync(dir);
    const files = (await listFiles(dir, n => /\.jsonl?$/i.test(n))).sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles);
    const chats: Chat[] = [];
    for (const f of files) {
        if (Date.now() > until) { stats.skipped++; continue; }
        if (f.size > HERMES_MAX_BYTES) { stats.skipped++; continue; }
        stats.files++;
        try {
            const raw = await fs.promises.readFile(f.file, 'utf8');
            let list: unknown[];
            if (/\.jsonl$/i.test(f.file)) list = raw.split('\n').filter(l => l.trim()).slice(0, 4000).map(l => { try { return JSON.parse(l); } catch { return undefined; } });
            else list = hermesMessages(JSON.parse(raw));
            const texts = userTextsFromMessages(list);
            if (texts.length) chats.push({ source: 'hermes', texts, mtime: f.mtime }); else stats.skipped++;
        } catch { stats.skipped++; }
    }
    return { chats, found };
}

/** "-home-harry-dev-omo-shape" -> "omo-shape" when no cwd is recorded. */
function projectFromFolder(folder: string): string {
    const parts = folder.replace(/^-+/, '').split('-').filter(Boolean);
    const skip = parts[0] === 'home' || parts[0] === 'Users' ? 2 : parts[0] === 'root' ? 1 : 0;
    const rest = parts.slice(skip).filter(p => !/^(dev|src|code|projects?|repos?|work|workspaces?|git|Documents|Desktop)$/i.test(p));
    return rest.slice(-2).join('-') || parts.slice(-1)[0] || 'Project';
}

async function readClaude(home: string, until: number, maxFiles: number, stats: ReadStats): Promise<{ chats: Chat[]; found: boolean }> {
    const root = path.join(home, '.claude', 'projects');
    const found = fs.existsSync(root);
    let folders: string[] = [];
    try { folders = (await fs.promises.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { /* none */ }
    const files: Array<{ file: string; mtime: number; size: number; folder: string }> = [];
    for (const folder of folders) for (const f of await listFiles(path.join(root, folder), n => /\.jsonl$/i.test(n))) files.push({ ...f, folder });
    files.sort((a, b) => b.mtime - a.mtime);
    const chats: Chat[] = [];
    for (const f of files.slice(0, maxFiles)) {
        if (Date.now() > until) { stats.skipped++; continue; }
        stats.files++;
        try {
            const head = await readHead(f.file, CLAUDE_HEAD_BYTES);
            const lines = head.split('\n');
            if (f.size > CLAUDE_HEAD_BYTES) lines.pop(); // the last line may be cut
            let cwd: string | undefined, title: string | undefined;
            const entries: unknown[] = [];
            for (const line of lines) {
                if (!line.trim()) continue;
                let o: Record<string, unknown>;
                try { o = JSON.parse(line); } catch { continue; }
                if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
                if (!title && o.type === 'ai-title' && typeof o.aiTitle === 'string') title = o.aiTitle;
                if (!title && o.type === 'summary' && typeof o.summary === 'string') title = o.summary;
                if (o.type === 'user' && o.isSidechain !== true) entries.push(o);
            }
            const texts = userTextsFromMessages(entries);
            if (!texts.length) { stats.skipped++; continue; }
            const topic = cwd ? path.basename(cwd) || projectFromFolder(f.folder) : projectFromFolder(f.folder);
            chats.push({ source: 'claude', topic, title, texts, mtime: f.mtime });
        } catch { stats.skipped++; }
    }
    return { chats, found };
}

// ------------------------------------------------------------------------------------------------ grouping
const STOP = new Set(('a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing done down during each few for from further get got had has have having he her here hers him his how i if in into is it its just let like make me more most my no nor not now of off on once only or other our out over own please same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours '
    + 'want need help using use new add fix check run see look try know think also still really thing things something way ok okay yes hi hey hello thanks thank today tomorrow time one two three first last next back give take keep show tell write read find put set start stop going doing able sure much many every each lot via etc im ive dont cant wont didnt doesnt isnt thats whats lets youre'
).split(/\s+/));

function keywords(texts: readonly string[]): Set<string> {
    const words = redactText(texts.join(' ')).toLowerCase().replace(/\[[a-z]+\]/g, ' ').match(/[a-z][a-z0-9-]{2,23}/g) ?? [];
    return new Set(words.map(w => w.replace(/-+$/, '')).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w)));
}

const titleCase = (s: string): string => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();

/** Hermes chats -> topics by the keywords of their first user messages (greedy, most shared keyword first). */
function hermesTopics(chats: Chat[], max: number): Array<{ title: string; chats: Chat[] }> {
    const sets = chats.map(c => keywords(c.texts));
    const left = new Set(chats.map((_, i) => i));
    const topics: Array<{ title: string; chats: Chat[] }> = [];
    while (left.size && topics.length < max) {
        const df = new Map<string, number>();
        for (const i of left) for (const w of sets[i]) df.set(w, (df.get(w) ?? 0) + 1);
        const best = [...df].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
        if (!best || best[1] < 2) break;
        const members = [...left].filter(i => sets[i].has(best[0]));
        members.forEach(i => left.delete(i));
        topics.push({ title: titleCase(best[0]), chats: members.map(i => chats[i]) });
    }
    if (left.size && topics.length < max) topics.push({ title: 'Other chats', chats: [...left].map(i => chats[i]) });
    return topics;
}

function claudeTopics(chats: Chat[]): Array<{ title: string; chats: Chat[] }> {
    const by = new Map<string, Chat[]>();
    for (const c of chats) { const k = c.topic ?? 'Project'; by.set(k, [...(by.get(k) ?? []), c]); }
    return [...by].map(([k, list]) => ({ title: titleCase(k), chats: list }));
}

function screenFor(chat: Chat): MindScreen {
    const first = chat.texts[0] ?? '';
    const sentence = /^(.{8,}?[.?!])(\s|$)/.exec(first)?.[1] ?? first;
    const title = capText(chat.title ?? sentence.split(/\s+/).slice(0, 8).join(' '), MIND_TITLE_MAX).replace(/[.,;:!]+$/, '') || 'A chat';
    const body = chat.title ? chat.texts.join(' · ') : first;
    return { title, summary: capText(body, MIND_SUMMARY_MAX) || title };
}

function roomFor(source: 'hermes' | 'claude', title: string, chats: Chat[]): MindRoom {
    const screens: MindScreen[] = [];
    const seen = new Set<string>();
    for (const c of [...chats].sort((a, b) => b.mtime - a.mtime)) {
        const s = screenFor(c);
        const key = s.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key); screens.push(s);
        if (screens.length >= MIND_MAX_SCREENS) break;
    }
    return { title: capText(title, MIND_TITLE_MAX) || 'Chats', source, chats: chats.length, screens };
}

/** Group chats from both sources into at most MIND_MAX_ROOMS rooms, the biggest topics first, both sources kept. */
export function groupChats(chats: readonly Chat[]): MindRoom[] {
    const claude = claudeTopics(chats.filter(c => c.source === 'claude')).map(t => roomFor('claude', t.title, t.chats));
    const hermes = hermesTopics(chats.filter(c => c.source === 'hermes'), MIND_MAX_ROOMS).map(t => roomFor('hermes', t.title, t.chats));
    const bySize = (a: MindRoom, b: MindRoom): number => b.chats - a.chats || a.title.localeCompare(b.title);
    claude.sort(bySize); hermes.sort(bySize);
    const picked: MindRoom[] = [];
    if (hermes.length) picked.push(hermes.shift()!);
    if (claude.length) picked.push(claude.shift()!);
    picked.push(...[...hermes, ...claude].sort(bySize).slice(0, MIND_MAX_ROOMS - picked.length));
    // Distinct titles: a Hermes topic and a Claude project may share a word.
    const used = new Set<string>();
    for (const r of picked) {
        let t = r.title, n = 2;
        while (used.has(t.toLowerCase())) t = capText(`${r.title} ${n++}`, MIND_TITLE_MAX);
        used.add(t.toLowerCase()); r.title = t;
    }
    return picked.sort(bySize);
}

/** Read this machine's chats and return redacted rooms + counts. Never throws for missing folders. */
export async function importMind(request: MindImportRequest = {}, options: MindImportOptions = {}): Promise<MindImportResult> {
    const started = Date.now();
    const home = options.home ?? (process.env.OMO_MIND_HOME || os.homedir());
    const until = started + (options.deadlineMs ?? 15000);
    const maxFiles = options.maxFiles ?? 300;
    const stats: ReadStats = { files: 0, skipped: 0 };
    const hermes = request.hermes === false ? { chats: [], found: fs.existsSync(path.join(home, '.hermes', 'sessions')) } : await readHermes(home, until, maxFiles, stats);
    const claude = request.claude === false ? { chats: [], found: fs.existsSync(path.join(home, '.claude', 'projects')) } : await readClaude(home, until, maxFiles, stats);
    const chats = [...hermes.chats, ...claude.chats];
    const rooms = groupChats(chats);
    const screens = rooms.reduce((n, r) => n + r.screens.length, 0);
    return {
        rooms,
        counts: { chats: chats.length, rooms: rooms.length, screens, notes: rooms.length + screens, files: stats.files, skipped: stats.skipped, bytesSent: 0 },
        found: { hermes: hermes.found, claude: claude.found },
        ms: Date.now() - started
    };
}

/** The JSON-RPC face: one method, a fresh read per call, never a path in or out. */
export class MindImportBackend implements MindImportService {
    constructor(protected readonly options: MindImportOptions = {}) { }
    importMind(request: MindImportRequest): Promise<MindImportResult> {
        const r = request && typeof request === 'object' ? request : {};
        return importMind({ hermes: r.hermes !== false, claude: r.claude !== false }, this.options);
    }
}

export function mindImportConnection(backend: MindImportService): MindImportService {
    return Object.freeze(Object.assign(Object.create(null), { importMind: (request: MindImportRequest) => backend.importMind(request) }));
}

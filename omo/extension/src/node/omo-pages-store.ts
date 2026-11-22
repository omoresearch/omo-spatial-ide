/**
 * promise-agent — keeps pages made on demand for good: <workspace>/.omo/pages/<slug>.html, served read-only at
 * /omo-pages/<slug>.html by the same loopback server (the standalone guard runs first). state.json is the
 * live desk state dashboards read every 5 s. Pure Node (fs + path) so it is unit-tested without Theia.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Application, Request, Response } from 'express';
import type { OmoPagesService, SavedPage } from '../common/omo-pages-protocol';
import { MAX_PAGE_BYTES, PAGES_ROUTE, PAGE_SLUG_RE, PageState } from '../common/omo-pages';

export const PAGES_DIR = path.join('.omo', 'pages');
const STATE_FILE = 'state.json';
const MAX_STATE_BYTES = 64 * 1024;

export class OmoPagesStore implements OmoPagesService {
    private state?: PageState;
    constructor(private readonly workspaceRoot: () => Promise<string | undefined>, private readonly now: () => number = Date.now) {}

    /** <workspace>/.omo/pages, created on first use; refuses a workspace that is not a real directory. */
    async dir(create = true): Promise<string> {
        const root = await this.workspaceRoot();
        if (!root || !path.isAbsolute(root) || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Open a workspace folder first: pages are kept in it.');
        const dir = path.join(fs.realpathSync(root), PAGES_DIR);
        if (create) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    async save(input: { slug: string; html: string }): Promise<SavedPage> {
        const slug = String(input?.slug ?? '');
        if (!PAGE_SLUG_RE.test(slug)) throw new Error('A page name uses a–z, 0–9 and dashes.');
        const html = String(input?.html ?? '');
        const bytes = Buffer.byteLength(html, 'utf8');
        if (!bytes || bytes > MAX_PAGE_BYTES) throw new Error(`A page must be 1 byte to ${MAX_PAGE_BYTES / 1024} KiB.`);
        if (!/^<!doctype html>/i.test(html.trimStart())) throw new Error('A page must be a full HTML document.');
        const dir = await this.dir();
        const file = path.join(dir, `${slug}.html`), tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, html, { mode: 0o644 });
        fs.renameSync(tmp, file);
        return { slug, path: `${PAGES_ROUTE}/${slug}.html`, file, bytes, at: this.now() };
    }

    async publishState(state: PageState): Promise<void> {
        const text = JSON.stringify(state ?? {});
        if (Buffer.byteLength(text) > MAX_STATE_BYTES || !state || !Array.isArray(state.desks)) throw new Error('The page state is not valid.');
        this.state = { ...state, at: Number(state.at) || this.now() };
        try {
            const dir = await this.dir();
            const file = path.join(dir, STATE_FILE), tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.state)); fs.renameSync(tmp, file);
        } catch { /* memory only: the dashboard still reads the live state from this server */ }
    }

    async list(): Promise<SavedPage[]> {
        let dir: string;
        try { dir = await this.dir(false); } catch { return []; }
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => /\.html$/.test(f) && PAGE_SLUG_RE.test(f.slice(0, -5))).sort().map(f => {
            const file = path.join(dir, f), st = fs.statSync(file);
            return { slug: f.slice(0, -5), path: `${PAGES_ROUTE}/${f}`, file, bytes: st.size, at: st.mtimeMs };
        });
    }

    /** GET /omo-pages/<slug>.html and /omo-pages/state.json — read-only, no listing, no other files. */
    async serve(name: string): Promise<{ status: number; type: string; body: string }> {
        if (name === STATE_FILE) {
            if (this.state) return { status: 200, type: 'application/json', body: JSON.stringify(this.state) };
            try { return { status: 200, type: 'application/json', body: fs.readFileSync(path.join(await this.dir(false), STATE_FILE), 'utf8') }; } catch { return { status: 404, type: 'application/json', body: '{}' }; }
        }
        const m = /^([a-z0-9][a-z0-9-]{0,47})\.html$/.exec(name);
        if (!m) return { status: 404, type: 'text/plain', body: 'no such page' };
        try {
            const body = fs.readFileSync(path.join(await this.dir(false), `${m[1]}.html`), 'utf8');
            return { status: 200, type: 'text/html; charset=utf-8', body };
        } catch { return { status: 404, type: 'text/plain', body: 'no such page' }; }
    }

    route(app: Application): void {
        app.get(`${PAGES_ROUTE}/:name`, (request: Request, response: Response) => {
            void this.serve(String(request.params.name)).then(r => {
                response.status(r.status).set({ 'Content-Type': r.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }).send(r.body);
            }, () => response.status(500).type('text/plain').send('page error'));
        });
    }
}

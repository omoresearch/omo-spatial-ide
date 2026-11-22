/**
 * promise-agent — pages made on demand (pure: strings in, HTML out; unit-tested).
 * Three local templates, each one self-contained HTML file (no CDN, no external fetch, a strict CSP):
 *   - dashboard: the desks from the world snapshot; reads ./state.json (the live runtime state Omo publishes)
 *     every 5 s and redraws, so the wall stays live.
 *   - notes: a notes / report page with the user's words and the room map.
 *   - landing: a simple landing page with the user's words.
 * Nothing here writes files: the backend page store does (node/omo-pages-store.ts).
 */
import { deskStatus, entityName, PageRequest, WorldSnapshot } from './omo-agent';

export const PAGE_REFRESH_MS = 5000;
export const PAGES_ROUTE = '/omo-pages';
export const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_PAGE_BYTES = 256 * 1024;

export interface DashboardDesk { id: string; name: string; status: string; tabs: string[]; where: string }
export interface PageState { at: number; world: string; desks: DashboardDesk[]; web?: { title: string; url: string } }

export function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
/** JSON safe inside a <script> element (no "</script>", no HTML comment openers, no line separators). */
export function scriptJson(v: unknown): string {
    return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";
const BASE_CSS = `
:root{color-scheme:dark;--bg:#0b1118;--card:#121c27;--line:#21313f;--ink:#e8f1f8;--soft:#8fa3b5;--cyan:#4fd2ff;--green:#5fe0a0;--amber:#ffc35c;--grey:#5b6b7a}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:36px 40px}
h1{font-size:34px;margin:0 0 6px;letter-spacing:-.01em}.sub{color:var(--soft);margin:0 0 28px}
footer{color:var(--grey);font-size:13px;margin-top:28px}`;

function shell(title: string, body: string, css = '', script = ''): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="generator" content="Omo pages">
<title>${escapeHtml(title)}</title><style>${BASE_CSS}${css}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>
`;
}

const STATUS_CLASS: Record<string, string> = { working: 'is-working', waiting: 'is-waiting', idle: 'is-idle', shell: 'is-shell', off: 'is-off' };
const STATUS_TEXT: Record<string, string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Finished', shell: 'Shell open', off: 'Not connected' };

/** The desk cards, server-side (first paint) — the page script draws the same markup on every refresh. */
function deskCards(desks: DashboardDesk[]): string {
    if (!desks.length) return '<p class="empty">No desks in this room yet.</p>';
    return desks.map(d => `<article class="desk ${STATUS_CLASS[d.status] ?? 'is-off'}" data-desk="${escapeHtml(d.id)}"><header><h2>${escapeHtml(d.name)}</h2><span class="pill">${escapeHtml(STATUS_TEXT[d.status] ?? d.status)}</span></header><p class="tabs">${escapeHtml(d.tabs.join(' · ') || 'no tabs')}</p><p class="where">${escapeHtml(d.where)}</p></article>`).join('');
}

export function dashboardPage(req: Pick<PageRequest, 'title'>, state: PageState): string {
    const css = `
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
.desk{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--grey);border-radius:14px;padding:16px 18px}
.desk header{display:flex;justify-content:space-between;align-items:center;gap:8px}.desk h2{font-size:20px;margin:0}
.pill{font-size:12px;padding:3px 9px;border-radius:999px;background:#1d2a36;color:var(--soft);white-space:nowrap}
.tabs{margin:10px 0 2px;color:var(--ink)}.where{margin:0;color:var(--soft);font-size:13px}
.is-working{border-left-color:var(--cyan)}.is-working .pill{color:var(--cyan)}
.is-waiting{border-left-color:var(--amber)}.is-waiting .pill{color:var(--amber)}
.is-idle{border-left-color:var(--green)}.is-idle .pill{color:var(--green)}
.is-shell{border-left-color:#7b8ea0}.empty{color:var(--soft)}
.counts{display:flex;gap:22px;margin:0 0 22px;color:var(--soft)}.counts b{color:var(--ink);font-size:22px;margin-right:6px}
.live{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:6px;vertical-align:middle}
.stale .live{background:var(--amber)}`;
    const script = `
(function(){var S=${scriptJson(STATUS_TEXT)},C=${scriptJson(STATUS_CLASS)};
function e(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function draw(st){var g=document.getElementById('desks'),d=st.desks||[];
g.innerHTML=d.length?d.map(function(x){return '<article class="desk '+(C[x.status]||'is-off')+'" data-desk="'+e(x.id)+'"><header><h2>'+e(x.name)+'</h2><span class="pill">'+e(S[x.status]||x.status)+'</span></header><p class="tabs">'+e((x.tabs||[]).join(' · ')||'no tabs')+'</p><p class="where">'+e(x.where||'')+'</p></article>'}).join(''):'<p class="empty">No desks in this room yet.</p>';
var n=function(s){return d.filter(function(x){return x.status===s}).length};
document.getElementById('n-desks').textContent=d.length;document.getElementById('n-working').textContent=n('working');document.getElementById('n-waiting').textContent=n('waiting');document.getElementById('n-idle').textContent=n('idle');
var age=Math.max(0,Math.round((Date.now()-st.at)/1000));document.body.classList.toggle('stale',age>30);
document.getElementById('updated').textContent='Updated '+new Date(st.at).toLocaleTimeString()+(age>30?' · Omo is not open, showing the last state':'');document.body.dataset.refreshes=String(++refreshes);document.body.dataset.stateAt=String(st.at)}
var refreshes=0;window.__omoDraw=draw;
function tick(){fetch('state.json',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(st){if(st&&st.desks)draw(st)}).catch(function(){})}
setInterval(tick,${PAGE_REFRESH_MS});tick();})();`;
    const count = (s: string): number => state.desks.filter(d => d.status === s).length;
    const body = `<main><h1>${escapeHtml(req.title)}</h1><p class="sub"><span class="live"></span>Live from your Omo room “${escapeHtml(state.world)}” · refreshes every ${PAGE_REFRESH_MS / 1000} s</p>
<div class="counts"><span><b id="n-desks">${state.desks.length}</b>desks</span><span><b id="n-working">${count('working')}</b>working</span><span><b id="n-waiting">${count('waiting')}</b>waiting for you</span><span><b id="n-idle">${count('idle')}</b>finished</span></div>
<section class="grid" id="desks">${deskCards(state.desks)}</section>
<footer id="updated">Updated ${escapeHtml(new Date(state.at).toISOString())}</footer></main>`;
    return shell(req.title, body, css, script);
}

export function notesPage(req: Pick<PageRequest, 'title' | 'words'>, roomMap: string, at = Date.now()): string {
    const css = `article{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 26px;margin-bottom:18px}
article h2{margin:0 0 10px;font-size:18px;color:var(--soft);font-weight:600}pre{white-space:pre-wrap;margin:0;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;color:var(--ink)}
.words{font-size:20px;margin:0}`;
    const body = `<main><h1>${escapeHtml(req.title)}</h1><p class="sub">Made by Omo on ${escapeHtml(new Date(at).toISOString().slice(0, 16).replace('T', ' '))}</p>
<article><h2>Notes</h2><p class="words">${escapeHtml(req.words || req.title)}</p></article>
<article><h2>Your room right now</h2><pre>${escapeHtml(roomMap)}</pre></article><footer>A local page kept in your workspace (.omo/pages).</footer></main>`;
    return shell(req.title, body, css);
}

export function landingPage(req: Pick<PageRequest, 'title' | 'words'>): string {
    const css = `.hero{min-height:88vh;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:18px}
.hero h1{font-size:64px;line-height:1.05;max-width:16ch}.hero p{font-size:22px;color:var(--soft);max-width:40ch;margin:0}
.cta{display:inline-block;margin-top:10px;padding:14px 26px;border-radius:999px;background:var(--cyan);color:#05202b;font-weight:700;text-decoration:none}`;
    const words = req.words || req.title;
    const body = `<main class="hero"><h1>${escapeHtml(req.title)}</h1><p>${escapeHtml(words)}</p><a class="cta" href="#">Get started</a><footer>Made with Omo · a local page in your workspace</footer></main>`;
    return shell(req.title, body, css);
}

/** One page for a request: the template's HTML. */
export function renderPage(req: PageRequest, state: PageState, roomMap: string): string {
    if (req.template === 'dashboard') return dashboardPage(req, state);
    if (req.template === 'landing') return landingPage(req);
    return notesPage(req, roomMap, state.at);
}

/** The live state a dashboard shows, from the world snapshot (desk names, status, tabs, place). */
export function pageStateFrom(snap: Pick<WorldSnapshot, 'world' | 'places' | 'runtime'>, at = Date.now()): PageState {
    const desks: DashboardDesk[] = [];
    for (const e of snap.world.entities) {
        if (e.kind !== 'station') continue;
        const live = snap.runtime.desks.find(d => d.id === e.id);
        desks.push({ id: e.id, name: entityName(e), status: deskStatus(live), tabs: (live?.tabs.length ? live.tabs : e.station.tabs).map(t => t.name), where: snap.places.find(p => p.id === e.id)?.where ?? '' });
    }
    return { at, world: snap.world.name || 'Omo', desks, ...(snap.runtime.web ? { web: { title: snap.runtime.web.title, url: snap.runtime.web.url } } : {}) };
}

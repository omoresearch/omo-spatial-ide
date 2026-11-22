import type { PageState } from './omo-pages';

/**
 * promise-agent — pages made on demand: the frontend renders a page from a local template and the backend
 * keeps it under the workspace (.omo/pages/<slug>.html), served at /omo-pages/<slug>.html on the same
 * loopback server. The dashboard reads /omo-pages/state.json, the live desk state the frontend publishes.
 * Nothing here starts an agent or opens anything outside the workspace's .omo/pages folder.
 */
export const OMO_PAGES_PATH = '/services/omo-pages';
export const OmoPagesService = Symbol('OmoPagesService');

export interface SavedPage { slug: string; path: string; file: string; bytes: number; at: number }
export interface OmoPagesService {
    /** Write (or replace) one page; returns its served path (/omo-pages/<slug>.html). */
    save(input: { slug: string; html: string }): Promise<SavedPage>;
    /** The live state dashboards read (kept in memory and in .omo/pages/state.json). */
    publishState(state: PageState): Promise<void>;
    list(): Promise<SavedPage[]>;
}

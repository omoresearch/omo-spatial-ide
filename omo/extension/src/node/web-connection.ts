import type { OmoWebService } from '../common/web-runtime-protocol';

/** Share one managed Chrome, but never let a frontend control another connection's pages. */
export function webConnection(backend: OmoWebService): { service: OmoWebService; dispose(): Promise<void> } {
    const owned = new Set<string>();
    let disposed = false;
    const check = (id: string): void => { if (disposed || !owned.has(id)) throw new Error('This web page does not belong to this connection.'); };
    const closeAll = async (): Promise<void> => {
        const ids = [...owned]; owned.clear();
        const results = await Promise.allSettled(ids.map(id => backend.close(id)));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
    };
    const service: OmoWebService = {
        status: () => backend.status(),
        open: async args => {
            if (disposed) throw new Error('This browser connection is closed.');
            const page = await backend.open(args);
            if (disposed) { await backend.close(page.id); throw new Error('This browser connection closed while opening the page.'); }
            owned.add(page.id); return page;
        },
        navigate: args => { check(args.id); return backend.navigate(args); },
        frame: args => { check(args.id); return backend.frame(args); },
        click: args => { check(args.id); return backend.click(args); },
        typeText: args => { check(args.id); return backend.typeText(args); },
        key: args => { check(args.id); return backend.key(args); },
        scroll: args => { check(args.id); return backend.scroll(args); },
        setAudio: args => { check(args.id); return backend.setAudio(args); },
        close: async id => { check(id); try { await backend.close(id); } finally { owned.delete(id); } },
        closeAll
    };
    return { service, async dispose() { disposed = true; await closeAll(); } };
}

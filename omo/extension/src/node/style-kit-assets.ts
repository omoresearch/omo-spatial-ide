/**
 * sky:merge — serves installed style-kit assets (baked shells, lightmaps, CC0 props) at /omo-kits/<kit>/...
 *
 * Read-only static files from `omo/kits/` (installed by scripts/fetch-style-kits.cjs, verified against
 * style-kits.lock.json). The standalone loopback guard (standalone-security.ts) runs before this route.
 * Missing kits just 404: the frontend then draws the theme's procedural shell.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Application } from 'express';
import type { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { injectable } from '@theia/core/shared/inversify';

const KIT_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** First existing kits directory: OMO_SPATIAL_KITS, else `kits/` next to the app (bundled backend: browser-app/lib/backend). */
export function resolveKitsRoot(env: NodeJS.ProcessEnv, dirname: string): string | undefined {
    const candidates = [env.OMO_SPATIAL_KITS, env.THEIA_APP_PROJECT_PATH && path.resolve(env.THEIA_APP_PROJECT_PATH, '..', 'kits'),
        path.resolve(dirname, '..', '..', '..', 'kits'), path.resolve(dirname, '..', '..', 'kits'), path.resolve(process.cwd(), 'kits')];
    for (const c of candidates) { if (c) { try { if (fs.statSync(c).isDirectory()) return c; } catch { /* next */ } } }
    return undefined;
}

@injectable()
export class StyleKitAssets implements BackendApplicationContribution {
    configure(app: Application): void {
        const root = resolveKitsRoot(process.env, __dirname);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const express = require('@theia/core/shared/express') as typeof import('express');
        app.use('/omo-kits/:kit', (request, response, next) => {
            const kit = String(request.params.kit);
            if (!root || !KIT_RE.test(kit)) { response.status(404).type('text/plain').send('style kit not installed'); return; }
            const dir = path.join(root, kit);
            if (!fs.existsSync(dir)) { response.status(404).type('text/plain').send('style kit not installed'); return; }
            express.static(dir, { dotfiles: 'deny', index: false, fallthrough: false, maxAge: '1h', immutable: false })(request, response, next);
        });
    }
}

/**
 * sky:merge — serves installed style-kit assets (baked shells, lightmaps, CC0 props) at /omo-kits/<kit>/...
 *
 * Read-only static files from `omo/kits/` (installed by scripts/fetch-style-kits.cjs, verified against
 * style-kits.lock.json). The standalone loopback guard (standalone-security.ts) runs before this route.
 * Missing kits just 404: the frontend then draws the theme's procedural shell.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Application, NextFunction, Request, Response } from 'express';
import type { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { injectable } from '@theia/core/shared/inversify';

const KIT_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** room modules: the baked room modules live in `kits/modules/<id>/` (one exact id per request, never a path). */
export const MODULE_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * The directory a /omo-kits request may read, or undefined (404). `kit` is the first path segment; for 'modules' the
 * second segment is the module id. Exact ids only (no dots, no slashes, no encoded tricks): traversal can not name a
 * directory outside `root/<kit>` or `root/modules/<id>`. A module also needs its module.json.
 */
export function kitDir(root: string | undefined, kit: string, module?: string): string | undefined {
    if (!root || !KIT_RE.test(kit)) return undefined;
    if (kit === 'modules') {
        if (module === undefined || !MODULE_RE.test(module)) return undefined;
        const dir = path.join(root, 'modules', module);
        return fs.existsSync(path.join(dir, 'module.json')) ? dir : undefined;
    }
    const dir = path.join(root, kit);
    return fs.existsSync(dir) ? dir : undefined;
}

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
        mountStyleKits(app, resolveKitsRoot(process.env, __dirname));
    }
}

/** Mount the read-only /omo-kits routes on `app` (exported for the route test). */
export function mountStyleKits(app: Application, root: string | undefined): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require('@theia/core/shared/express') as typeof import('express');
    const serve = (dir: string | undefined, request: Request, response: Response, next: NextFunction): void => {
        if (!dir) { response.status(404).type('text/plain').send('style kit not installed'); return; }
        express.static(dir, { dotfiles: 'deny', index: false, fallthrough: false, maxAge: '1h', immutable: false })(request, response, next);
    };
    // room modules: /omo-kits/modules/<id>/<file> (registered first: the generic route below never serves 'modules').
    app.use('/omo-kits/modules/:module', (request: Request, response: Response, next: NextFunction) => serve(kitDir(root, 'modules', String(request.params.module)), request, response, next));
    app.use('/omo-kits/:kit', (request: Request, response: Response, next: NextFunction) => {
        const kit = String(request.params.kit);
        serve(kit === 'modules' ? undefined : kitDir(root, kit), request, response, next);
    });
}

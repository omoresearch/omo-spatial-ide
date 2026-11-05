import * as net from 'node:net';
import type { Application, NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import type { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import type { WsRequestValidatorContribution } from '@theia/core/lib/node/ws-request-validators';

export interface StandaloneHeaders {
    host?: string | string[];
    origin?: string | string[];
}

export interface StandaloneGuardResult {
    allowed: boolean;
    detail: string;
}

function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

function authority(value: string): { host: string; port: string } | undefined {
    if (!value || value.includes(',') || /[\s\\/@]/.test(value)) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(`http://${value}`);
    } catch {
        return undefined;
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = parsed.port || '80';
    if (host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'))) {
        return { host, port };
    }
    return undefined;
}

function sameAuthority(host: string, origin: URL): boolean {
    const expected = authority(host);
    if (!expected || !['http:', 'https:'].includes(origin.protocol)) return false;
    const actualHost = origin.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const actualPort = origin.port || (origin.protocol === 'https:' ? '443' : '80');
    return actualHost === expected.host && actualPort === expected.port;
}

/**
 * Standalone local-mode boundary. The host header is the authority check for
 * both HTTP and WebSocket upgrades. Origin, when a browser sends it, must be
 * the same loopback authority. X-Forwarded-Host is deliberately ignored.
 * Team mode returns a delegation result because team auth owns that boundary.
 */
export function checkStandaloneLoopback(headers: StandaloneHeaders, teamMode = false): StandaloneGuardResult {
    if (teamMode) return { allowed: true, detail: 'team mode owns host, origin and token authorization' };
    if ((Array.isArray(headers.host) && headers.host.length !== 1) || (Array.isArray(headers.origin) && headers.origin.length !== 1)) {
        return { allowed: false, detail: 'standalone runtime requires single Host and Origin values' };
    }
    const host = first(headers.host);
    const parsedHost = host && authority(host);
    if (!parsedHost) return { allowed: false, detail: 'standalone runtime requires a loopback Host header' };
    const origin = first(headers.origin);
    if (origin !== undefined) {
        if (origin === 'null' || origin.includes(',') || origin.length > 2048) {
            return { allowed: false, detail: 'standalone runtime refused the Origin header' };
        }
        let parsedOrigin: URL;
        try {
            parsedOrigin = new URL(origin);
        } catch {
            return { allowed: false, detail: 'standalone runtime refused the Origin header' };
        }
        if (parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password || !sameAuthority(host, parsedOrigin)) {
            return { allowed: false, detail: 'standalone runtime requires a same-authority loopback Origin' };
        }
    }
    return { allowed: true, detail: 'loopback Host and Origin accepted' };
}

/** HTTP request hook for a Theia backend contribution. */
export function allowStandaloneHttp(headers: StandaloneHeaders, teamMode = false): boolean {
    return checkStandaloneLoopback(headers, teamMode).allowed;
}

/** WebSocket upgrade hook. It uses the same check as HTTP, not a weaker path check. */
export function allowStandaloneWebSocket(headers: StandaloneHeaders, teamMode = false): boolean {
    return checkStandaloneLoopback(headers, teamMode).allowed;
}

export class StandaloneSecurity {
    readonly teamMode: boolean;

    constructor(teamMode = false) {
        this.teamMode = teamMode;
    }

    http(headers: StandaloneHeaders): StandaloneGuardResult {
        return checkStandaloneLoopback(headers, this.teamMode);
    }

    websocket(headers: StandaloneHeaders): StandaloneGuardResult {
        return checkStandaloneLoopback(headers, this.teamMode);
    }
}

/** Registers the same standalone guard at both Theia boundaries. */
export class StandaloneSecurityContribution implements BackendApplicationContribution, WsRequestValidatorContribution {
    private readonly guard: StandaloneSecurity;

    constructor(teamMode = process.env.OMO_SPATIAL_TEAM_MODE === '1' || process.env.OMO_SPATIAL_MODE === 'team') {
        this.guard = new StandaloneSecurity(teamMode);
    }

    configure(app: Application): void {
        app.use((request: Request, response: Response, next: NextFunction) => {
            const result = this.guard.http(request.headersDistinct || request.headers);
            if (!result.allowed) {
                response.status(403).type('text/plain').send(result.detail);
                return;
            }
            next();
        });
    }

    allowWsUpgrade(request: IncomingMessage): boolean {
        return this.guard.websocket(request.headersDistinct || request.headers).allowed;
    }
}

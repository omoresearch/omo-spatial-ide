/**
 * world-magic — the 'Magic effects' setting as a plain module flag (the UI lane wires the switch later).
 *
 * On by default; off when the user prefers reduced motion (creation becomes instant, no arrival glide).
 * Opt out with localStorage 'omo.magic' = '0'. Quality: 'auto' (low on a software renderer), 'high' or 'low'
 * (localStorage 'omo.magic.quality'). Sound follows `volume` / `muted` (localStorage 'omo.magic.volume' 0..1,
 * 'omo.magic.muted' = '1'). Every read is guarded so unit rigs without DOM / storage still load this file.
 */
export type MagicQuality = 'auto' | 'high' | 'low';

export interface WorldMagicSettings {
    /** Master switch for every effect in the world-magic modules. */
    enabled: boolean;
    quality: MagicQuality;
    /** Master volume for the synthesised room sound, 0..1. */
    volume: number;
    muted: boolean;
}

function stored(key: string): string | null {
    try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
}

export const worldMagicSettings: WorldMagicSettings = {
    enabled: stored('omo.magic') !== '0',
    quality: ((q): MagicQuality => q === 'high' || q === 'low' ? q : 'auto')(stored('omo.magic.quality')),
    volume: ((v): number => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)(Number(stored('omo.magic.volume') ?? '0.5')),
    muted: stored('omo.magic.muted') === '1'
};

const listeners = new Set<() => void>();
/** Change settings (the UI lane's switch calls this). Listeners re-read `worldMagicSettings`. */
export function setWorldMagic(patch: Partial<WorldMagicSettings>): void {
    Object.assign(worldMagicSettings, patch);
    try {
        if (typeof localStorage !== 'undefined') {
            if (patch.enabled !== undefined) localStorage.setItem('omo.magic', patch.enabled ? '1' : '0');
            if (patch.quality !== undefined) localStorage.setItem('omo.magic.quality', patch.quality);
            if (patch.volume !== undefined) localStorage.setItem('omo.magic.volume', String(patch.volume));
            if (patch.muted !== undefined) localStorage.setItem('omo.magic.muted', patch.muted ? '1' : '0');
        }
    } catch { /* no storage */ }
    for (const fn of [...listeners]) { try { fn(); } catch { /* never break a caller */ } }
}
export function onWorldMagicChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

export function prefersReducedMotion(): boolean {
    try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
/** Effects on at all (setting on). Reduced motion keeps calm light but drops motion (see each module). */
export function magicOn(): boolean { return worldMagicSettings.enabled; }

/** Resolved quality: 'auto' becomes 'low' on a software rasteriser (SwiftShader / llvmpipe), else 'high'. */
export function resolveQuality(gl: WebGLRenderingContext | WebGL2RenderingContext | undefined): 'high' | 'low' {
    if (worldMagicSettings.quality !== 'auto') return worldMagicSettings.quality;
    if (!gl) return 'low';
    try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        return /swiftshader|llvmpipe|software|basic render/i.test(name) ? 'low' : 'high';
    } catch { return 'high'; }
}

/** The one warm accent of every effect (restraint: no rainbow). */
export const MAGIC_WARM = 0xffc98a;
export const MAGIC_WARM_SOFT = 0xffe4c2;

export function easeOutBack(t: number, s = 1.35): number { const u = t - 1; return 1 + u * u * ((s + 1) * u + s); }
export function easeOutCubic(t: number): number { const u = 1 - t; return 1 - u * u * u; }
export function easeInOutCubic(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

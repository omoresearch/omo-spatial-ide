import * as React from 'react';
import type { AgentKind } from '../common/runtime-protocol';

/**
 * Per-kind agent glyphs (w2:polish redesign). Each kind has its own silhouette and its own colour
 * token, so no two kinds read as the same mark at 12 px:
 *   Hermes  winged staff: staff, swept wings, top orb, coil   --omo-agent-hermes (gold)
 *   Claude  sunburst: ten tapered rays round a hub           --omo-agent-claude (pink)
 *   Codex   ring with a centre dot                           --omo-agent-codex  (blue)
 *   Shell   prompt  >_                                       --omo-agent-shell  (grey)
 *   dsh     whale spout over two waves                       --omo-agent-dsh    (cyan)
 * One 24×24 design per kind, shared by the SVG component (tabs, chips) and the in-world name tags
 * (drawn on a canvas with Path2D). A design is one or more parts, each filled or stroked.
 */
export type AgentGlyphKind = AgentKind | 'dsh';
export interface GlyphPart { d: string; mode: 'fill' | 'stroke' }
export interface GlyphShape {
    name: string;
    /** Design token that holds the colour (design-tokens.css). */
    token: string;
    /** The token's default value, for places with no CSS (canvas before the room mounts, tests). */
    color: string;
    parts: GlyphPart[];
}

const STROKE = 2.6;

/** Ten tapered rays round a hub: reads as a burst, never as a four-point star. */
function burstPath(rays = 10, inner = 3.4, outer = 10.6, half = 0.2): string {
    const pt = (r: number, a: number): string => `${(12 + r * Math.sin(a)).toFixed(2)} ${(12 - r * Math.cos(a)).toFixed(2)}`;
    let d = '';
    for (let i = 0; i < rays; i++) {
        const a = (i / rays) * Math.PI * 2;
        d += `M${pt(inner, a - half)}L${pt(outer, a)}L${pt(inner, a + half)}Z`;
    }
    return d + 'M12 9.2A2.8 2.8 0 1 1 11.99 9.2Z';
}

export const AGENT_GLYPHS: Record<AgentGlyphKind, GlyphShape> = {
    hermes: {
        name: 'Hermes winged staff', token: '--omo-agent-hermes', color: '#f7d774',
        parts: [{
            mode: 'fill',
            // staff, top orb, left wing, right wing
            d: 'M11 6.2H13V22H11Z'
                + 'M12 1.6A2 2 0 1 1 11.99 1.6Z'
                + 'M10.6 7.2C8.4 5 5 4.4 1.6 5.2C3.4 6 4.8 6.9 5.6 8C4 8.1 2.8 8.6 2.2 9.6C5 10.4 8 10.3 10.6 9.4Z'
                + 'M13.4 7.2C15.6 5 19 4.4 22.4 5.2C20.6 6 19.2 6.9 18.4 8C20 8.1 21.2 8.6 21.8 9.6C19 10.4 16 10.3 13.4 9.4Z'
        }, {
            mode: 'stroke',
            // the coil round the staff
            d: 'M15 12.2C15 14 9 14 9 15.8S15 17.6 15 19.4'
        }]
    },
    claude: { name: 'Claude burst', token: '--omo-agent-claude', color: '#ebb3e0', parts: [{ mode: 'fill', d: burstPath() }] },
    codex: {
        name: 'Codex ring', token: '--omo-agent-codex', color: '#a9cdf5',
        parts: [{ mode: 'stroke', d: 'M12 3.8A8.2 8.2 0 1 1 11.99 3.8Z' }, { mode: 'fill', d: 'M12 9.8A2.2 2.2 0 1 1 11.99 9.8Z' }]
    },
    shell: { name: 'Shell prompt', token: '--omo-agent-shell', color: '#b7c4cb', parts: [{ mode: 'stroke', d: 'M4 6.5L9.5 12L4 17.5M12 18H20' }] },
    dsh: {
        name: 'dsh whale and wave', token: '--omo-agent-dsh', color: '#5ccfe6',
        parts: [{
            mode: 'stroke',
            // spout, then two waves
            d: 'M12 2.8V7.4M8.6 4.4L12 7.4L15.4 4.4'
                + 'M2 13.6C4.4 10.8 7 10.8 9 13.2S13.6 15.6 16 12.8C17.6 11 20 10.6 22 12'
                + 'M2 19.2C4.4 16.6 7 16.6 9 18.8S13.6 21 16 18.6C17.6 17 20 16.6 22 17.8'
        }]
    }
};

export function isGlyphKind(kind: AgentKind | string | undefined): kind is AgentGlyphKind {
    return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(AGENT_GLYPHS, kind);
}

/** Small inline glyph. Renders nothing for unknown kinds. Colour comes from the kind's design token. */
export function AgentGlyph(props: { kind: AgentKind | string | undefined; size?: number; className?: string }): React.ReactElement | null {
    if (!isGlyphKind(props.kind)) return null;
    const g = AGENT_GLYPHS[props.kind];
    const size = props.size ?? 12;
    return <svg className={`omo-agent-glyph is-${props.kind}${props.className ? ` ${props.className}` : ''}`} data-glyph={props.kind} width={size} height={size} viewBox="0 0 24 24"
        role="img" aria-label={g.name} style={{ verticalAlign: '-0.12em', flex: 'none', marginRight: 3, color: `var(${g.token}, ${g.color})` }}>
        {g.parts.map((p, i) => <path key={i} data-mode={p.mode} d={p.d} fill={p.mode === 'fill' ? 'currentColor' : 'none'} stroke={p.mode === 'stroke' ? 'currentColor' : 'none'}
            strokeWidth={p.mode === 'stroke' ? STROKE : 0} strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>;
}

/** The token's live value inside the Omo root (themes may override it), else its default value. */
export function glyphColor(kind: AgentGlyphKind): string {
    const g = AGENT_GLYPHS[kind];
    try {
        const root = typeof document !== 'undefined' ? document.querySelector('.omo-root') : null;
        const live = root ? getComputedStyle(root).getPropertyValue(g.token).trim() : '';
        return live || g.color;
    } catch { return g.color; }
}

/** Draw a glyph on a 2D canvas (in-world name tags). `x`,`y` is the top-left; `size` in pixels. */
export function drawAgentGlyph(c: CanvasRenderingContext2D, kind: AgentGlyphKind, x: number, y: number, size: number): void {
    if (typeof Path2D === 'undefined' || !isGlyphKind(kind)) return;
    const g = AGENT_GLYPHS[kind], color = glyphColor(kind);
    c.save(); c.translate(x, y); c.scale(size / 24, size / 24);
    for (const part of g.parts) {
        const path = new Path2D(part.d);
        if (part.mode === 'fill') { c.fillStyle = color; c.fill(path); }
        else { c.strokeStyle = color; c.lineWidth = STROKE; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(path); }
    }
    c.restore();
}

import * as React from 'react';
import type { AgentKind } from '../common/runtime-protocol';

/**
 * Per-kind agent glyphs from the mod pack: Hermes spark, Claude burst, Codex ring.
 * One 24×24 path per kind, shared by the SVG component (tabs, chips) and the in-world
 * name tags (drawn on a canvas with Path2D). Shell tabs have no glyph.
 */
export type AgentGlyphKind = Exclude<AgentKind, 'shell'>;
export interface GlyphShape { d: string; mode: 'fill' | 'stroke'; color: string; name: string }

export const AGENT_GLYPHS: Record<AgentGlyphKind, GlyphShape> = {
    hermes: { name: 'Hermes spark', mode: 'fill', color: '#e9b949', d: 'M12 2L14.2 9.8L22 12L14.2 14.2L12 22L9.8 14.2L2 12L9.8 9.8Z' },
    claude: { name: 'Claude burst', mode: 'stroke', color: '#e07a45', d: 'M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4' },
    codex: { name: 'Codex ring', mode: 'stroke', color: '#4f8fe8', d: 'M12 4A8 8 0 1 1 11.99 4Z' },
    dsh: { name: 'dsh wave', mode: 'stroke', color: '#4d6bfe', d: 'M3 14C6 10 9 10 12 14S18 18 21 14' } // w2:agents (minimal; w2-polish owns the real glyph)
};

export function isGlyphKind(kind: AgentKind | string | undefined): kind is AgentGlyphKind {
    return kind === 'hermes' || kind === 'claude' || kind === 'codex' || kind === 'dsh'; // w2:agents
}

/** Small inline glyph. Renders nothing for shell tabs or unknown kinds. */
export function AgentGlyph(props: { kind: AgentKind | string | undefined; size?: number; className?: string }): React.ReactElement | null {
    if (!isGlyphKind(props.kind)) return null;
    const g = AGENT_GLYPHS[props.kind];
    const size = props.size ?? 12;
    return <svg className={`omo-agent-glyph is-${props.kind}${props.className ? ` ${props.className}` : ''}`} data-glyph={props.kind} width={size} height={size} viewBox="0 0 24 24"
        role="img" aria-label={g.name} style={{ verticalAlign: '-0.12em', flex: 'none', marginRight: 3 }}>
        <path d={g.d} fill={g.mode === 'fill' ? g.color : 'none'} stroke={g.mode === 'stroke' ? g.color : 'none'} strokeWidth={g.mode === 'stroke' ? 3 : 0} strokeLinecap="round" strokeLinejoin="round" />
    </svg>;
}

/** Draw a glyph on a 2D canvas (in-world name tags). `x`,`y` is the top-left; `size` in pixels. */
export function drawAgentGlyph(c: CanvasRenderingContext2D, kind: AgentGlyphKind, x: number, y: number, size: number): void {
    const g = AGENT_GLYPHS[kind];
    if (typeof Path2D === 'undefined') return;
    c.save(); c.translate(x, y); c.scale(size / 24, size / 24);
    const path = new Path2D(g.d);
    if (g.mode === 'fill') { c.fillStyle = g.color; c.fill(path); }
    else { c.strokeStyle = g.color; c.lineWidth = 3; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(path); }
    c.restore();
}

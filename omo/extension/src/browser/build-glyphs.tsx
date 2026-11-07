import * as React from 'react';

/**
 * Build mode glyphs (w2 build lane). Same grid and stroke as icons.tsx (24×24, 1.75, round joins,
 * currentColor) so the palette sits next to the shared icon set. Only build mode uses these;
 * general controls use <Icon/> from icons.tsx.
 */
export type BuildGlyphName =
    | 'desk-agent' | 'desk-shell' | 'monitor-wall' | 'web-wall' | 'mirror' | 'review'
    | 'plant' | 'lamp' | 'crystal' | 'sofa' | 'bookshelf' | 'whiteboard' | 'rug' | 'window'
    | 'build' | 'cursor' | 'move' | 'rotate' | 'link' | 'trash' | 'undo' | 'redo' | 'unlock' | 'setup' | 'sparkle';

const P: Record<BuildGlyphName, React.ReactNode> = {
    'desk-agent': <><path d="M3 12.5h18M5 12.5V19M19 12.5V19" /><rect x="8" y="5" width="8" height="5" rx="1" /><path d="M12 10v2.5" /><circle cx="18.5" cy="5.5" r="1.6" fill="currentColor" stroke="none" /></>,
    'desk-shell': <><path d="M3 12.5h18M5 12.5V19M19 12.5V19" /><rect x="8" y="5" width="8" height="5" rx="1" /><path d="M12 10v2.5M9.8 6.8l1.2 .9-1.2 .9" /></>,
    'monitor-wall': <><rect x="2.5" y="4" width="8.5" height="6" rx="1" /><rect x="13" y="4" width="8.5" height="6" rx="1" /><rect x="2.5" y="12" width="8.5" height="6" rx="1" /><rect x="13" y="12" width="8.5" height="6" rx="1" /><path d="M9 21h6" /></>,
    'web-wall': <><rect x="2.5" y="4" width="19" height="14" rx="1.5" /><path d="M2.5 8h19" /><circle cx="12" cy="13" r="3" /><path d="M9 13h6M12 10c1 1 1 5 0 6" /></>,
    mirror: <><rect x="5" y="3" width="14" height="16" rx="7" /><path d="M9 8.5l3-2M9.5 12l5-3.5" /><path d="M9 21h6" /></>,
    review: <><rect x="3" y="4" width="18" height="14" rx="1.5" /><path d="M7 8.5h4M7 11.5h7M7 14.5h3M15.5 13.5l1.5 1.5 2.5-3" /></>,
    plant: <><path d="M8 15h8l-1 5.5H9Z" /><path d="M12 15V9M12 11c-3 0-5-2-5-5 3 0 5 2 5 5ZM12 9.5c0-2.7 1.8-4.5 4.5-4.5 0 2.7-1.8 4.5-4.5 4.5Z" /></>,
    lamp: <><path d="M8 3.5h8l2 6H6Z" /><path d="M12 9.5V19M8.5 20.5h7" /></>,
    crystal: <><path d="M12 2.8 17 9l-5 12.2L7 9Z" /><path d="M7 9h10M12 2.8V21.2" /></>,
    sofa: <><path d="M4.5 10V8a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v2" /><path d="M3 11a1.5 1.5 0 0 1 3 0v2h12v-2a1.5 1.5 0 0 1 3 0v5.5H3ZM5 16.5V19M19 16.5V19" /></>,
    bookshelf: <><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M4 9h16M4 15h16M7 5v4M9 5.5V9M13 11v4M15.5 11.5 17 15M8 17v4" /></>,
    whiteboard: <><rect x="3" y="3.5" width="18" height="12" rx="1" /><path d="M7 15.5 5 21M17 15.5l2 5.5M7 8.5c2-2 3 1 5-1s3 1 5-1" /></>,
    rug: <><rect x="3" y="7" width="18" height="10" rx="2" /><rect x="6" y="9.5" width="12" height="5" rx="1" /><path d="M3 9H1.5M3 12H1.5M3 15H1.5M21 9h1.5M21 12h1.5M21 15h1.5" /></>,
    window: <><rect x="4" y="3.5" width="16" height="17" rx="1" /><path d="M12 3.5v17M4 12h16" /></>,
    build: <><path d="M3.5 20.5 13 11" /><path d="M14.5 3.5a5 5 0 0 0-1.5 7.5l1 1a5 5 0 0 0 7.5-1.5l-3-.5-1-1-.5-3Z" /></>,
    cursor: <path d="M5 3.5 18.5 12l-6 1.5-3 6Z" />,
    move: <path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" />,
    rotate: <><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4.5h-4.5" /></>,
    link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
    trash: <><path d="M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5l1 13.5h9l1-13.5M10.5 10.5v6M13.5 10.5v6" /></>,
    undo: <><path d="M8.5 5 4 9.5 8.5 14" /><path d="M4 9.5h10a6 6 0 0 1 0 12H10" /></>,
    redo: <><path d="M15.5 5 20 9.5 15.5 14" /><path d="M20 9.5H10a6 6 0 0 0 0 12h4" /></>,
    unlock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" /></>,
    setup: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></>,
    sparkle: <path d="M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5ZM18.5 15.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5Z" />
};

export function BuildGlyph(props: { name: BuildGlyphName | string; size?: number; className?: string }): React.ReactElement {
    const size = props.size ?? 16;
    return <svg className={`omo-icon omo-build-glyph${props.className ? ` ${props.className}` : ''}`} data-glyph={props.name} width={size} height={size} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden={true} focusable="false">
        {P[props.name as BuildGlyphName] ?? P.build}
    </svg>;
}

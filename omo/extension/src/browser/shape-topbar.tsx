import * as React from 'react';
import { shapeStore } from './shape-store';

/** shape — the small "Shape" button in the world top bar. A click toggles Shape mode (Space does the same). */
export function ShapeTopButton(): React.ReactElement {
    const [open, setOpen] = React.useState(shapeStore.open);
    React.useEffect(() => shapeStore.subscribe(setOpen), []);
    return <button type="button" className={`omo-topbar-shape${open ? ' is-on' : ''}`} data-testid="topbar-shape" aria-pressed={open}
        title={open ? 'Leave Shape (Esc)' : 'Shape this room (Space)'} onMouseDown={e => e.preventDefault()} onClick={() => shapeStore.requestToggle()}>
        <ShapeGlyph size={14} />Shape
    </button>;
}

/** A soft four-point spark: the one Shape mark. */
export function ShapeGlyph(props: { size?: number }): React.ReactElement {
    const s = props.size ?? 16;
    return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.5c.35 2.9 1.6 4.15 4.5 4.5-2.9.35-4.15 1.6-4.5 4.5-.35-2.9-1.6-4.15-4.5-4.5 2.9-.35 4.15-1.6 4.5-4.5Z" fill="currentColor" />
        <path d="M12.6 10.2c.15 1.2.65 1.7 1.9 1.9-1.25.15-1.75.65-1.9 1.9-.15-1.25-.7-1.75-1.9-1.9 1.2-.2 1.75-.7 1.9-1.9Z" fill="currentColor" opacity=".7" />
    </svg>;
}

/**
 * w3:build — the "World size" section of the build palette: +/− for width and depth (4 m steps,
 * SHELL_MIN..SHELL_MAX) and the Open world toggle. Each click is one proposal step; Apply saves it.
 * Shrinking is refused (with the name of the thing in the way) when it would cut something off.
 */
import * as React from 'react';
import type { BuildMode } from './build-mode';
import type { WorldSpec } from '../common/world-model';
import { SHELL_MIN, SHELL_MAX } from '../common/world-model';
import { SHELL_STEP } from './build-room';
import { BuildGlyph } from './build-glyphs';
import { Icon } from './icons';

/** The next size one step up / down: back onto the 4 m grid, within SHELL_MIN..SHELL_MAX. */
export function stepSize(n: number, dir: 1 | -1): number {
    // w4:big — the step grows with the world: 4 m below 40 m, 20 m below 200 m, then 100 m (1 km in a few clicks).
    const base = dir > 0 ? n : n - 1;
    const step = base < 40 ? SHELL_STEP : base < 200 ? 20 : 100;
    const next = dir > 0 ? Math.floor(n / step) * step + step : Math.ceil(n / step) * step - step;
    return Math.min(SHELL_MAX, Math.max(SHELL_MIN, next));
}

function Stepper(props: { label: string; value: number; testid: string; onStep: (dir: 1 | -1) => void }): React.ReactElement {
    return <div className="omo-build-stepper" data-testid={props.testid}>
        <span>{props.label}</span>
        <button type="button" aria-label={`${props.label} smaller`} data-testid={`${props.testid}-minus`} disabled={props.value <= SHELL_MIN}
            onMouseDown={e => e.preventDefault()} onClick={() => props.onStep(-1)}>−</button>
        <output aria-live="polite">{props.value} m</output>
        <button type="button" aria-label={`${props.label} bigger`} data-testid={`${props.testid}-plus`} disabled={props.value >= SHELL_MAX}
            onMouseDown={e => e.preventDefault()} onClick={() => props.onStep(1)}>+</button>
    </div>;
}

export function WorldSizeSection(props: { build: BuildMode; world: WorldSpec }): React.ReactElement {
    const { build, world } = props, shell = world.shell;
    return <section className="omo-build-group omo-build-world" data-testid="build-world-size">
        <h3><BuildGlyph name="world-size" size={12} /> World size</h3>
        <Stepper label="Width" testid="build-world-width" value={shell.width} onStep={dir => build.resizeWorld(stepSize(shell.width, dir), shell.depth)} />
        <Stepper label="Depth" testid="build-world-depth" value={shell.depth} onStep={dir => build.resizeWorld(shell.width, stepSize(shell.depth, dir))} />
        <label className={`omo-build-lockrow omo-build-openrow${shell.open ? ' is-on' : ''}`}>
            <input type="checkbox" data-testid="build-world-open" checked={!!shell.open} onChange={e => build.setOpenWorld(e.target.checked)} />
            <span className="omo-build-switch" aria-hidden="true" />
            <span><strong><BuildGlyph name="open-world" size={12} /> Open world</strong>
                <small>No outer walls: open ground up to {SHELL_MAX} × {SHELL_MAX} m. Build rooms on it.</small></span>
        </label>
        <p className="omo-build-world-note"><Icon name="expand" size={12} /> Place things past the edge and the world grows to fit.</p>
    </section>;
}

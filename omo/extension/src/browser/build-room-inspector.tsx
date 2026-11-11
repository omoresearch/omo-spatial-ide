/**
 * w3:build — the Room part of the build inspector: width / depth, a doorway toggle per side and the theme.
 * Every change is one 'reshape' proposal step (BuildMode.reshapeRoom); nothing is saved until Apply.
 */
import * as React from 'react';
import type { BuildMode } from './build-mode';
import type { RoomEntity, WallSide } from '../common/world-model';
import { ROOM_MIN, ROOM_MAX, WALL_SIDES } from '../common/world-model';
import { DOOR_WIDTH } from './build-room';

const SIDE_LABEL: Record<WallSide, string> = { back: 'Back', front: 'Front', left: 'Left', right: 'Right' };
const fmt = (n: number): string => String(Math.round(n * 10) / 10);

function SizeField(props: { label: string; value: number; testid: string; onCommit: (n: number) => void }): React.ReactElement {
    const [text, setText] = React.useState(fmt(props.value));
    React.useEffect(() => setText(fmt(props.value)), [props.value]);
    const commit = (): void => {
        const n = Math.round(Number(text) * 2) / 2; // snaps to 0.5 m like the Room tool
        if (Number.isFinite(n) && n >= ROOM_MIN && n <= ROOM_MAX) { if (n !== props.value) props.onCommit(n); else setText(fmt(props.value)); } else setText(fmt(props.value));
    };
    return <label className="omo-build-num"><span>{props.label}</span>
        <input type="number" inputMode="decimal" data-testid={props.testid} min={ROOM_MIN} max={ROOM_MAX} step={0.5} value={text}
            onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} /><em>m</em></label>;
}

export function RoomInspector(props: { build: BuildMode; room: RoomEntity }): React.ReactElement {
    const { build, room } = props;
    const doors = room.doors ?? ['front'];
    const reshape = (p: Partial<{ width: number; depth: number; doors: WallSide[]; theme: RoomEntity['theme'] }>): void =>
        build.reshapeRoom(room.id, { width: room.width, depth: room.depth, doors: [...doors], theme: room.theme, ...p });
    const toggle = (side: WallSide): void => reshape({ doors: doors.includes(side) ? doors.filter(d => d !== side) : WALL_SIDES.filter(d => d === side || doors.includes(d)) });
    return <div className="omo-build-room" data-testid="build-room">
        <div className="omo-build-size">
            <SizeField label="Width" testid="build-room-width" value={room.width} onCommit={n => reshape({ width: n })} />
            <SizeField label="Depth" testid="build-room-depth" value={room.depth} onCommit={n => reshape({ depth: n })} />
        </div>
        <div className="omo-build-field"><span>Doorways</span>
            <div className="omo-build-doors" role="group" aria-label="Doorways">{WALL_SIDES.map(side =>
                <button key={side} type="button" aria-pressed={doors.includes(side)} data-testid={`build-room-door-${side}`}
                    className={doors.includes(side) ? 'is-on' : ''} onClick={() => toggle(side)}>{SIDE_LABEL[side]}</button>)}</div>
            <small>{doors.length ? `A ${DOOR_WIDTH} m gap in the ${doors.map(d => SIDE_LABEL[d].toLowerCase()).join(', ')} wall${doors.length === 1 ? '' : 's'}.` : 'No doorway: the room is closed.'}</small>
        </div>
        <label className="omo-build-field"><span>Theme</span>
            <select data-testid="build-room-theme" value={room.theme ?? ''} onChange={e => reshape({ theme: (e.target.value || undefined) as RoomEntity['theme'] })}>
                {!room.theme && <option value="">Same as the world</option>}
                <option value="station">Station</option>
                <option value="jungle">Jungle</option>
            </select></label>
    </div>;
}

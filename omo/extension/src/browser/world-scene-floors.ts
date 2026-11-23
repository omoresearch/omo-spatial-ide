/**
 * HQ floors (HQ-FLOORS.md) — browser side: each floor room stands alone far from the penthouse (floorSpot), so it
 * needs (a) a city backdrop centred on itself (the penthouse city panorama, reprojected around the floor, so the glass
 * shows the skyline exactly like the Blender render), (b) only the floor you are on drawn, (c) a walker held inside the
 * floor's walls, and (d) the left room rail that glides between the HQ and its floors.
 */
import * as THREE from 'three';
import type { RoomEntity, WorldSpec } from '../common/world-model';
import { floorRooms, roomRect } from '../common/world-model';
import { floorArrival, HQ_ID, railEntries } from '../common/hq-floors';
import type { RailEntry } from '../common/hq-floors';
import type { PlayerPose } from '../common/player-state';
import type { WorldMover } from './world-scene-collision';

/** The floor room the point stands in (with a 1 m margin round its walls), or undefined = the HQ. */
export function floorAt(world: Pick<WorldSpec, 'entities'>, p: { x: number; z: number }): RoomEntity | undefined {
    return floorRooms(world).find(r => { const b = roomRect(r); return p.x > b.minX - 1 && p.x < b.maxX + 1 && p.z > b.minZ - 1 && p.z < b.maxZ + 1; });
}

/**
 * The walker on a floor: the base mover (furniture blocks, room walls) clamped to the floor's interior. Off any floor
 * the base mover (the HQ penthouse rules) runs unchanged; on a floor `floorBase` (same colliders, no penthouse bounds). A floor's bounds never let the walker leave through its
 * door: floors are reached with the rail (the door is the way back: walking into it returns to the HQ).
 */
export function floorMover(world: WorldSpec, base: WorldMover, floorBase: WorldMover, home: () => PlayerPose, onDoor: () => void): WorldMover {
    return (player, input, seconds) => {
        const room = floorAt(world, player);
        if (!room) return base(player, input, seconds);
        const b = roomRect(room), pad = 0.35;
        const next = floorBase(player, input, seconds); // floorBase: the same blocks and walls without the penthouse bounds
        // The front door (local +z, rotation 0 floors): stepping into the doorway returns to the HQ.
        if (next.z > b.maxZ - 0.3 && Math.abs(next.x - room.transform.x) < 0.7) { onDoor(); return { ...home() }; }
        return { ...next, x: Math.max(b.minX + pad, Math.min(b.maxX - pad, next.x)), z: Math.max(b.minZ + pad, Math.min(b.maxZ - pad, next.z)) };
    };
}

/** Where the walker lands on rail entry `id` (HQ: the kit spawn). Pitch 0: eye level, like the render's camera. */
export function arrivalPose(world: WorldSpec, id: string, hq: PlayerPose): PlayerPose {
    if (id === HQ_ID) return { ...hq };
    const room = floorRooms(world).find(r => r.id === id);
    if (!room) return { ...hq };
    const a = floorArrival(room);
    return { x: a.x, z: a.z, yaw: a.yaw, pitch: -0.02 };
}

/**
 * Show only what belongs where the camera is: on a floor, that floor's room and the entities inside it; in the HQ,
 * everything except floor rooms and the entities standing on them. `roots` maps entity id -> root.
 */
export function floorVisibility(world: WorldSpec, here: RoomEntity | undefined, roots: ReadonlyMap<string, THREE.Object3D>): void {
    const floors = floorRooms(world);
    if (!floors.length) return;
    const onFloor = (p: { x: number; z: number }): RoomEntity | undefined => floors.find(r => { const b = roomRect(r); return p.x > b.minX - 0.5 && p.x < b.maxX + 0.5 && p.z > b.minZ - 0.5 && p.z < b.maxZ + 0.5; });
    for (const e of world.entities) {
        const root = roots.get(e.id); if (!root) continue;
        const f = e.kind === 'room' && e.floor ? e : onFloor(e.transform);
        root.visible = here ? f?.id === here.id : !f;
    }
}

/** The left room rail (DOM): HQ first, then each floor; click = glide there. Collapsed 56 px, 240 px on hover. */
export class FloorRail {
    readonly el: HTMLElement;
    private key = '';
    constructor(host: HTMLElement, private readonly go: (id: string) => void) {
        this.el = document.createElement('nav');
        this.el.className = 'omo-floor-rail'; this.el.dataset.testid = 'floor-rail'; this.el.setAttribute('aria-label', 'Rooms');
        this.el.style.cssText = [
            'position:absolute', 'left:10px', 'top:64px', 'z-index:30', 'display:none', 'flex-direction:column', 'gap:6px', 'padding:8px',
            'width:56px', 'overflow:hidden', 'border-radius:16px', 'background:rgba(16,17,22,0.62)', 'backdrop-filter:blur(14px)',
            'border:1px solid rgba(255,255,255,0.08)', 'box-shadow:0 8px 30px rgba(0,0,0,0.35)', 'transition:width 160ms ease', 'font:500 13px/1.2 Inter,system-ui,sans-serif', 'color:#e9e6e1'
        ].join(';');
        this.el.addEventListener('mouseenter', () => { this.el.style.width = '240px'; });
        this.el.addEventListener('mouseleave', () => { this.el.style.width = '56px'; });
        host.appendChild(this.el);
    }
    render(entries: readonly RailEntry[], current: string): void {
        const key = JSON.stringify([entries, current]);
        if (key === this.key) return; this.key = key;
        this.el.style.display = entries.length ? 'flex' : 'none';
        this.el.replaceChildren(...entries.map((e, i) => {
            const b = document.createElement('button');
            b.type = 'button'; b.dataset.testid = 'floor-rail-item'; b.dataset.floor = e.id; b.dataset.current = String(e.id === current);
            b.title = `${e.label}${i < 9 ? `  (Ctrl+${i + 1})` : ''}`;
            b.style.cssText = `display:flex;align-items:center;gap:12px;width:224px;padding:6px;border:0;border-radius:11px;cursor:pointer;text-align:left;color:inherit;background:${e.id === current ? 'rgba(255,255,255,0.14)' : 'transparent'}`;
            const icon = document.createElement('span');
            icon.textContent = ICON[e.icon] ?? '◻';
            icon.style.cssText = `flex:0 0 28px;height:28px;display:grid;place-items:center;border-radius:9px;font-size:15px;background:${e.id === current ? 'rgba(232,201,150,0.28)' : 'rgba(255,255,255,0.07)'}`;
            const text = document.createElement('span');
            text.style.cssText = 'display:flex;flex-direction:column;white-space:nowrap';
            const name = document.createElement('span'); name.textContent = e.label;
            const sub = document.createElement('span'); sub.textContent = e.desks ? `${e.desks} desk${e.desks === 1 ? '' : 's'} · live` : e.icon === 'hq' ? 'Penthouse' : 'Room';
            sub.style.cssText = 'font-size:11px;color:#a8adb8';
            text.append(name, sub); b.append(icon, text);
            b.addEventListener('click', ev => { ev.stopPropagation(); this.go(e.id); });
            return b;
        }));
    }
    dispose(): void { this.el.remove(); }
}
const ICON: Record<string, string> = { hq: '⌂', library: '📚', lounge: '🛋', studio: '⌨' };

/** A 0.6 s fade over the canvas for a glide between floors; `mid` runs at full black. */
export function fadeGlide(host: HTMLElement, mid: () => void): void {
    const veil = document.createElement('div');
    veil.dataset.testid = 'floor-glide';
    veil.style.cssText = 'position:absolute;inset:0;z-index:29;background:#07080b;opacity:0;pointer-events:none;transition:opacity 280ms ease';
    host.appendChild(veil);
    requestAnimationFrame(() => { veil.style.opacity = '1'; });
    window.setTimeout(() => { mid(); veil.style.opacity = '0'; window.setTimeout(() => veil.remove(), 320); }, 300);
}

export { railEntries };

import * as THREE from 'three';
import type { RoomScene, TerminalWorkstation } from './room-scene';
import type { FirstPersonControls, FocusScreen } from './first-person-controls';
import type { PlayerPose } from '../common/player-state';

export const FOCUS_STATIONS: readonly TerminalWorkstation[] = ['terminal', 'terminal-2'];
/** Same reach as clicking a monitor in the room. */
export const FOCUS_REACH = 3.2;
// Desk monitor in desk-local space (room-scene desk()). Used only if the live mesh is not reachable.
const DESK_SCREEN = { y: 1.99, z: -0.296, width: 1.58, height: 0.9 };

/** The room's walking controls, through RoomScene's public focusTarget() accessor. */
export function sceneControls(scene: RoomScene | undefined): FirstPersonControls | undefined {
    return scene?.focusTarget().controls;
}

/**
 * World geometry of a desk's real screen mesh. Reads the scene's own mesh so the
 * frame stays right when the room changes; falls back to the published desk spots.
 */
export function stationScreen(scene: RoomScene | undefined, canvas: HTMLCanvasElement | undefined, station: TerminalWorkstation): FocusScreen | undefined {
    const mesh = scene?.focusTarget(station).screen;
    if (mesh instanceof THREE.Mesh && mesh.geometry instanceof THREE.PlaneGeometry) {
        mesh.updateWorldMatrix(true, false);
        const center = mesh.getWorldPosition(new THREE.Vector3()), scale = mesh.getWorldScale(new THREE.Vector3());
        const normal = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld).setY(0);
        if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
        normal.normalize();
        const { width, height } = mesh.geometry.parameters;
        return { id: station, center: { x: center.x, y: center.y, z: center.z }, normal: { x: normal.x, z: normal.z }, width: width * scale.x, height: height * scale.y };
    }
    try {
        const desk = (JSON.parse(canvas?.dataset.deskPositions || '{}') as Record<string, { x: number; z: number }>)[station];
        if (!desk) return undefined;
        return { id: station, center: { x: desk.x, y: DESK_SCREEN.y, z: desk.z + DESK_SCREEN.z }, normal: { x: 0, z: 1 }, width: DESK_SCREEN.width, height: DESK_SCREEN.height };
    } catch { return undefined; }
}

/** The desk monitor the player is closest to and roughly facing, within reach. */
export function nearestStation(scene: RoomScene | undefined, canvas: HTMLCanvasElement | undefined, pose: PlayerPose): TerminalWorkstation | undefined {
    let best: { station: TerminalWorkstation; score: number } | undefined;
    for (const station of FOCUS_STATIONS) {
        const screen = stationScreen(scene, canvas, station); if (!screen) continue;
        const dx = screen.center.x - pose.x, dz = screen.center.z - pose.z, distance = Math.hypot(dx, dz);
        if (distance > FOCUS_REACH) continue;
        // Camera looks along -z rotated by yaw. Ignore screens behind the player.
        const facing = (-Math.sin(pose.yaw) * dx - Math.cos(pose.yaw) * dz) / (distance || 1);
        if (facing < 0.2) continue;
        const score = distance * (2 - facing);
        if (!best || score < best.score) best = { station, score };
    }
    return best?.station;
}

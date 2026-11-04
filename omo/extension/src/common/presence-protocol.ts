import type { RoomTheme } from './room-state';
import type { PlayerPose } from './player-state';
export const OMO_PRESENCE_PATH = '/services/omo-presence';
export const OmoPresenceService = Symbol('OmoPresenceService');
export interface PresenceJoin { roomId: string; name: string; clientId: string; projectUri: string; theme: RoomTheme }
export interface RoomMember { id: string; name: string; pose: PlayerPose }
export interface RoomSnapshot { roomId: string; theme: RoomTheme; selfId: string; members: RoomMember[] }
/** Local trusted clients only. No terminal contents or remote-control messages. */
export interface OmoPresenceService {
    join(input: PresenceJoin): Promise<RoomSnapshot>;
    update(pose: PlayerPose): Promise<RoomSnapshot>;
    leave(): Promise<void>;
}
export function presenceJoin(input: PresenceJoin): PresenceJoin {
    if (!input || typeof input.roomId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(input.roomId)) throw new Error('Room code must be 3–32 lowercase letters, numbers or hyphens.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)) throw new Error('Name must be 1–32 characters without control characters.');
    if (typeof input.clientId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.clientId)) throw new Error('Invalid tab identity.');
    if (typeof input.projectUri !== 'string' || input.projectUri.length > 4096 || !input.projectUri.startsWith('file:///') || /[\u0000-\u001f]/u.test(input.projectUri)) throw new Error('Choose a local project.');
    if (input.theme !== 'station' && input.theme !== 'jungle') throw new Error('Invalid room theme.');
    return { roomId: input.roomId, name: input.name.trim(), clientId: input.clientId, projectUri: input.projectUri, theme: input.theme };
}
export function presencePose(pose: PlayerPose): PlayerPose {
    if (!pose || ![pose.x,pose.z,pose.yaw,pose.pitch].every(n=>typeof n==='number' && Number.isFinite(n)) || Math.abs(pose.x)>5.5 || pose.z< -3.8 || pose.z>4.45 || Math.abs(pose.yaw)>Math.PI || Math.abs(pose.pitch)>1.2) throw new Error('Invalid room position.');
    return { x:pose.x,z:pose.z,yaw:pose.yaw,pitch:pose.pitch };
}
/** Default binding separation, NOT authorization. Existing workspace tools remain OS-user shared. */
export function presenceStation(input: PresenceJoin, station: string): string {
    const valid=presenceJoin(input); return `room-${valid.roomId}-${valid.clientId}-${station}`;
}

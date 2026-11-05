import type { RoomTheme } from './room-state';
import type { PlayerPose, RoomLayoutId } from './player-state';
export const OMO_PRESENCE_PATH = '/services/omo-presence';
export const OmoPresenceService = Symbol('OmoPresenceService');
export interface PresenceJoin { roomId: string; name: string; clientId: string; projectUri: string; theme: RoomTheme; layout?: RoomLayoutId }
export interface RoomMember { id: string; name: string; pose: PlayerPose; voice?: VoiceStatus }
export interface RoomSnapshot { roomId: string; theme: RoomTheme; selfId: string; members: RoomMember[]; layout?: RoomLayoutId }
/** Local trusted clients only. No terminal contents or remote-control messages. */
export interface OmoPresenceService {
    join(input: PresenceJoin): Promise<RoomSnapshot>;
    update(pose: PlayerPose): Promise<RoomSnapshot>;
    leave(): Promise<void>;
    // --- room voice (additive). Signalling only: no audio ever passes through the backend. ---
    /** Publish or clear (null) this connection's own voice status. Requires a joined room. */
    setVoice(status: VoiceStatus | null): Promise<void>;
    /** Relay one WebRTC signalling message to a voice-enabled member of the same room. */
    signal(message: VoiceSignal): Promise<void>;
    /** Take (and clear) the signalling messages addressed to this connection. */
    takeSignals(): Promise<VoiceSignalEnvelope[]>;
}
/** Voice state a member chose to publish. Booleans only; never audio, transcripts or terminal text. */
export interface VoiceStatus { session: string; muted: boolean; speaking: boolean }
export type VoiceSignalKind = 'offer' | 'answer' | 'ice' | 'bye';
export interface VoiceSignal { to: string; toSession: string; session: string; kind: VoiceSignalKind; data: string }
export interface VoiceSignalEnvelope { from: string; fromSession: string; kind: VoiceSignalKind; data: string }
export const VOICE_SIGNAL_MAX_CHARS = 16 * 1024;
export const VOICE_INBOX_MAX = 64;
const VOICE_SESSION = /^[a-f0-9]{8,32}$/;
export function voiceStatus(input: VoiceStatus | null): VoiceStatus | null {
    if (input === null) return null;
    if (!input || typeof input.session !== 'string' || !VOICE_SESSION.test(input.session) || typeof input.muted !== 'boolean' || typeof input.speaking !== 'boolean') throw new Error('Invalid voice status.');
    return { session: input.session, muted: input.muted, speaking: input.speaking && !input.muted };
}
export function voiceSignal(input: VoiceSignal): VoiceSignal {
    if (!input || typeof input.to !== 'string' || input.to.length > 64 || typeof input.toSession !== 'string' || !VOICE_SESSION.test(input.toSession)
        || typeof input.session !== 'string' || !VOICE_SESSION.test(input.session)) throw new Error('Invalid voice signal address.');
    if (input.kind !== 'offer' && input.kind !== 'answer' && input.kind !== 'ice' && input.kind !== 'bye') throw new Error('Invalid voice signal kind.');
    if (typeof input.data !== 'string' || input.data.length > VOICE_SIGNAL_MAX_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.data)) throw new Error('Invalid voice signal payload.');
    if ((input.kind === 'offer' || input.kind === 'answer') && /^m=(?!audio)/m.test(input.data)) throw new Error('Room voice carries audio only.');
    return { to: input.to, toSession: input.toSession, session: input.session, kind: input.kind, data: input.data };
}
export function presenceLayout(input: Pick<PresenceJoin, 'layout'>): RoomLayoutId {
    return input.layout ?? 'classic';
}
export function presenceJoin(input: PresenceJoin): PresenceJoin {
    if (!input || typeof input.roomId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(input.roomId)) throw new Error('Room code must be 3–32 lowercase letters, numbers or hyphens.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)) throw new Error('Name must be 1–32 characters without control characters.');
    if (typeof input.clientId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.clientId)) throw new Error('Invalid tab identity.');
    if (typeof input.projectUri !== 'string' || input.projectUri.length > 4096 || !input.projectUri.startsWith('file:///') || /[\u0000-\u001f]/u.test(input.projectUri)) throw new Error('Choose a local project.');
    if (input.theme !== 'station' && input.theme !== 'jungle') throw new Error('Invalid room theme.');
    if (input.layout !== undefined && input.layout !== 'classic' && input.layout !== 'wide') throw new Error('Invalid room layout.');
    const normalized: PresenceJoin = { roomId: input.roomId, name: input.name.trim(), clientId: input.clientId, projectUri: input.projectUri, theme: input.theme };
    if (input.layout === 'wide') normalized.layout = 'wide';
    return normalized;
}
export function presencePose(pose: PlayerPose): PlayerPose {
    if (!pose || ![pose.x,pose.z,pose.yaw,pose.pitch].every(n=>typeof n==='number' && Number.isFinite(n)) || Math.abs(pose.x)>5.5 || pose.z< -3.8 || pose.z>4.45 || Math.abs(pose.yaw)>Math.PI || Math.abs(pose.pitch)>1.2) throw new Error('Invalid room position.');
    return { x:pose.x,z:pose.z,yaw:pose.yaw,pitch:pose.pitch };
}
/** Default binding separation, NOT authorization. Existing workspace tools remain OS-user shared. */
export function presenceStation(input: PresenceJoin, station: string): string {
    const valid=presenceJoin(input); return `room-${valid.roomId}-${valid.clientId}-${station}`;
}

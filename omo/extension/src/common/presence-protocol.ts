import type { RoomTheme } from './room-state';
import type { PlayerPose, RoomLayoutId } from './player-state';
export const OMO_PRESENCE_PATH = '/services/omo-presence';
export const OmoPresenceService = Symbol('OmoPresenceService');
export interface PresenceJoin { roomId: string; name: string; clientId: string; projectUri: string; theme: RoomTheme; layout?: RoomLayoutId }
export interface RoomMember { id: string; name: string; pose: PlayerPose; voice?: VoiceStatus; /** Name-tag colour (additive). One of PRESENCE_COLOURS. */ colour?: PresenceColour }
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
    // --- room text chat and name colour (additive). Room members only; nothing is stored on disk. ---
    /** Choose this member's name-tag colour. Requires a joined room. */
    setColour(colour: PresenceColour): Promise<void>;
    /** Say one line (or one emote) to the other members of this room. Returns the stored message. */
    say(input: ChatSay): Promise<ChatMessage>;
    /** Take (and clear) the chat messages other members sent to this connection since the last call. */
    takeChat(): Promise<ChatMessage[]>;
}
/** A small fixed palette. Colours are never free text, so a tag cannot carry markup or tracking. */
export const PRESENCE_COLOURS = ['coral', 'amber', 'lime', 'mint', 'sky', 'violet', 'rose', 'sand'] as const;
export type PresenceColour = typeof PRESENCE_COLOURS[number];
export const PRESENCE_COLOUR_HEX: Record<PresenceColour, string> = {
    coral: '#ff7a6b', amber: '#ffc04d', lime: '#a6e35a', mint: '#5fe0b5', sky: '#5fb4ff', violet: '#b48cff', rose: '#ff6fc4', sand: '#e0c9a0'
};
export function presenceColour(input: unknown): PresenceColour {
    if (typeof input !== 'string' || !(PRESENCE_COLOURS as readonly string[]).includes(input)) throw new Error('Choose one of the room colours.');
    return input as PresenceColour;
}
/** Emotes are a closed set: the receiver draws them, the sender cannot send pictures or markup. */
export const CHAT_EMOTES = ['wave', 'cheer', 'thumbsup', 'clap'] as const;
export type ChatEmote = typeof CHAT_EMOTES[number];
export type ChatSay = { kind: 'text'; text: string } | { kind: 'emote'; emote: ChatEmote };
export interface ChatMessage { id: string; from: string; fromName: string; colour?: PresenceColour; at: number; kind: 'text' | 'emote'; text?: string; emote?: ChatEmote }
export const CHAT_TEXT_MAX = 500;
export const CHAT_INBOX_MAX = 100;
/** At most CHAT_RATE_COUNT lines per CHAT_RATE_WINDOW_MS per member. */
export const CHAT_RATE_COUNT = 8;
export const CHAT_RATE_WINDOW_MS = 10_000;
export function chatSay(input: ChatSay): ChatSay {
    if (!input || typeof input !== 'object') throw new Error('Invalid chat message.');
    if (input.kind === 'emote') {
        if (!(CHAT_EMOTES as readonly string[]).includes(input.emote)) throw new Error('Unknown emote.');
        return { kind: 'emote', emote: input.emote };
    }
    if (input.kind !== 'text' || typeof input.text !== 'string') throw new Error('Invalid chat message.');
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(input.text)) throw new Error('Chat is one line of plain text, without control characters.');
    const text = input.text.trim();
    if (!text) throw new Error('Type a message first.');
    if (text.length > CHAT_TEXT_MAX) throw new Error(`Chat lines are at most ${CHAT_TEXT_MAX} characters.`);
    return { kind: 'text', text };
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

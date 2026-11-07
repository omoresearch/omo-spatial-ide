import type { PlayerPose } from './player-state';
import type { OmoPresenceService, VoiceSignal, VoiceSignalEnvelope, VoiceSignalKind, VoiceStatus } from './presence-protocol';
import { VOICE_INBOX_MAX, VOICE_SIGNAL_MAX_CHARS, voiceSignal, voiceStatus } from './presence-protocol';

/**
 * Voice signalling transport (w2 voice lane).
 *
 * Room voice is a WebRTC mesh. Audio goes peer to peer (or through the user's own TURN relay);
 * only small signalling messages (SDP offer/answer, ICE candidates, bye) and a per-member voice
 * status travel through a transport. The SAME RoomVoiceController runs over:
 *   - the local presence service (trusted clients of one Omo backend): `localPresenceTransport`
 *   - the remote room server (multiplayer across computers): `remoteRoomVoiceTransport`, which
 *     adapts a message channel. The mp-client lane maps its room-wire-protocol voice messages
 *     onto `VoiceWireOut` / `VoiceWireIn` below (same field names, no extra data).
 *
 * Rules: a transport never carries audio, transcripts, terminal text or credentials.
 */

/** One room member as voice needs it. RoomSnapshot['members'] already satisfies this. */
export interface VoiceRosterMember { id: string; name: string; pose: PlayerPose; voice?: VoiceStatus }
export interface VoiceRoster { selfId: string; members: VoiceRosterMember[] }

export interface VoiceSignalTransport {
    /** 'local-presence' | 'remote-room' (free text for diagnostics only). */
    readonly kind: string;
    /** Publish (or clear with null) this member's voice status to the room. */
    publish(status: VoiceStatus | null): Promise<void>;
    /** Send one signalling message to one voice member of the same room. */
    send(signal: VoiceSignal): Promise<void>;
    /** Take (and clear) signalling messages addressed to this member, oldest first. */
    take(): Promise<VoiceSignalEnvelope[]>;
    /** Remote rooms supply their own roster; local presence uses the presence snapshot (undefined here). */
    roster?(): VoiceRoster | undefined;
    dispose?(): void;
}

/** The existing local presence backend as a voice transport (poll based). */
export function localPresenceTransport(service: Pick<OmoPresenceService, 'setVoice' | 'signal' | 'takeSignals'>): VoiceSignalTransport {
    return {
        kind: 'local-presence',
        publish: status => service.setVoice(status),
        send: signal => service.signal(signal),
        take: () => service.takeSignals()
    };
}

// ---- remote room server adapter -------------------------------------------------------------

/** Messages this client sends to the room server (mp-client maps these onto room-wire-protocol). */
export type VoiceWireOut =
    | { type: 'voice.status'; status: VoiceStatus | null }
    | { type: 'voice.signal'; signal: VoiceSignal };
/** Messages the room server delivers to this client. */
export type VoiceWireIn =
    | { type: 'voice.signal'; envelope: VoiceSignalEnvelope }
    | { type: 'voice.roster'; roster: VoiceRoster };

export interface VoiceWireChannel {
    send(message: VoiceWireOut): void | Promise<void>;
    /** Subscribe to inbound messages; returns an unsubscribe function. */
    onMessage(listener: (message: VoiceWireIn) => void): () => void;
}

const KINDS: readonly VoiceSignalKind[] = ['offer', 'answer', 'ice', 'bye'];
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^[a-f0-9]{8,32}$/;

/** Validates an inbound envelope from an untrusted network peer. Returns undefined when invalid. */
export function voiceEnvelope(input: unknown): VoiceSignalEnvelope | undefined {
    const e = input as VoiceSignalEnvelope;
    if (!e || typeof e !== 'object' || typeof e.from !== 'string' || !MEMBER_ID.test(e.from) || typeof e.fromSession !== 'string' || !SESSION.test(e.fromSession)) return undefined;
    if (!KINDS.includes(e.kind) || typeof e.data !== 'string' || e.data.length > VOICE_SIGNAL_MAX_CHARS) return undefined;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(e.data)) return undefined;
    if ((e.kind === 'offer' || e.kind === 'answer') && /^m=(?!audio)/m.test(e.data)) return undefined;
    return { from: e.from, fromSession: e.fromSession, kind: e.kind, data: e.data };
}

function rosterOf(input: unknown): VoiceRoster | undefined {
    const r = input as VoiceRoster;
    if (!r || typeof r !== 'object' || typeof r.selfId !== 'string' || !Array.isArray(r.members) || r.members.length > 64) return undefined;
    const members: VoiceRosterMember[] = [];
    for (const m of r.members) {
        if (!m || typeof m.id !== 'string' || !MEMBER_ID.test(m.id) || typeof m.name !== 'string' || m.name.length > 64) continue;
        const p = m.pose;
        if (!p || ![p.x, p.z, p.yaw, p.pitch].every(n => typeof n === 'number' && Number.isFinite(n))) continue;
        let voice: VoiceStatus | undefined;
        if (m.voice) { try { voice = voiceStatus(m.voice) ?? undefined; } catch { voice = undefined; } }
        members.push({ id: m.id, name: m.name, pose: { x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch }, ...(voice ? { voice } : {}) });
    }
    return { selfId: r.selfId, members };
}

/**
 * Remote room server as a voice transport. Inbound signals are pushed by the channel and queued
 * (bounded, oldest dropped) so the controller can `take()` them exactly like the local poll path.
 */
export function remoteRoomVoiceTransport(channel: VoiceWireChannel): VoiceSignalTransport & { readonly queued: number } {
    let inbox: VoiceSignalEnvelope[] = [];
    let roster: VoiceRoster | undefined;
    let closed = false;
    const off = channel.onMessage(message => {
        if (closed || !message || typeof message !== 'object') return;
        if (message.type === 'voice.signal') {
            const envelope = voiceEnvelope(message.envelope);
            if (!envelope) return;
            inbox.push(envelope);
            if (inbox.length > VOICE_INBOX_MAX) inbox.splice(0, inbox.length - VOICE_INBOX_MAX);
        } else if (message.type === 'voice.roster') {
            roster = rosterOf(message.roster) ?? roster;
        }
    });
    return {
        kind: 'remote-room',
        get queued() { return inbox.length; },
        publish: async status => { if (closed) throw new Error('Voice transport closed.'); await channel.send({ type: 'voice.status', status: voiceStatus(status) }); },
        send: async signal => { if (closed) throw new Error('Voice transport closed.'); await channel.send({ type: 'voice.signal', signal: voiceSignal(signal) }); },
        take: async () => { const out = inbox; inbox = []; return out; },
        roster: () => roster,
        dispose: () => { closed = true; inbox = []; off(); }
    };
}

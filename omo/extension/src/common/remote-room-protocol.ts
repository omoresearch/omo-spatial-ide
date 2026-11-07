/**
 * IDE-internal RPC between the browser and the IDE backend for REMOTE rooms (w2 mp-client lane).
 * The backend owns the WebSocket to the room server (see room-wire-protocol.ts) and the member
 * token file; the browser never sees a member or owner token after it hands it over.
 *
 * The presence/chat/voice half mirrors OmoPresenceService exactly, so the browser can route the
 * existing PresenceController, VoiceHub and HudHub to a remote room without changing them.
 */
import type { PlayerPose } from './player-state';
import type { ChatMessage, ChatSay, PresenceColour, RoomSnapshot, VoiceSignal, VoiceSignalEnvelope, VoiceStatus } from './presence-protocol';
import type { AgentStatusSummary, RemoteRoomMember, RoomInviteRole, RoomRole } from './room-wire-protocol';
import type { WorldOp, WorldSpec } from './world-model';

export const OMO_REMOTE_ROOM_PATH = '/services/omo-remote-room';
export const OmoRemoteRoomService = Symbol('OmoRemoteRoomService');

/**
 * idle: not in a remote room. connecting: first connection. joined: live.
 * reconnecting: lost the socket, retrying with backoff (presence keeps the last snapshot).
 * failed: the server refused us for good (bad invite, removed, …); needs a user action.
 */
export type RemoteRoomPhase = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'failed';

export interface RemoteRoomStatus {
    phase: RemoteRoomPhase;
    /** Server origin (https://host[:port]); never contains secrets. */
    server?: string;
    roomId?: string;
    roomName?: string;
    role?: RoomRole;
    selfId?: string;
    /** Reconnect attempt number (0 when joined). */
    attempt: number;
    /** Epoch ms of the next automatic retry while reconnecting. */
    retryAt?: number;
    error: string;
    worldRevision?: number;
    members: RemoteRoomMember[];
}

/** A room this IDE holds a member token for. The token itself never leaves the backend. */
export interface SavedRemoteRoom { server: string; roomId: string; roomName: string; role: RoomRole; savedAt: number }

export interface RemoteJoinRequest { name: string; colour?: PresenceColour }
export interface RemoteHostRequest {
    /** https://… (or http://localhost for development). */
    server: string;
    /**
     * t3:mp2 — the OWNER KEY printed once by `omo-room-server create-room` (omo1.<room>.<member>.<secret>).
     * The IDE backend keeps it in its private token file (0600, never in the browser) so it can reconnect.
     */
    ownerToken: string;
    roomId: string;
    roomName?: string;
    /** Starting world when the server creates the room (e.g. the host's current room). */
    seedWorld?: WorldSpec;
}

export type RemoteWorldResult =
    | { ok: true; revision: number; world: WorldSpec }
    /** The room changed under us. `world` is the fresh server world; re-apply the preview on it and ask again. */
    | { ok: false; conflict: true; error: string; world: WorldSpec }
    | { ok: false; conflict: false; error: string };

export interface OmoRemoteRoomService {
    // --- connection ---
    joinInvite(link: string, join: RemoteJoinRequest): Promise<RemoteRoomStatus>;
    host(input: RemoteHostRequest, join: RemoteJoinRequest): Promise<RemoteRoomStatus>;
    /** Rejoin a saved room with its stored member token. */
    rejoin(server: string, roomId: string, join: RemoteJoinRequest): Promise<RemoteRoomStatus>;
    /** Skip the backoff wait and try now. */
    reconnectNow(): Promise<RemoteRoomStatus>;
    /** Leave the room (tells the server). The saved token is kept for a later rejoin. */
    leave(): Promise<void>;
    status(): Promise<RemoteRoomStatus>;
    saved(): Promise<SavedRemoteRoom[]>;
    /** Delete the stored member token for one room. */
    forget(server: string, roomId: string): Promise<void>;
    /** Owner only. `role` (t3:mp2): what the invited person may do; default member. */
    createInvite(options?: { ttlMinutes?: number; maxUses?: number; role?: RoomInviteRole }): Promise<{ link: string; expiresAt: number; role?: RoomInviteRole }>;
    /** t3:mp2 — owner only: change another member's role (viewer, member, builder). */
    setMemberRole(memberId: string, role: RoomInviteRole): Promise<void>;
    // --- presence, voice, chat: the same contract as OmoPresenceService ---
    snapshot(): Promise<RoomSnapshot>;
    update(pose: PlayerPose): Promise<RoomSnapshot>;
    setVoice(status: VoiceStatus | null): Promise<void>;
    signal(message: VoiceSignal): Promise<void>;
    takeSignals(): Promise<VoiceSignalEnvelope[]>;
    setColour(colour: PresenceColour): Promise<void>;
    say(input: ChatSay): Promise<ChatMessage>;
    takeChat(): Promise<ChatMessage[]>;
    /** Publish this member's agent status summaries (closed vocabulary only). */
    setAgents(agents: AgentStatusSummary[]): Promise<void>;
    // --- shared world ---
    world(): Promise<WorldSpec | undefined>;
    refreshWorld(): Promise<WorldSpec>;
    applyWorldOps(baseRevision: number, ops: WorldOp[]): Promise<RemoteWorldResult>;
}

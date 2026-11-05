import type { OmoPresenceService, RoomMember, RoomSnapshot, VoiceSignalEnvelope } from '../common/presence-protocol';
import type { PlayerPose } from '../common/player-state';

/**
 * Room voice for trusted local clients in the same shared room.
 *
 * - The microphone is requested only from enable(), which the UI calls from a click.
 * - Audio goes peer to peer (WebRTC) to voice-enabled members of THIS room only.
 *   No STUN/TURN servers are configured, so no relay or third party ever carries audio.
 * - The backend only relays bounded signalling (SDP/ICE) through the presence channel.
 * - Push-to-talk is the default: nothing is sent until the user holds V.
 */
export type VoiceMode = 'push' | 'open';
export type VoicePhase = 'off' | 'starting' | 'on' | 'error';
export interface VoicePeerState { id: string; name: string; connection: string; speaking: boolean; muted: boolean; volume: number; distance?: number }
export interface RoomVoiceState {
    phase: VoicePhase;
    mode: VoiceMode;
    muted: boolean;
    /** True while audio is actually leaving this tab (PTT held or open mic, and not muted). */
    transmitting: boolean;
    pushHeld: boolean;
    speaking: boolean;
    level: number;
    proximity: boolean;
    peers: VoicePeerState[];
    error: string;
    notice: string;
}

export interface VoiceMediaApi {
    getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
    createPeer(config: RTCConfiguration): RTCPeerConnection;
    createAudio(stream: MediaStream): { volume: number; muted: boolean; play(): Promise<void> | void; remove(): void };
    createAnalyser?(stream: MediaStream): { level(): number; resume?(): void; close(): void } | undefined;
}

interface Options {
    service: Pick<OmoPresenceService, 'setVoice' | 'signal' | 'takeSignals'>;
    media: VoiceMediaApi;
    pose(): PlayerPose;
    schedule(fn: () => void, ms: number): unknown;
    cancel(handle: unknown): void;
    onChange(state: RoomVoiceState): void;
    random?(): string;
}

interface Peer {
    id: string;
    session: string;
    pc: RTCPeerConnection;
    audio?: ReturnType<VoiceMediaApi['createAudio']>;
    pendingIce: RTCIceCandidateInit[];
    remoteSet: boolean;
    offerer: boolean;
    createdAt: number;
}

const POLL_MS = 250;
const CONNECT_TIMEOUT_MS = 12000;
const SPEAK_THRESHOLD = 0.02;
const SPEAK_HOLD_MS = 900;
/** Full volume within NEAR metres, fading linearly to FLOOR at FAR metres. A room is small; never fully silent. */
export const PROXIMITY = { near: 2.5, far: 10, floor: 0.12 };

export function proximityVolume(distance: number): number {
    if (!Number.isFinite(distance) || distance <= PROXIMITY.near) return 1;
    if (distance >= PROXIMITY.far) return PROXIMITY.floor;
    const t = (distance - PROXIMITY.near) / (PROXIMITY.far - PROXIMITY.near);
    return Math.round((1 - t * (1 - PROXIMITY.floor)) * 100) / 100;
}

function randomSession(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function browserVoiceMedia(): VoiceMediaApi | undefined {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') return undefined;
    return {
        getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
        createPeer: config => new RTCPeerConnection(config),
        createAudio: stream => {
            const element = document.createElement('audio');
            element.autoplay = true; element.dataset.omoVoicePeer = 'true'; element.srcObject = stream; element.style.display = 'none';
            document.body.appendChild(element);
            return {
                get volume() { return element.volume; }, set volume(v: number) { element.volume = Math.max(0, Math.min(1, v)); },
                get muted() { return element.muted; }, set muted(v: boolean) { element.muted = v; },
                play: () => element.play().catch(() => undefined),
                remove: () => { element.srcObject = null; element.remove(); }
            };
        },
        createAnalyser: stream => {
            const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
                ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctx) return undefined;
            const ctx = new Ctx();
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser(); analyser.fftSize = 512; source.connect(analyser);
            const data = new Float32Array(analyser.fftSize);
            void ctx.resume().catch(() => undefined);
            return {
                resume: () => { if (ctx.state !== 'running') void ctx.resume().catch(() => undefined); },
                level: () => { analyser.getFloatTimeDomainData(data); let sum = 0; for (const v of data) sum += v * v; return Math.sqrt(sum / data.length); },
                close: () => { source.disconnect(); void ctx.close().catch(() => undefined); }
            };
        }
    };
}

export class RoomVoiceController {
    state: RoomVoiceState = { phase: 'off', mode: 'push', muted: false, transmitting: false, pushHeld: false, speaking: false, level: 0, proximity: true, peers: [], error: '', notice: '' };
    private stream?: MediaStream;
    private analyser?: { level(): number; resume?(): void; close(): void };
    private session = '';
    private peers = new Map<string, Peer>();
    private members: RoomMember[] = [];
    private selfId = '';
    private timer?: unknown;
    private epoch = 0;
    private published?: string;
    private polling = false;
    private republishedAt = 0;
    private loudAt = 0;
    private disposed = false;

    constructor(private options: Options) {}

    private emit(patch: Partial<RoomVoiceState>): void {
        if (this.disposed) return;
        this.state = { ...this.state, ...patch };
        this.options.onChange(this.state);
    }

    /** Call ONLY from a user gesture (a click). Requests the microphone and joins room voice. */
    async enable(): Promise<void> {
        if (this.disposed || this.state.phase === 'starting' || this.state.phase === 'on') return;
        if (!this.selfId) { this.emit({ error: 'Join a shared room first. Voice only reaches people in the same room.' }); return; }
        const epoch = ++this.epoch;
        this.emit({ phase: 'starting', error: '', notice: 'Asking for microphone permission…' });
        let stream: MediaStream;
        try {
            stream = await this.options.media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        } catch (error) {
            if (epoch === this.epoch) this.emit({ phase: 'error', notice: '', error: `Microphone not available: ${error instanceof Error ? error.message : String(error)}` });
            return;
        }
        if (epoch !== this.epoch || this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream;
        this.session = (this.options.random ?? randomSession)();
        try { this.analyser = this.options.media.createAnalyser?.(stream); } catch { this.analyser = undefined; }
        this.applyTrack();
        this.emit({ phase: 'on', notice: this.state.mode === 'push' ? 'Voice on · Hold V to talk.' : 'Voice on · Open mic.' });
        await this.publish(true);
        this.reconcile();
        this.loop(epoch);
    }

    /** Stops the microphone, closes every peer and withdraws voice from the room. */
    async disable(notice = 'Voice off. The microphone is closed.'): Promise<void> {
        ++this.epoch;
        if (this.timer !== undefined) this.options.cancel(this.timer); this.timer = undefined;
        const wasOn = !!this.stream || this.state.phase === 'on';
        for (const peer of [...this.peers.values()]) this.closePeer(peer, true);
        this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
        this.analyser?.close(); this.analyser = undefined;
        this.session = ''; this.published = undefined;
        this.emit({ phase: 'off', transmitting: false, pushHeld: false, speaking: false, level: 0, peers: [], notice: wasOn ? notice : this.state.notice });
        if (wasOn) await this.options.service.setVoice(null).catch(() => undefined);
    }

    setMode(mode: VoiceMode): void { this.analyser?.resume?.(); this.emit({ mode }); this.applyTrack(); }
    setMuted(muted: boolean): void { this.emit({ muted }); this.applyTrack(); }
    toggleMuted(): void { this.setMuted(!this.state.muted); }
    setProximity(proximity: boolean): void { this.emit({ proximity }); this.applyVolumes(); }
    /** Push-to-talk key state. Only meaningful in push mode; never opens the microphone by itself. */
    setPushHeld(held: boolean): void { if (held === this.state.pushHeld) return; if (held) this.analyser?.resume?.(); this.emit({ pushHeld: held }); this.applyTrack(); }

    /** Presence snapshot update (every ~200 ms while joined). Leaving the room turns voice off. */
    roomChanged(snapshot: RoomSnapshot | undefined): void {
        if (!snapshot) {
            this.members = []; this.selfId = '';
            if (this.state.phase === 'on' || this.state.phase === 'starting') void this.disable('Voice off: you left the room.');
            return;
        }
        if (this.selfId && snapshot.selfId !== this.selfId && this.state.phase === 'on') void this.disable('Voice off: room identity changed.');
        this.selfId = snapshot.selfId; this.members = snapshot.members;
        if (this.state.phase !== 'on') return;
        const self = snapshot.members.find(m => m.id === snapshot.selfId);
        // Presence renewal after a paused tab drops server-side voice; publish it again.
        if ((!self?.voice || self.voice.session !== this.session) && Date.now() - this.republishedAt > 1000) { this.republishedAt = Date.now(); this.published = undefined; void this.publish(true); }
        this.reconcile();
    }

    private transmitting(): boolean {
        return this.state.phase === 'on' && !this.state.muted && (this.state.mode === 'open' || this.state.pushHeld);
    }
    private applyTrack(): void {
        const on = this.transmitting();
        this.stream?.getAudioTracks().forEach(track => { track.enabled = on; });
        if (on !== this.state.transmitting) this.emit({ transmitting: on, speaking: on ? this.state.speaking : false });
        void this.publish();
    }
    private async publish(force = false): Promise<void> {
        if (this.state.phase !== 'on' || !this.session) return;
        const status = { session: this.session, muted: this.state.muted, speaking: this.state.speaking };
        const key = JSON.stringify(status);
        if (!force && key === this.published) return;
        this.published = key;
        try { await this.options.service.setVoice(status); } catch (error) { this.published = undefined; this.emit({ error: `Voice status not shared: ${String(error)}` }); }
    }

    private loop(epoch: number): void {
        if (this.disposed || epoch !== this.epoch) return;
        this.timer = this.options.schedule(() => { this.timer = undefined; void this.tick(epoch); }, POLL_MS);
    }
    private async tick(epoch: number): Promise<void> {
        if (this.disposed || epoch !== this.epoch || this.polling) { this.loop(epoch); return; }
        this.polling = true;
        try {
            const level = this.analyser && this.state.transmitting ? this.analyser.level() : 0;
            if (this.state.transmitting && level > SPEAK_THRESHOLD) this.loudAt = Date.now();
            // Hold the indicator briefly so short words do not flicker it off between samples.
            const speaking = this.state.transmitting && Date.now() - this.loudAt < SPEAK_HOLD_MS;
            if (speaking !== this.state.speaking || Math.abs(level - this.state.level) > 0.01) this.emit({ level, speaking });
            void this.publish();
            const signals = await this.options.service.takeSignals();
            if (epoch !== this.epoch) return;
            for (const signal of signals) await this.handle(signal).catch(error => this.emit({ error: `Voice link error: ${String(error)}` }));
            this.applyVolumes();
        } catch (error) {
            if (epoch === this.epoch) this.emit({ error: `Voice signalling paused: ${String(error)}` });
        } finally { this.polling = false; this.loop(epoch); }
    }

    private voicePeers(): RoomMember[] { return this.members.filter(m => m.id !== this.selfId && !!m.voice); }
    private reconcile(): void {
        if (this.state.phase !== 'on') return;
        const wanted = new Map(this.voicePeers().map(m => [m.id, m]));
        for (const peer of [...this.peers.values()]) {
            const member = wanted.get(peer.id);
            const stuck = peer.pc.connectionState !== 'connected' && Date.now() - peer.createdAt > CONNECT_TIMEOUT_MS;
            if (!member || member.voice!.session !== peer.session || peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed' || stuck) this.closePeer(peer, false);
        }
        for (const member of wanted.values()) {
            if (this.peers.has(member.id)) continue;
            // Deterministic glare avoidance: the lower member id makes the offer.
            if (this.selfId < member.id) void this.startOffer(member).catch(error => this.emit({ error: `Voice link error: ${String(error)}` }));
        }
        this.applyVolumes();
    }

    private makePeer(id: string, session: string, offerer: boolean): Peer {
        const pc = this.options.media.createPeer({ iceServers: [] });
        const peer: Peer = { id, session, pc, pendingIce: [], remoteSet: false, offerer, createdAt: Date.now() };
        this.peers.set(id, peer);
        this.stream?.getAudioTracks().forEach(track => pc.addTrack(track, this.stream!));
        pc.onicecandidate = event => {
            if (!event.candidate || this.peers.get(id) !== peer) return;
            void this.send(peer, 'ice', JSON.stringify(event.candidate.toJSON()));
        };
        pc.ontrack = event => {
            if (this.peers.get(id) !== peer || event.track.kind !== 'audio') return;
            peer.audio?.remove();
            peer.audio = this.options.media.createAudio(event.streams[0] ?? new MediaStream([event.track]));
            void peer.audio.play();
            this.applyVolumes();
        };
        pc.onconnectionstatechange = () => { if (this.peers.get(id) === peer) this.applyVolumes(); };
        return peer;
    }
    private async startOffer(member: RoomMember): Promise<void> {
        const peer = this.makePeer(member.id, member.voice!.session, true);
        const offer = await peer.pc.createOffer({ offerToReceiveAudio: true });
        await peer.pc.setLocalDescription(offer);
        if (this.peers.get(member.id) === peer) await this.send(peer, 'offer', offer.sdp ?? '');
    }
    private async send(peer: Peer, kind: 'offer' | 'answer' | 'ice' | 'bye', data: string): Promise<void> {
        if (!this.session) return;
        await this.options.service.signal({ to: peer.id, toSession: peer.session, session: this.session, kind, data });
    }
    private async handle(signal: VoiceSignalEnvelope): Promise<void> {
        const member = this.voicePeers().find(m => m.id === signal.from);
        let peer = this.peers.get(signal.from);
        if (signal.kind === 'bye') { if (peer && peer.session === signal.fromSession) this.closePeer(peer, false); return; }
        if (!member || member.voice!.session !== signal.fromSession) return; // not (or no longer) a trusted voice member of this room
        if (signal.kind === 'offer') {
            if (peer) this.closePeer(peer, false);
            peer = this.makePeer(signal.from, signal.fromSession, false);
            await peer.pc.setRemoteDescription({ type: 'offer', sdp: signal.data });
            peer.remoteSet = true; await this.flushIce(peer);
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            if (this.peers.get(signal.from) === peer) await this.send(peer, 'answer', answer.sdp ?? '');
            return;
        }
        if (!peer || peer.session !== signal.fromSession) return;
        if (signal.kind === 'answer') {
            if (!peer.offerer || peer.remoteSet) return;
            await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.data });
            peer.remoteSet = true; await this.flushIce(peer);
            return;
        }
        let candidate: RTCIceCandidateInit;
        try { candidate = JSON.parse(signal.data); } catch { return; }
        if (!candidate || typeof candidate !== 'object') return;
        if (!peer.remoteSet) { if (peer.pendingIce.length < 64) peer.pendingIce.push(candidate); return; }
        await peer.pc.addIceCandidate(candidate).catch(() => undefined);
    }
    private async flushIce(peer: Peer): Promise<void> {
        const queued = peer.pendingIce.splice(0);
        for (const candidate of queued) await peer.pc.addIceCandidate(candidate).catch(() => undefined);
    }
    private closePeer(peer: Peer, sayBye: boolean): void {
        if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id);
        if (sayBye) void this.send(peer, 'bye', '').catch(() => undefined);
        peer.audio?.remove(); peer.audio = undefined;
        try { peer.pc.close(); } catch { /* already closed */ }
    }

    private applyVolumes(): void {
        const me = this.options.pose();
        const peers: VoicePeerState[] = this.voicePeers().map(member => {
            const peer = this.peers.get(member.id);
            const distance = Math.hypot(member.pose.x - me.x, member.pose.z - me.z);
            const volume = this.state.proximity ? proximityVolume(distance) : 1;
            if (peer?.audio) peer.audio.volume = volume;
            return { id: member.id, name: member.name, connection: peer ? peer.pc.connectionState : 'waiting', speaking: !!member.voice?.speaking, muted: !!member.voice?.muted, volume, distance: Math.round(distance * 10) / 10 };
        });
        const same = peers.length === this.state.peers.length && peers.every((p, i) => JSON.stringify(p) === JSON.stringify(this.state.peers[i]));
        if (!same) this.emit({ peers });
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.disable();
        this.disposed = true;
    }
}

import type { VoiceSignal, VoiceSignalEnvelope, VoiceStatus } from '../common/presence-protocol';
import type { PlayerPose } from '../common/player-state';
import type { VoiceRoster, VoiceRosterMember, VoiceSignalTransport } from '../common/voice-transport';
import { DEFAULT_STUN_URLS, VoiceIceConfig } from '../common/voice-settings-protocol';
import { PeerAudio, VoiceAudioOut, browserVoiceOutput, proximityVolume, relativeAzimuth } from './voice-spatial';
export { PROXIMITY, proximityVolume } from './voice-spatial';

/**
 * Room voice: a WebRTC audio mesh between the voice-enabled members of ONE room.
 *
 * Safety
 * - The microphone is requested only from enable(), which the UI calls from a click.
 * - Audio goes peer to peer to voice members of this room only. STUN (default: public servers)
 *   only learns IP addresses. A TURN relay is used only when the user configures their own.
 * - A transport (local presence or the remote room server) carries only bounded signalling.
 * - Push-to-talk is the default: nothing is sent until the user holds V.
 *
 * Networking
 * - Perfect negotiation per peer: the member with the larger id is "polite" and rolls back on
 *   glare; the other ignores the colliding offer. Any side may (re)negotiate at any time.
 * - ICE restart on 'failed' or a 'disconnected' that lasts; lost offers are re-sent; a link that
 *   stays down is rebuilt (bye + new connection), first by the impolite side, later by either.
 */
export type VoiceMode = 'push' | 'open';
export type VoicePhase = 'off' | 'starting' | 'on' | 'error';
export interface VoicePeerState {
    id: string; name: string;
    /** RTCPeerConnection.connectionState, or 'waiting'. */
    connection: string;
    /** The remote member is speaking / has muted themselves (their published status). */
    speaking: boolean; muted: boolean;
    /** Effective playback gain (distance x personal volume x personal mute). */
    volume: number;
    /** This user's own choice for this person: 0..2 (1 = 100%), and a personal mute. */
    personalVolume: number; personalMuted: boolean;
    distance?: number;
    /** Degrees: 0 ahead, +90 right, -90 left, 180 behind. */
    direction?: number;
    /** Selected ICE path: local/remote candidate types, e.g. 'srflx/srflx' or 'relay/host'. */
    path?: string;
    rttMs?: number;
    restarts: number;
}
export interface VoiceDeviceInfo { id: string; label: string }
export interface VoicePrefs {
    inputId: string; outputId: string;
    echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean;
    mode: VoiceMode; proximity: boolean; spatial: boolean;
    /** Personal per-person volume and mute, by display name (ids change every join). */
    people: Record<string, { volume: number; muted: boolean }>;
}
export interface RoomVoiceState {
    phase: VoicePhase;
    mode: VoiceMode;
    muted: boolean;
    /** True while audio is actually leaving this tab (PTT held or open mic, and not muted). */
    transmitting: boolean;
    pushHeld: boolean;
    speaking: boolean;
    /** Microphone input level 0..~0.5 RMS, measured whenever voice is on (also when not sending). */
    level: number;
    proximity: boolean;
    spatial: boolean;
    spatialSupported: boolean;
    peers: VoicePeerState[];
    prefs: VoicePrefs;
    devices: { inputs: VoiceDeviceInfo[]; outputs: VoiceDeviceInfo[]; outputSelectable: boolean };
    /** Transport kind ('local-presence' | 'remote-room'). */
    transport: string;
    network: { hasTurn: boolean; relayOnly: boolean; stunServers: number };
    error: string;
    notice: string;
}

export interface VoiceAnalyser { level(): number; resume?(): void; close(): void }
export interface VoiceMediaApi {
    getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
    createPeer(config: RTCConfiguration): RTCPeerConnection;
    createOutput(): VoiceAudioOut;
    createAnalyser?(stream: MediaStream): VoiceAnalyser | undefined;
    enumerateDevices?(): Promise<MediaDeviceInfo[]>;
    onDeviceChange?(listener: () => void): () => void;
}
export interface VoiceStorage { get(key: string): string | null; set(key: string, value: string): void }

interface Options {
    transport: VoiceSignalTransport;
    media: VoiceMediaApi;
    pose(): PlayerPose;
    schedule(fn: () => void, ms: number): unknown;
    cancel(handle: unknown): void;
    onChange(state: RoomVoiceState): void;
    /** Backend STUN/TURN config. Missing or failing = default public STUN. */
    iceConfig?(): Promise<VoiceIceConfig>;
    storage?: VoiceStorage;
    random?(): string;
    now?(): number;
}

interface Peer {
    id: string;
    session: string;
    pc: RTCPeerConnection;
    polite: boolean;
    makingOffer: boolean;
    ignoreOffer: boolean;
    settingRemoteAnswer: boolean;
    pendingIce: RTCIceCandidateInit[];
    sender?: RTCRtpSender;
    audio?: PeerAudio;
    createdAt: number;
    healthyAt: number;
    offerSentAt: number;
    offerResends: number;
    disconnectedAt: number;
    restartAt: number;
    restarts: number;
    path?: string;
    rttMs?: number;
}
interface Held { signal: VoiceSignalEnvelope; at: number }

const POLL_MS = 250;
const STATS_MS = 2000;
const SPEAK_THRESHOLD = 0.02;
const SPEAK_HOLD_MS = 900;
const OFFER_RESEND_MS = 4000;
const OFFER_RESEND_MAX = 3;
const DISCONNECT_GRACE_MS = 3000;
const RESTART_GAP_MS = 5000;
const REBUILD_IMPOLITE_MS = 15000;
const REBUILD_POLITE_MS = 30000;
const HOLD_UNKNOWN_MS = 4000;
const HOLD_MAX = 32;
const ICE_REFRESH_EARLY_MS = 30 * 60_000;
const PREFS_KEY = 'omo.voice.prefs.v1';

export const DEFAULT_VOICE_PREFS: VoicePrefs = { inputId: '', outputId: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true, mode: 'push', proximity: true, spatial: true, people: {} };

export function loadVoicePrefs(storage?: VoiceStorage): VoicePrefs {
    try {
        const raw = JSON.parse(storage?.get(PREFS_KEY) ?? 'null') as Partial<VoicePrefs> | null;
        if (!raw || typeof raw !== 'object') return { ...DEFAULT_VOICE_PREFS, people: {} };
        const bool = (v: unknown, d: boolean) => typeof v === 'boolean' ? v : d;
        const str = (v: unknown) => typeof v === 'string' && v.length < 512 ? v : '';
        const people: VoicePrefs['people'] = {};
        if (raw.people && typeof raw.people === 'object') for (const [name, p] of Object.entries(raw.people).slice(0, 200)) {
            if (name.length <= 64 && p && typeof p.volume === 'number' && Number.isFinite(p.volume)) people[name] = { volume: Math.max(0, Math.min(2, p.volume)), muted: !!p.muted };
        }
        return {
            inputId: str(raw.inputId), outputId: str(raw.outputId),
            echoCancellation: bool(raw.echoCancellation, true), noiseSuppression: bool(raw.noiseSuppression, true), autoGainControl: bool(raw.autoGainControl, true),
            mode: raw.mode === 'open' ? 'open' : 'push', proximity: bool(raw.proximity, true), spatial: bool(raw.spatial, true), people
        };
    } catch { return { ...DEFAULT_VOICE_PREFS, people: {} }; }
}

export function micConstraints(prefs: VoicePrefs): MediaStreamConstraints {
    const audio: MediaTrackConstraints = { echoCancellation: prefs.echoCancellation, noiseSuppression: prefs.noiseSuppression, autoGainControl: prefs.autoGainControl, channelCount: 1 };
    if (prefs.inputId) audio.deviceId = { exact: prefs.inputId };
    return { audio, video: false };
}

export function defaultIceConfig(): VoiceIceConfig { return { iceServers: [{ urls: [...DEFAULT_STUN_URLS] }], iceTransportPolicy: 'all', hasTurn: false }; }

function randomSession(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Candidate types of the selected pair, from RTCPeerConnection.getStats(). */
export function selectedPath(stats: RTCStatsReport | Map<string, Record<string, unknown>>): { path?: string; rttMs?: number } {
    const all = new Map<string, Record<string, unknown>>();
    (stats as Map<string, Record<string, unknown>>).forEach((v, k) => all.set(k, v));
    let pair: Record<string, unknown> | undefined;
    for (const s of all.values()) if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = all.get(s.selectedCandidatePairId);
    if (!pair) for (const s of all.values()) if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) { pair = s; break; }
    if (!pair) return {};
    const local = all.get(String(pair.localCandidateId)), remote = all.get(String(pair.remoteCandidateId));
    const rtt = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : undefined;
    const kind = (c?: Record<string, unknown>) => String(c?.candidateType ?? '?');
    return { path: `${kind(local)}/${kind(remote)}`, ...(rtt !== undefined ? { rttMs: rtt } : {}) };
}

export function browserVoiceMedia(): VoiceMediaApi | undefined {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') return undefined;
    return {
        getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
        createPeer: config => new RTCPeerConnection(config),
        createOutput: () => browserVoiceOutput(),
        enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
        onDeviceChange: listener => { navigator.mediaDevices.addEventListener('devicechange', listener); return () => navigator.mediaDevices.removeEventListener('devicechange', listener); },
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
    state: RoomVoiceState;
    private transport: VoiceSignalTransport;
    private stream?: MediaStream;
    private analyser?: VoiceAnalyser;
    private output?: VoiceAudioOut;
    private ice: VoiceIceConfig = defaultIceConfig();
    private session = '';
    private peers = new Map<string, Peer>();
    private held: Held[] = [];
    private members: VoiceRosterMember[] = [];
    private selfId = '';
    private timer?: unknown;
    private epoch = 0;
    private published?: string;
    private polling = false;
    private republishedAt = 0;
    private statsAt = 0;
    private loudAt = 0;
    private offDevices?: () => void;
    private disposed = false;

    constructor(private options: Options) {
        this.transport = options.transport;
        const prefs = loadVoicePrefs(options.storage);
        this.state = { phase: 'off', mode: prefs.mode, muted: false, transmitting: false, pushHeld: false, speaking: false, level: 0, proximity: prefs.proximity, spatial: prefs.spatial, spatialSupported: false,
            peers: [], prefs, devices: { inputs: [], outputs: [], outputSelectable: false }, transport: this.transport.kind,
            network: { hasTurn: false, relayOnly: false, stunServers: DEFAULT_STUN_URLS.length }, error: '', notice: '' };
    }

    private now(): number { return (this.options.now ?? Date.now)(); }
    private emit(patch: Partial<RoomVoiceState>): void {
        if (this.disposed) return;
        this.state = { ...this.state, ...patch };
        this.options.onChange(this.state);
    }
    private savePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
        const prefs = { ...this.state.prefs, ...patch };
        try { this.options.storage?.set(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode: keep in memory */ }
        this.emit({ prefs });
        return prefs;
    }

    get transportKind(): string { return this.transport.kind; }
    /** Switch signalling (local presence <-> remote room). Voice turns off if it was on. */
    async setTransport(transport: VoiceSignalTransport): Promise<void> {
        if (transport === this.transport) return;
        if (this.state.phase === 'on' || this.state.phase === 'starting') await this.disable('Voice off: the room connection changed. Turn it on again.');
        this.transport.dispose?.();
        this.transport = transport; this.members = []; this.selfId = '';
        this.emit({ transport: transport.kind });
    }

    private async loadIce(): Promise<void> {
        let ice = defaultIceConfig();
        if (this.options.iceConfig) {
            try { ice = await this.options.iceConfig(); }
            catch (error) { this.emit({ notice: `Using public STUN only: voice network settings could not be read (${error instanceof Error ? error.message : String(error)}).` }); }
        }
        this.ice = ice;
        const stunServers = ice.iceServers.filter(s => s.urls.some(u => u.startsWith('stun'))).reduce((n, s) => n + s.urls.length, 0);
        this.emit({ network: { hasTurn: ice.hasTurn, relayOnly: ice.iceTransportPolicy === 'relay', stunServers } });
    }
    private rtcConfig(): RTCConfiguration {
        return { iceServers: this.ice.iceServers.map(s => ({ ...s, urls: [...s.urls] })), iceTransportPolicy: this.ice.iceTransportPolicy, bundlePolicy: 'max-bundle' };
    }
    /** Re-read STUN/TURN settings (after Save, or before minted TURN credentials expire) and ICE-restart every link. */
    async reloadNetwork(): Promise<void> {
        await this.loadIce();
        for (const peer of this.peers.values()) { try { peer.pc.setConfiguration(this.rtcConfig()); } catch { /* applied on rebuild */ } this.restartIce(peer, true); }
    }
    /** Network changed (e.g. Wi-Fi switch): restart ICE on every link. */
    restartAll(): void { for (const peer of this.peers.values()) this.restartIce(peer, true); }

    async refreshDevices(): Promise<void> {
        const list = await this.options.media.enumerateDevices?.().catch(() => [] as MediaDeviceInfo[]) ?? [];
        const map = (kind: MediaDeviceKind, fallback: string) => list.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
            .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
        const outputSelectable = typeof (globalThis as { HTMLMediaElement?: { prototype: object } }).HTMLMediaElement !== 'undefined'
            && typeof (HTMLMediaElement.prototype as unknown as { setSinkId?: unknown }).setSinkId === 'function';
        this.emit({ devices: { inputs: map('audioinput', 'Microphone'), outputs: map('audiooutput', 'Speaker'), outputSelectable } });
    }

    /** Call ONLY from a user gesture (a click). Requests the microphone and joins room voice. */
    async enable(): Promise<void> {
        if (this.disposed || this.state.phase === 'starting' || this.state.phase === 'on') return;
        if (!this.selfId) { this.emit({ error: 'Join a shared room first. Voice only reaches people in the same room.' }); return; }
        const epoch = ++this.epoch;
        this.emit({ phase: 'starting', error: '', notice: 'Asking for microphone permission…' });
        let stream: MediaStream;
        try { stream = await this.openMic(this.state.prefs); }
        catch (error) {
            if (epoch === this.epoch) this.emit({ phase: 'error', notice: '', error: `Microphone not available: ${error instanceof Error ? error.message : String(error)}` });
            return;
        }
        if (epoch !== this.epoch || this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream;
        this.session = (this.options.random ?? randomSession)();
        try { this.analyser = this.options.media.createAnalyser?.(stream); } catch { this.analyser = undefined; }
        this.output = this.options.media.createOutput();
        this.output.setSpatial(this.state.spatial);
        if (this.state.prefs.outputId) void this.output.setSink(this.state.prefs.outputId);
        this.offDevices = this.options.media.onDeviceChange?.(() => { void this.refreshDevices(); });
        await this.loadIce();
        if (epoch !== this.epoch || this.disposed) return;
        void this.refreshDevices();
        this.applyTrack();
        this.emit({ phase: 'on', spatialSupported: this.output.spatialSupported, notice: this.state.mode === 'push' ? 'Voice on · Hold V to talk.' : 'Voice on · Open mic.' });
        await this.publish(true);
        this.reconcile();
        this.loop(epoch);
    }

    private async openMic(prefs: VoicePrefs): Promise<MediaStream> {
        try { return await this.options.media.getUserMedia(micConstraints(prefs)); }
        catch (error) {
            // A saved microphone that was unplugged: fall back to the default one.
            if (prefs.inputId && /Overconstrained|NotFound/i.test(String((error as { name?: string })?.name ?? error))) {
                const stream = await this.options.media.getUserMedia(micConstraints({ ...prefs, inputId: '' }));
                this.savePrefs({ inputId: '' });
                return stream;
            }
            throw error;
        }
    }

    /** Stops the microphone, closes every peer and withdraws voice from the room. */
    async disable(notice = 'Voice off. The microphone is closed.'): Promise<void> {
        ++this.epoch;
        if (this.timer !== undefined) this.options.cancel(this.timer); this.timer = undefined;
        const wasOn = !!this.stream || this.state.phase === 'on';
        for (const peer of [...this.peers.values()]) this.closePeer(peer, true);
        this.held = [];
        this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
        this.analyser?.close(); this.analyser = undefined;
        this.output?.close(); this.output = undefined;
        this.offDevices?.(); this.offDevices = undefined;
        this.session = ''; this.published = undefined;
        this.emit({ phase: 'off', transmitting: false, pushHeld: false, speaking: false, level: 0, peers: [], notice: wasOn ? notice : this.state.notice });
        if (wasOn) await this.transport.publish(null).catch(() => undefined);
    }

    setMode(mode: VoiceMode): void { this.analyser?.resume?.(); this.savePrefs({ mode }); this.emit({ mode }); this.applyTrack(); }
    setMuted(muted: boolean): void { this.emit({ muted }); this.applyTrack(); }
    toggleMuted(): void { this.setMuted(!this.state.muted); }
    setProximity(proximity: boolean): void { this.savePrefs({ proximity }); this.emit({ proximity }); this.applyVolumes(); }
    setSpatial(spatial: boolean): void { this.savePrefs({ spatial }); this.output?.setSpatial(spatial); this.emit({ spatial }); this.applyVolumes(); }
    /** Push-to-talk key state. Only meaningful in push mode; never opens the microphone by itself. */
    setPushHeld(held: boolean): void { if (held === this.state.pushHeld) return; if (held) { this.analyser?.resume?.(); this.output?.resume(); } this.emit({ pushHeld: held }); this.applyTrack(); }

    /** This user's own volume (0..2) and mute for one person. Local only; never published. */
    setPersonVolume(memberId: string, volume: number): void {
        const name = this.members.find(m => m.id === memberId)?.name; if (!name) return;
        const prev = this.state.prefs.people[name] ?? { volume: 1, muted: false };
        this.savePrefs({ people: { ...this.state.prefs.people, [name]: { ...prev, volume: Math.max(0, Math.min(2, Number.isFinite(volume) ? volume : 1)) } } });
        this.applyVolumes();
    }
    setPersonMuted(memberId: string, muted: boolean): void {
        const name = this.members.find(m => m.id === memberId)?.name; if (!name) return;
        const prev = this.state.prefs.people[name] ?? { volume: 1, muted: false };
        this.savePrefs({ people: { ...this.state.prefs.people, [name]: { ...prev, muted } } });
        this.applyVolumes();
    }

    /** Choose the microphone and its processing. Re-opens the mic (already permitted) and swaps the track on every link. */
    async setInput(patch: Partial<Pick<VoicePrefs, 'inputId' | 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'>>): Promise<void> {
        const prefs = this.savePrefs(patch);
        if (this.state.phase !== 'on' || !this.stream) return;
        const epoch = this.epoch;
        let next: MediaStream;
        try { next = await this.openMic(prefs); }
        catch (error) { this.emit({ error: `That microphone could not be opened: ${error instanceof Error ? error.message : String(error)}` }); return; }
        if (epoch !== this.epoch || this.state.phase !== 'on') { next.getTracks().forEach(t => t.stop()); return; }
        const old = this.stream; this.stream = next;
        const track = next.getAudioTracks()[0];
        for (const peer of this.peers.values()) {
            if (peer.sender) await peer.sender.replaceTrack(track).catch(() => undefined);
            else if (track) peer.sender = peer.pc.addTrack(track, next);
        }
        old.getTracks().forEach(t => t.stop());
        this.analyser?.close();
        try { this.analyser = this.options.media.createAnalyser?.(next); } catch { this.analyser = undefined; }
        const label = track?.label ? ` · ${track.label}` : '';
        this.emit({ error: '', notice: `Microphone updated${label}.` });
        this.applyTrack(true);
        void this.refreshDevices();
    }
    async setOutput(outputId: string): Promise<void> {
        this.savePrefs({ outputId });
        if (!this.output) return;
        const ok = await this.output.setSink(outputId);
        this.emit(ok ? { error: '', notice: 'Speaker updated.' } : { error: 'This browser cannot choose a speaker. Use the system sound settings.' });
    }

    /** Roster update (presence snapshot, or the remote room's roster). Leaving the room turns voice off. */
    roomChanged(roster: VoiceRoster | undefined): void {
        if (!roster) {
            this.members = []; this.selfId = '';
            if (this.state.phase === 'on' || this.state.phase === 'starting') void this.disable('Voice off: you left the room.');
            return;
        }
        if (this.selfId && roster.selfId !== this.selfId && this.state.phase === 'on') void this.disable('Voice off: room identity changed.');
        this.selfId = roster.selfId; this.members = roster.members;
        if (this.state.phase !== 'on') return;
        const self = roster.members.find(m => m.id === roster.selfId);
        // Presence renewal after a paused tab drops server-side voice; publish it again.
        if ((!self?.voice || self.voice.session !== this.session) && this.now() - this.republishedAt > 1000) { this.republishedAt = this.now(); this.published = undefined; void this.publish(true); }
        this.reconcile();
    }

    private transmitting(): boolean {
        return this.state.phase === 'on' && !this.state.muted && (this.state.mode === 'open' || this.state.pushHeld);
    }
    private applyTrack(force = false): void {
        const on = this.transmitting();
        this.stream?.getAudioTracks().forEach(track => { track.enabled = on; });
        if (force || on !== this.state.transmitting) this.emit({ transmitting: on, speaking: on ? this.state.speaking : false });
        void this.publish();
    }
    private async publish(force = false): Promise<void> {
        if (this.state.phase !== 'on' || !this.session) return;
        const status: VoiceStatus = { session: this.session, muted: this.state.muted, speaking: this.state.speaking };
        const key = JSON.stringify(status);
        if (!force && key === this.published) return;
        this.published = key;
        try { await this.transport.publish(status); } catch (error) { this.published = undefined; this.emit({ error: `Voice status not shared: ${String(error)}` }); }
    }

    private loop(epoch: number): void {
        if (this.disposed || epoch !== this.epoch) return;
        this.timer = this.options.schedule(() => { this.timer = undefined; void this.tick(epoch); }, POLL_MS);
    }
    private async tick(epoch: number): Promise<void> {
        if (this.disposed || epoch !== this.epoch || this.polling) { this.loop(epoch); return; }
        this.polling = true;
        try {
            const roster = this.transport.roster?.();
            if (roster) this.roomChanged(roster);
            if (epoch !== this.epoch) return;
            const level = this.analyser ? this.analyser.level() : 0;
            if (this.state.transmitting && level > SPEAK_THRESHOLD) this.loudAt = this.now();
            // Hold the indicator briefly so short words do not flicker it off between samples.
            const speaking = this.state.transmitting && this.now() - this.loudAt < SPEAK_HOLD_MS;
            if (speaking !== this.state.speaking || Math.abs(level - this.state.level) > 0.004) this.emit({ level, speaking });
            void this.publish();
            if (this.ice.expiresAt && this.now() > this.ice.expiresAt - ICE_REFRESH_EARLY_MS) void this.reloadNetwork();
            const signals = await this.transport.take();
            if (epoch !== this.epoch) return;
            const held = this.held; this.held = [];
            for (const h of held) if (this.now() - h.at < HOLD_UNKNOWN_MS) await this.handle(h.signal, h.at).catch(error => this.emit({ error: `Voice link error: ${String(error)}` }));
            for (const signal of signals) await this.handle(signal).catch(error => this.emit({ error: `Voice link error: ${String(error)}` }));
            this.reconcile();
            if (this.now() - this.statsAt > STATS_MS) { this.statsAt = this.now(); await this.collectStats(); }
        } catch (error) {
            if (epoch === this.epoch) this.emit({ error: `Voice signalling paused: ${String(error)}` });
        } finally { this.polling = false; this.loop(epoch); }
    }

    private voicePeers(): VoiceRosterMember[] { return this.members.filter(m => m.id !== this.selfId && !!m.voice); }

    private reconcile(): void {
        if (this.state.phase !== 'on') return;
        const now = this.now();
        const wanted = new Map(this.voicePeers().map(m => [m.id, m]));
        for (const peer of [...this.peers.values()]) {
            const member = wanted.get(peer.id);
            const pc = peer.pc;
            if (!member || member.voice!.session !== peer.session || pc.connectionState === 'closed') { this.closePeer(peer, false); continue; }
            if (pc.connectionState === 'connected') { peer.healthyAt = now; peer.disconnectedAt = 0; }
            // A link that stays down is rebuilt. The impolite side goes first so both never race.
            if (now - peer.healthyAt > (peer.polite ? REBUILD_POLITE_MS : REBUILD_IMPOLITE_MS)) { this.rebuild(peer, member); continue; }
            if (pc.iceConnectionState === 'failed' || (pc.iceConnectionState === 'disconnected' && peer.disconnectedAt && now - peer.disconnectedAt > DISCONNECT_GRACE_MS)) this.restartIce(peer);
            // An offer that got no answer (lost signal, remote reload): send it again.
            if (pc.signalingState === 'have-local-offer' && peer.offerSentAt && now - peer.offerSentAt > OFFER_RESEND_MS && peer.offerResends < OFFER_RESEND_MAX && pc.localDescription?.type === 'offer') {
                peer.offerResends++; peer.offerSentAt = now;
                void this.send(peer, 'offer', pc.localDescription.sdp).catch(() => undefined);
            }
        }
        for (const member of wanted.values()) if (!this.peers.has(member.id)) this.makePeer(member);
        this.applyVolumes();
    }

    private rebuild(peer: Peer, member: VoiceRosterMember): void {
        const restarts = peer.restarts + 1;
        this.closePeer(peer, true);
        this.makePeer(member).restarts = restarts;
    }
    private restartIce(peer: Peer, force = false): void {
        const now = this.now();
        if (!force && now - peer.restartAt < RESTART_GAP_MS) return;
        if (peer.pc.connectionState === 'closed') return;
        peer.restartAt = now; peer.restarts++;
        // Fires negotiationneeded with an ICE-restart offer; glare is handled like any other offer.
        try { peer.pc.restartIce(); } catch { /* old browser: the rebuild path recovers */ }
    }

    private makePeer(member: VoiceRosterMember): Peer {
        const pc = this.options.media.createPeer(this.rtcConfig());
        const now = this.now();
        const peer: Peer = { id: member.id, session: member.voice!.session, pc, polite: this.selfId > member.id, makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false,
            pendingIce: [], createdAt: now, healthyAt: now, offerSentAt: 0, offerResends: 0, disconnectedAt: 0, restartAt: 0, restarts: 0 };
        this.peers.set(member.id, peer);
        const live = () => this.peers.get(member.id) === peer;
        pc.onnegotiationneeded = async () => {
            if (!live() || pc.signalingState !== 'stable') return;
            try {
                peer.makingOffer = true;
                await pc.setLocalDescription();
                if (live() && pc.localDescription?.type === 'offer') {
                    peer.offerSentAt = this.now(); peer.offerResends = 0;
                    await this.send(peer, 'offer', pc.localDescription.sdp);
                }
            } catch (error) { if (live()) this.emit({ error: `Voice link error: ${String(error)}` }); }
            finally { peer.makingOffer = false; }
        };
        pc.onicecandidate = event => {
            if (!event.candidate || !live()) return;
            void this.send(peer, 'ice', JSON.stringify(event.candidate.toJSON())).catch(() => undefined);
        };
        pc.oniceconnectionstatechange = () => {
            if (!live()) return;
            if (pc.iceConnectionState === 'disconnected') peer.disconnectedAt = peer.disconnectedAt || this.now();
            else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') peer.disconnectedAt = 0;
            if (pc.iceConnectionState === 'failed') this.restartIce(peer);
        };
        pc.ontrack = event => {
            if (!live() || event.track.kind !== 'audio' || !this.output) return;
            peer.audio?.remove();
            peer.audio = this.output.addPeer(event.streams[0] ?? new MediaStream([event.track]));
            this.applyVolumes();
        };
        pc.onconnectionstatechange = () => { if (!live()) return; if (pc.connectionState === 'connected') { peer.healthyAt = this.now(); peer.offerResends = 0; } this.applyVolumes(); };
        const track = this.stream?.getAudioTracks()[0];
        if (track) peer.sender = pc.addTrack(track, this.stream!);
        else pc.addTransceiver('audio', { direction: 'recvonly' });
        return peer;
    }

    private async send(peer: Peer, kind: VoiceSignal['kind'], data: string): Promise<void> {
        if (!this.session) return;
        await this.transport.send({ to: peer.id, toSession: peer.session, session: this.session, kind, data });
    }

    private async handle(signal: VoiceSignalEnvelope, heldAt?: number): Promise<void> {
        let peer = this.peers.get(signal.from);
        if (signal.kind === 'bye') {
            this.held = this.held.filter(h => h.signal.from !== signal.from);
            if (peer && peer.session === signal.fromSession) {
                // The other side rebuilt the link (or left voice). Start clean; reconcile drops it if they left.
                const restarts = peer.restarts; this.closePeer(peer, false);
                const m = this.voicePeers().find(x => x.id === signal.from);
                if (m && m.voice!.session === signal.fromSession) this.makePeer(m).restarts = restarts;
            }
            return;
        }
        const member = this.voicePeers().find(m => m.id === signal.from);
        if (!member || member.voice!.session !== signal.fromSession) {
            // Our roster can lag the sender's by a poll or two: hold briefly instead of dropping.
            if (this.held.length < HOLD_MAX) this.held.push({ signal, at: heldAt ?? this.now() });
            return;
        }
        if (peer && peer.session !== signal.fromSession) { this.closePeer(peer, false); peer = undefined; }
        if (!peer) peer = this.makePeer(member);
        const pc = peer.pc;
        if (signal.kind === 'offer' || signal.kind === 'answer') {
            // Perfect negotiation (W3C WebRTC 1.0, "Perfect negotiation example").
            const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingRemoteAnswer);
            const collision = signal.kind === 'offer' && !readyForOffer;
            peer.ignoreOffer = !peer.polite && collision;
            if (peer.ignoreOffer) return;
            if (signal.kind === 'answer' && pc.signalingState !== 'have-local-offer') return; // stale or duplicate answer
            peer.settingRemoteAnswer = signal.kind === 'answer';
            try { await pc.setRemoteDescription({ type: signal.kind, sdp: signal.data }); }
            finally { peer.settingRemoteAnswer = false; }
            await this.flushIce(peer);
            if (signal.kind === 'offer') {
                await pc.setLocalDescription();
                if (this.peers.get(peer.id) === peer && pc.localDescription?.type === 'answer') await this.send(peer, 'answer', pc.localDescription.sdp);
            } else { peer.offerSentAt = 0; peer.offerResends = 0; }
            return;
        }
        let candidate: RTCIceCandidateInit;
        try { candidate = JSON.parse(signal.data); } catch { return; }
        if (!candidate || typeof candidate !== 'object' || typeof candidate.candidate !== 'string') return;
        if (!pc.remoteDescription) { if (peer.pendingIce.length < 64) peer.pendingIce.push(candidate); return; }
        // A candidate of an older ICE generation, or for an ignored offer, fails harmlessly.
        await pc.addIceCandidate(candidate).catch(() => undefined);
    }
    private async flushIce(peer: Peer): Promise<void> {
        const queued = peer.pendingIce.splice(0);
        for (const candidate of queued) await peer.pc.addIceCandidate(candidate).catch(() => undefined);
    }
    private closePeer(peer: Peer, sayBye: boolean): void {
        if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id);
        if (sayBye) void this.send(peer, 'bye', '').catch(() => undefined);
        peer.audio?.remove(); peer.audio = undefined;
        peer.pc.onnegotiationneeded = null; peer.pc.onicecandidate = null; peer.pc.ontrack = null; peer.pc.onconnectionstatechange = null; peer.pc.oniceconnectionstatechange = null;
        try { peer.pc.close(); } catch { /* already closed */ }
    }

    private async collectStats(): Promise<void> {
        for (const peer of [...this.peers.values()]) {
            if (peer.pc.connectionState !== 'connected') { peer.path = undefined; peer.rttMs = undefined; continue; }
            try { const s = selectedPath(await peer.pc.getStats()); peer.path = s.path; peer.rttMs = s.rttMs; } catch { /* closed meanwhile */ }
        }
        this.applyVolumes();
    }

    private applyVolumes(): void {
        const me = this.options.pose();
        this.output?.setListener(me);
        const peers: VoicePeerState[] = this.voicePeers().map(member => {
            const peer = this.peers.get(member.id);
            const distance = Math.hypot(member.pose.x - me.x, member.pose.z - me.z);
            const personal = this.state.prefs.people[member.name] ?? { volume: 1, muted: false };
            const volume = Math.round((personal.muted ? 0 : (this.state.proximity ? proximityVolume(distance) : 1) * personal.volume) * 100) / 100;
            if (peer?.audio) { peer.audio.setGain(volume); peer.audio.setPose(member.pose); }
            const state: VoicePeerState = { id: member.id, name: member.name, connection: peer ? peer.pc.connectionState : 'waiting', speaking: !!member.voice?.speaking, muted: !!member.voice?.muted,
                volume, personalVolume: personal.volume, personalMuted: personal.muted, distance: Math.round(distance * 10) / 10,
                direction: Math.round(relativeAzimuth(me, member.pose) * 180 / Math.PI), restarts: peer?.restarts ?? 0 };
            if (peer?.path) state.path = peer.path;
            if (peer?.rttMs !== undefined) state.rttMs = peer.rttMs;
            return state;
        });
        const same = peers.length === this.state.peers.length && peers.every((p, i) => JSON.stringify(p) === JSON.stringify(this.state.peers[i]));
        if (!same) this.emit({ peers });
    }

    /** Diagnostics for tests and the voice check panel. */
    debugPeers(): Array<{ id: string; polite: boolean; signaling: string; connection: string; ice: string; restarts: number }> {
        return [...this.peers.values()].map(p => ({ id: p.id, polite: p.polite, signaling: p.pc.signalingState, connection: p.pc.connectionState, ice: p.pc.iceConnectionState, restarts: p.restarts }));
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.disable();
        this.transport.dispose?.();
        this.disposed = true;
    }
}

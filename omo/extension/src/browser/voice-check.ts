import type { VoiceIceConfig } from '../common/voice-settings-protocol';
import { micConstraints, selectedPath, VoicePrefs } from './voice-controller';

/**
 * Voice check (w2 voice lane). Every test starts from a click and stays on this computer:
 * - ICE gather: asks the configured STUN/TURN servers for addresses (no audio, no peer).
 * - Loopback: microphone -> WebRTC (two connections inside this tab, using the configured servers)
 *   -> your speakers. Proves capture, encode, ICE and playback without anyone else.
 * - Record and play: records 3 s of microphone locally, then plays it back. Nothing is uploaded.
 */
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export interface IceGatherResult {
    counts: Record<CandidateType, number>;
    /** Candidate summaries without full IP addresses (type, protocol, server url when known). */
    candidates: Array<{ type: CandidateType; protocol: string; url?: string; address: string }>;
    errors: string[];
    ms: number;
    complete: boolean;
}

/** Hides most of an address: 192.168.1.20 -> 192.168.x.x, v6 -> first two groups, mDNS name kept short. */
export function maskAddress(address: string | null | undefined): string {
    if (!address) return '?';
    if (/\.local$/i.test(address)) return 'mDNS (hidden)';
    const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address);
    if (v4) return `${v4[1]}.${v4[2]}.x.x`;
    if (address.includes(':')) return `${address.split(':').slice(0, 2).join(':')}:…`;
    return '?';
}

/** Parses an SDP-style candidate line (fallback when RTCIceCandidate fields are missing). */
export function candidateFields(line: string): { type?: CandidateType; protocol?: string; address?: string } {
    const m = /candidate:\S+ \d+ (\S+) \d+ (\S+) \d+ typ (\S+)/.exec(line);
    if (!m) return {};
    return { protocol: m[1].toLowerCase(), address: m[2], type: m[3] as CandidateType };
}

export function emptyCounts(): Record<CandidateType, number> { return { host: 0, srflx: 0, prflx: 0, relay: 0 }; }

/** Plain-language verdict for the counts. */
export function iceVerdict(r: Pick<IceGatherResult, 'counts' | 'errors'>, config: Pick<VoiceIceConfig, 'hasTurn' | 'iceTransportPolicy'>): string {
    const { host, srflx, relay } = r.counts;
    if (config.hasTurn && relay) return 'TURN relay works. Voice can connect through strict NATs and firewalls.';
    if (config.hasTurn && !relay) return 'TURN relay did not answer. Check the TURN address, port, firewall and credentials.';
    if (srflx) return 'STUN works. Voice connects across most home networks. Add a TURN server for strict company or mobile networks.';
    if (host) return 'Only local addresses found. Voice works on this network only. STUN may be blocked.';
    return r.errors.length ? 'No addresses found. The network blocks WebRTC.' : 'No addresses found.';
}

export async function gatherIce(config: VoiceIceConfig, createPeer: (c: RTCConfiguration) => RTCPeerConnection = c => new RTCPeerConnection(c), timeoutMs = 6000): Promise<IceGatherResult> {
    const started = Date.now();
    const pc = createPeer({ iceServers: config.iceServers.map(s => ({ ...s, urls: [...s.urls] })), iceTransportPolicy: config.iceTransportPolicy, iceCandidatePoolSize: 0 });
    const result: IceGatherResult = { counts: emptyCounts(), candidates: [], errors: [], ms: 0, complete: false };
    try {
        await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, timeoutMs);
            pc.onicecandidate = event => {
                if (!event.candidate) { result.complete = true; clearTimeout(timer); resolve(); return; }
                const c = event.candidate, parsed = candidateFields(c.candidate);
                const type = (c.type ?? parsed.type) as CandidateType | undefined;
                if (!type || !(type in result.counts)) return;
                result.counts[type]++;
                const url = (c as unknown as { url?: string }).url;
                if (result.candidates.length < 24) result.candidates.push({ type, protocol: c.protocol ?? parsed.protocol ?? '?', address: maskAddress(c.address ?? parsed.address), ...(url ? { url } : {}) });
            };
            pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { result.complete = true; clearTimeout(timer); resolve(); } };
            (pc as unknown as { onicecandidateerror: ((e: { url?: string; errorCode?: number; errorText?: string }) => void) | null }).onicecandidateerror = e => {
                if (result.errors.length < 8) result.errors.push(`${e.url ?? 'server'}: ${e.errorCode ?? ''} ${e.errorText ?? ''}`.trim());
            };
            pc.addTransceiver('audio', { direction: 'recvonly' });
            void pc.createOffer().then(o => pc.setLocalDescription(o)).catch(error => { result.errors.push(String(error)); clearTimeout(timer); resolve(); });
        });
    } finally { pc.close(); }
    result.ms = Date.now() - started;
    return result;
}

export interface LoopbackHandle {
    /** Selected candidate pair types, e.g. 'host/host' or 'relay/relay', once connected. */
    path(): Promise<string | undefined>;
    level(): number;
    stop(): void;
}

/**
 * Microphone -> RTCPeerConnection A -> B -> speakers, inside this tab. With "relay only" set,
 * the audio goes out to YOUR TURN server and back, which proves the relay end to end.
 */
export async function startLoopback(config: VoiceIceConfig, prefs: VoicePrefs, outputId: string, onState: (text: string) => void): Promise<LoopbackHandle> {
    const stream = await navigator.mediaDevices.getUserMedia(micConstraints(prefs));
    const rtc: RTCConfiguration = { iceServers: config.iceServers.map(s => ({ ...s, urls: [...s.urls] })), iceTransportPolicy: config.iceTransportPolicy };
    const a = new RTCPeerConnection(rtc), b = new RTCPeerConnection(rtc);
    const audio = document.createElement('audio');
    audio.autoplay = true; audio.style.display = 'none'; audio.dataset.omoVoiceLoopback = 'true';
    document.body.appendChild(audio);
    const setSink = (audio as unknown as { setSinkId?(id: string): Promise<void> }).setSinkId;
    if (outputId && setSink) void setSink.call(audio, outputId).catch(() => undefined);
    a.onicecandidate = e => { if (e.candidate) void b.addIceCandidate(e.candidate).catch(() => undefined); };
    b.onicecandidate = e => { if (e.candidate) void a.addIceCandidate(e.candidate).catch(() => undefined); };
    b.ontrack = e => { audio.srcObject = e.streams[0] ?? new MediaStream([e.track]); void audio.play().catch(() => undefined); };
    a.onconnectionstatechange = () => onState(a.connectionState);
    stream.getAudioTracks().forEach(t => a.addTrack(t, stream));
    let analyserLevel = () => 0, closeAnalyser = () => undefined as void;
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (Ctx) {
        const ctx = new Ctx(); const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
        const data = new Float32Array(an.fftSize); void ctx.resume().catch(() => undefined);
        analyserLevel = () => { an.getFloatTimeDomainData(data); let s = 0; for (const v of data) s += v * v; return Math.sqrt(s / data.length); };
        closeAnalyser = () => { void ctx.close().catch(() => undefined); };
    }
    const offer = await a.createOffer(); await a.setLocalDescription(offer); await b.setRemoteDescription(offer);
    const answer = await b.createAnswer(); await b.setLocalDescription(answer); await a.setRemoteDescription(answer);
    let stopped = false;
    return {
        path: async () => { if (stopped) return undefined; try { return selectedPath(await a.getStats()).path; } catch { return undefined; } },
        level: () => stopped ? 0 : analyserLevel(),
        stop: () => {
            if (stopped) return; stopped = true;
            stream.getTracks().forEach(t => t.stop()); a.close(); b.close(); closeAnalyser();
            audio.srcObject = null; audio.remove();
        }
    };
}

/** Records `ms` of microphone audio in memory and returns a playable object URL (caller revokes it). */
export async function recordClip(prefs: VoicePrefs, ms = 3000, onLevel?: (level: number) => void): Promise<{ url: string; bytes: number; mime: string }> {
    if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record audio.');
    const stream = await navigator.mediaDevices.getUserMedia(micConstraints(prefs));
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) ?? '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    let ctx: AudioContext | undefined, timer: number | undefined;
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (onLevel && Ctx) {
        ctx = new Ctx(); const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
        const data = new Float32Array(an.fftSize); void ctx.resume().catch(() => undefined);
        timer = window.setInterval(() => { an.getFloatTimeDomainData(data); let s = 0; for (const v of data) s += v * v; onLevel(Math.sqrt(s / data.length)); }, 100);
    }
    try {
        await new Promise<void>((resolve, reject) => {
            recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
            recorder.onstop = () => resolve();
            recorder.onerror = e => reject(new Error(String((e as unknown as { error?: unknown }).error ?? 'recording failed')));
            recorder.start(250);
            window.setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, ms);
        });
    } finally {
        stream.getTracks().forEach(t => t.stop());
        if (timer !== undefined) window.clearInterval(timer);
        void ctx?.close().catch(() => undefined);
        onLevel?.(0);
    }
    const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
    return { url: URL.createObjectURL(blob), bytes: blob.size, mime: blob.type };
}

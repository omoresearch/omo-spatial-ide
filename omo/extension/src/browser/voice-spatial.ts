import type { PlayerPose } from '../common/player-state';

/**
 * Spatial room voice (w2 voice lane): every remote voice goes
 *   MediaStreamSource -> per-person gain (distance x personal volume x mute) -> PannerNode (HRTF) -> master -> speakers.
 * The panner only places the voice (direction + facing cone); loudness by distance is the gain,
 * using `proximityVolume`, so a room is never fully silent. Positions are room metres
 * (x right, y up, z towards the door); a pose with yaw 0 faces -z.
 */
export const EAR_HEIGHT = 1.6;
/** Full volume within NEAR metres, fading linearly to FLOOR at FAR metres. A room is small; never fully silent. */
export const PROXIMITY = { near: 2.5, far: 10, floor: 0.12 };
/** A voice facing away is quieter (but never silent): cone in degrees and the outside gain. */
export const VOICE_CONE = { inner: 180, outer: 330, outerGain: 0.55 };

export function proximityVolume(distance: number): number {
    if (!Number.isFinite(distance) || distance <= PROXIMITY.near) return 1;
    if (distance >= PROXIMITY.far) return PROXIMITY.floor;
    const t = (distance - PROXIMITY.near) / (PROXIMITY.far - PROXIMITY.near);
    return Math.round((1 - t * (1 - PROXIMITY.floor)) * 100) / 100;
}

export interface Vec3 { x: number; y: number; z: number }
/** Unit vector a pose is facing (yaw 0 = -z, yaw +pi/2 = -x). Pitch is ignored for voices. */
export function facing(yaw: number): Vec3 {
    const x = -Math.sin(yaw), z = -Math.cos(yaw);
    return { x: Math.abs(x) < 1e-12 ? 0 : x, y: 0, z: Math.abs(z) < 1e-12 ? 0 : z };
}
export function earPosition(pose: Pick<PlayerPose, 'x' | 'z'>): Vec3 { return { x: pose.x, y: EAR_HEIGHT, z: pose.z }; }

/**
 * Where a voice is relative to the listener: azimuth in radians (0 = straight ahead,
 * +pi/2 = to the right, +-pi = behind). For tests and the panel's "left/right" hint.
 */
export function relativeAzimuth(listener: PlayerPose, source: Pick<PlayerPose, 'x' | 'z'>): number {
    const f = facing(listener.yaw), dx = source.x - listener.x, dz = source.z - listener.z;
    const right = { x: -f.z, z: f.x }; // facing rotated -90 degrees around y
    return Math.atan2(dx * right.x + dz * right.z, dx * f.x + dz * f.z);
}

export interface PeerAudio {
    /** Linear gain (0 = silent). */
    setGain(gain: number): void;
    /** Speaker pose (their head position and facing). */
    setPose(pose: PlayerPose): void;
    remove(): void;
}
export interface VoiceAudioOut {
    readonly spatialSupported: boolean;
    addPeer(stream: MediaStream): PeerAudio;
    setListener(pose: PlayerPose): void;
    setSpatial(on: boolean): void;
    /** '' = system default output. Resolves false when the browser cannot choose an output. */
    setSink(deviceId: string): Promise<boolean>;
    resume(): void;
    close(): void;
}

type AudioCtxCtor = typeof AudioContext;
function audioContextCtor(): AudioCtxCtor | undefined {
    if (typeof window === 'undefined') return undefined;
    const w = window as unknown as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor };
    return w.AudioContext ?? w.webkitAudioContext;
}

function setParam(param: AudioParam | undefined, value: number, ctx: BaseAudioContext): void {
    if (!param) return;
    // Short glide so walking does not click or zipper.
    try { param.setTargetAtTime(value, ctx.currentTime, 0.06); } catch { param.value = value; }
}

/** Fallback output (no WebAudio): plain hidden <audio> elements, volume only. */
function elementOutput(): VoiceAudioOut {
    const elements = new Set<HTMLAudioElement>();
    let sink = '';
    const applySink = (el: HTMLAudioElement) => { const s = (el as unknown as { setSinkId?(id: string): Promise<void> }).setSinkId; if (s) void s.call(el, sink).catch(() => undefined); };
    return {
        spatialSupported: false,
        addPeer: stream => {
            const el = document.createElement('audio');
            el.autoplay = true; el.dataset.omoVoicePeer = 'true'; el.srcObject = stream; el.style.display = 'none';
            document.body.appendChild(el); elements.add(el); applySink(el);
            void el.play().catch(() => undefined);
            return { setGain: g => { el.volume = Math.max(0, Math.min(1, g)); }, setPose: () => undefined, remove: () => { elements.delete(el); el.srcObject = null; el.remove(); } };
        },
        setListener: () => undefined,
        setSpatial: () => undefined,
        setSink: async id => { sink = id; const ok = typeof (HTMLMediaElement.prototype as unknown as { setSinkId?: unknown }).setSinkId === 'function'; elements.forEach(applySink); return ok; },
        resume: () => undefined,
        close: () => { elements.forEach(el => { el.srcObject = null; el.remove(); }); elements.clear(); }
    };
}

/** Web Audio spatial output. Falls back to plain elements when Web Audio is missing. */
export function browserVoiceOutput(): VoiceAudioOut {
    const Ctor = audioContextCtor();
    if (!Ctor) return elementOutput();
    const ctx = new Ctor({ latencyHint: 'interactive' });
    const master = ctx.createGain();
    master.connect(ctx.destination);
    let spatial = true;
    let sinkElement: HTMLAudioElement | undefined;
    let sinkDest: MediaStreamAudioDestinationNode | undefined;
    const peers = new Set<{ gain: GainNode; panner: PannerNode; reconnect(): void }>();
    const listener = ctx.listener;

    return {
        spatialSupported: true,
        addPeer: stream => {
            // Chrome only feeds a remote WebRTC stream into Web Audio while a media element plays it.
            const holder = document.createElement('audio');
            holder.muted = true; holder.srcObject = stream; holder.dataset.omoVoicePeer = 'true'; holder.style.display = 'none';
            document.body.appendChild(holder); void holder.play().catch(() => undefined);
            const source = ctx.createMediaStreamSource(stream);
            const gain = ctx.createGain();
            const panner = ctx.createPanner();
            panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 1; panner.rolloffFactor = 0; // gain does distance
            panner.coneInnerAngle = VOICE_CONE.inner; panner.coneOuterAngle = VOICE_CONE.outer; panner.coneOuterGain = VOICE_CONE.outerGain;
            source.connect(gain);
            const entry = { gain, panner, reconnect: () => {
                try { gain.disconnect(); } catch { /* not connected */ }
                if (spatial) { gain.connect(panner); panner.connect(master); } else { try { panner.disconnect(); } catch { /* idle */ } gain.connect(master); }
            } };
            entry.reconnect(); peers.add(entry);
            void ctx.resume().catch(() => undefined);
            return {
                setGain: g => setParam(gain.gain, Math.max(0, Math.min(4, g)), ctx),
                setPose: pose => {
                    const p = earPosition(pose), f = facing(pose.yaw);
                    if (panner.positionX) { setParam(panner.positionX, p.x, ctx); setParam(panner.positionY, p.y, ctx); setParam(panner.positionZ, p.z, ctx); setParam(panner.orientationX, f.x, ctx); setParam(panner.orientationY, f.y, ctx); setParam(panner.orientationZ, f.z, ctx); }
                    else { panner.setPosition(p.x, p.y, p.z); panner.setOrientation(f.x, f.y, f.z); }
                },
                remove: () => { peers.delete(entry); try { source.disconnect(); gain.disconnect(); panner.disconnect(); } catch { /* gone */ } holder.srcObject = null; holder.remove(); }
            };
        },
        setListener: pose => {
            const p = earPosition(pose), f = facing(pose.yaw);
            if (listener.positionX) {
                setParam(listener.positionX, p.x, ctx); setParam(listener.positionY, p.y, ctx); setParam(listener.positionZ, p.z, ctx);
                setParam(listener.forwardX, f.x, ctx); setParam(listener.forwardY, f.y, ctx); setParam(listener.forwardZ, f.z, ctx);
                setParam(listener.upX, 0, ctx); setParam(listener.upY, 1, ctx); setParam(listener.upZ, 0, ctx);
            } else { listener.setPosition(p.x, p.y, p.z); listener.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
        },
        setSpatial: on => { if (on === spatial) return; spatial = on; peers.forEach(p => p.reconnect()); },
        setSink: async id => {
            const c = ctx as unknown as { setSinkId?(id: string): Promise<void> };
            if (typeof c.setSinkId === 'function') { try { await c.setSinkId(id); return true; } catch { return false; } }
            // Older Chrome: route the mix through one element that can pick an output.
            if (typeof (HTMLMediaElement.prototype as unknown as { setSinkId?: unknown }).setSinkId !== 'function') return false;
            if (!sinkElement) {
                sinkDest = ctx.createMediaStreamDestination();
                master.disconnect(); master.connect(sinkDest);
                sinkElement = document.createElement('audio'); sinkElement.autoplay = true; sinkElement.srcObject = sinkDest.stream; sinkElement.style.display = 'none';
                document.body.appendChild(sinkElement); void sinkElement.play().catch(() => undefined);
            }
            try { await (sinkElement as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(id); return true; } catch { return false; }
        },
        resume: () => { if (ctx.state !== 'running') void ctx.resume().catch(() => undefined); },
        close: () => {
            peers.clear();
            if (sinkElement) { sinkElement.srcObject = null; sinkElement.remove(); }
            void ctx.close().catch(() => undefined);
        }
    };
}

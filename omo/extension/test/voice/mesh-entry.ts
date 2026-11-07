/* Browser entry for the voice mesh harness: the REAL voice modules, bundled by esbuild. */
import { RoomVoiceController, browserVoiceMedia } from '../../src/browser/voice-controller';
import { remoteRoomVoiceTransport, VoiceWireIn, VoiceWireOut } from '../../src/common/voice-transport';
import { gatherIce, startLoopback, recordClip } from '../../src/browser/voice-check';
import type { VoiceIceConfig } from '../../src/common/voice-settings-protocol';

declare global { interface Window { __relaySend(json: string): Promise<void>; __relayDeliver(json: string): void; __voice: unknown; __pose: { x: number; z: number; yaw: number; pitch: number } } }

const listeners = new Set<(m: VoiceWireIn) => void>();
window.__relayDeliver = json => { const m = JSON.parse(json) as VoiceWireIn; listeners.forEach(l => l(m)); };
const channel = { send: (m: VoiceWireOut) => window.__relaySend(JSON.stringify(m)), onMessage: (l: (m: VoiceWireIn) => void) => { listeners.add(l); return () => listeners.delete(l); } };
window.__pose = { x: 0, z: 0, yaw: 0, pitch: 0 };
const mem = new Map<string, string>();
let ice: VoiceIceConfig | undefined;
const states: string[] = [];
const controller = new RoomVoiceController({
    transport: remoteRoomVoiceTransport(channel), media: browserVoiceMedia()!, pose: () => window.__pose,
    storage: { get: k => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v); } },
    iceConfig: async () => ice ?? { iceServers: [], iceTransportPolicy: 'all', hasTurn: false },
    schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: h => window.clearTimeout(h as number),
    onChange: s => { if (s.error) states.push(s.error); }
});
window.setInterval(() => controller.pullRoster(), 200);
window.__voice = { controller, setIce: (c: VoiceIceConfig) => { ice = c; }, errors: states, gatherIce, startLoopback, recordClip };

import * as fs from 'fs';
import * as path from 'path';
import { createHmac } from 'crypto';
import {
    DEFAULT_VOICE_NETWORK, OmoVoiceSettingsService, VOICE_SETTINGS_FILE, VoiceIceConfig, VoiceNetworkStored, VoiceNetworkUpdate, VoiceNetworkView,
    voiceIceConfig, voiceNetworkMerge, voiceNetworkParse, voiceNetworkView
} from '../common/voice-settings-protocol';

export function turnRestHmac(secret: string, message: string): string {
    return createHmac('sha1', secret).update(message).digest('base64');
}

/**
 * Voice STUN/TURN settings in the Theia config dir (w2 voice lane).
 * The file is private to this user (0600 in a 0700 dir) and never leaves the machine except as
 * the browser's own RTCIceServer list. TURN shared secrets never leave the backend.
 */
export class VoiceSettingsStore implements OmoVoiceSettingsService {
    private cache?: VoiceNetworkStored;
    private writing: Promise<unknown> = Promise.resolve();

    constructor(private readonly configDir: () => Promise<string>, private readonly now: () => number = Date.now) {}

    private async file(): Promise<string> {
        const dir = await this.configDir();
        if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Voice settings need an absolute config directory.');
        return path.join(dir, VOICE_SETTINGS_FILE);
    }

    private async load(): Promise<VoiceNetworkStored> {
        if (this.cache) return this.cache;
        const file = await this.file();
        let raw: unknown;
        try { raw = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { raw = undefined; }
        this.cache = raw === undefined ? { ...DEFAULT_VOICE_NETWORK } : voiceNetworkParse(raw);
        return this.cache;
    }

    async get(): Promise<VoiceNetworkView> {
        return voiceNetworkView(await this.load(), await this.file());
    }

    async save(update: VoiceNetworkUpdate): Promise<VoiceNetworkView> {
        const task = this.writing.then(async () => {
            const previous = await this.load();
            const next = voiceNetworkMerge(update, previous);
            const file = await this.file();
            await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
            await fs.promises.writeFile(temp, JSON.stringify(next, undefined, 2) + '\n', { mode: 0o600 });
            await fs.promises.rename(temp, file);
            await fs.promises.chmod(file, 0o600).catch(() => undefined);
            this.cache = next;
            return voiceNetworkView(next, file);
        });
        this.writing = task.catch(() => undefined);
        return task;
    }

    async iceConfig(): Promise<VoiceIceConfig> {
        return voiceIceConfig(await this.load(), this.now(), turnRestHmac);
    }
}

/**
 * Talk to an agent: hold-to-dictate into an agent terminal's input as a DRAFT.
 *
 * Safety contract:
 * - The microphone opens only after the user turned dictation on with a click, and then only
 *   while the dictation key is held (a user gesture each time). The browser asks for permission.
 * - Speech is recognised ON THE DEVICE only (Web Speech API `processLocally`). If the browser
 *   cannot recognise on-device, dictation stays unavailable. Audio is never sent to a cloud
 *   speech service, and never to room peers.
 * - The transcript is pasted as one line with semantic paste. Enter is never sent; the user
 *   reviews the draft and presses Enter themselves.
 */

export type DictationAvailability = 'checking' | 'available' | 'downloadable' | 'downloading' | 'unsupported';
export type DictationPhase = 'off' | 'ready' | 'listening' | 'finishing' | 'error';
export interface DictationState {
    availability: DictationAvailability;
    phase: DictationPhase;
    lang: string;
    interim: string;
    targetLabel: string;
    lastDraft: string;
    error: string;
    notice: string;
}

interface RecognitionEventLike { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }
interface RecognitionLike {
    lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number; processLocally?: boolean;
    onresult: ((event: RecognitionEventLike) => void) | null;
    onerror: ((event: { error: string; message?: string }) => void) | null;
    onend: (() => void) | null;
    start(): void; stop(): void; abort(): void;
}
interface RecognitionCtor {
    new(): RecognitionLike;
    available?(options: { langs: string[]; processLocally: boolean }): Promise<string>;
    install?(options: { langs: string[]; processLocally: boolean }): Promise<boolean>;
    availableOnDevice?(lang: string): Promise<string>;
    installOnDevice?(lang: string): Promise<boolean>;
}

export function recognitionCtor(scope: unknown = typeof window === 'undefined' ? undefined : window): RecognitionCtor | undefined {
    const w = scope as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor } | undefined;
    return w?.SpeechRecognition ?? w?.webkitSpeechRecognition;
}

/** One line, no terminal controls, collapsed whitespace, bounded. Never contains a newline. */
export function cleanTranscript(text: string, limit = 2000): string {
    return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export interface DictationOptions {
    ctor?: RecognitionCtor;
    lang?: string;
    onChange(state: DictationState): void;
}

export class DictationController {
    state: DictationState;
    private recognition?: RecognitionLike;
    private finals: string[] = [];
    private deliver?: (text: string) => Promise<void> | void;
    private session = 0;
    private disposed = false;

    constructor(private options: DictationOptions) {
        const lang = options.lang ?? ((typeof navigator !== 'undefined' && navigator.language) || 'en-US');
        this.state = { availability: 'checking', phase: 'off', lang, interim: '', targetLabel: '', lastDraft: '', error: '', notice: '' };
        void this.check();
    }
    private emit(patch: Partial<DictationState>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.options.onChange(this.state); }

    /** Reads on-device availability only. Never opens the microphone. */
    async check(): Promise<void> {
        const ctor = this.options.ctor;
        if (!ctor) { this.emit({ availability: 'unsupported', notice: 'This browser has no speech recognition. Dictation is not available.' }); return; }
        try {
            let result: string | undefined;
            if (ctor.available) result = await ctor.available({ langs: [this.state.lang], processLocally: true });
            else if (ctor.availableOnDevice) result = await ctor.availableOnDevice(this.state.lang);
            const availability: DictationAvailability = result === 'available' ? 'available' : result === 'downloadable' ? 'downloadable' : result === 'downloading' ? 'downloading' : 'unsupported';
            this.emit({ availability, notice: availability === 'unsupported' ? 'This browser cannot recognise speech on this device. Dictation stays off so audio never leaves your computer.' : availability === 'downloadable' ? 'On-device speech model can be downloaded once.' : '' });
        } catch (error) {
            this.emit({ availability: 'unsupported', notice: `On-device speech check failed: ${String(error)}` });
        }
    }

    /** User click: download the on-device speech model (browser-managed). */
    async installModel(): Promise<void> {
        const ctor = this.options.ctor;
        if (!ctor || this.state.availability !== 'downloadable') return;
        this.emit({ availability: 'downloading', notice: 'Downloading the on-device speech model…', error: '' });
        try {
            const ok = ctor.install ? await ctor.install({ langs: [this.state.lang], processLocally: true }) : ctor.installOnDevice ? await ctor.installOnDevice(this.state.lang) : false;
            if (!ok) this.emit({ error: 'The on-device speech model was not installed.' });
        } catch (error) { this.emit({ error: `Speech model install failed: ${String(error)}` }); }
        await this.check();
    }

    /** User click: allow hold-to-dictate. Does not open the microphone yet. */
    enable(): void {
        if (this.state.availability !== 'available') { this.emit({ error: 'On-device speech recognition is not available, so dictation stays off.' }); return; }
        this.emit({ phase: 'ready', error: '', notice: 'Dictation on · Look at an agent monitor and hold T to talk.' });
    }
    disable(): void { this.cancel(); this.emit({ phase: 'off', interim: '', targetLabel: '', notice: 'Dictation off.' }); }

    /**
     * Key down (a user gesture): start listening for one utterance aimed at one target.
     * `deliver` receives the final transcript and must paste it without Enter.
     */
    begin(targetLabel: string, deliver: (text: string) => Promise<void> | void): boolean {
        if (this.disposed || this.state.phase !== 'ready' || !this.options.ctor) return false;
        const session = ++this.session;
        let recognition: RecognitionLike;
        try { recognition = new this.options.ctor(); } catch (error) { this.emit({ error: `Speech recognition could not start: ${String(error)}` }); return false; }
        // Fail closed: start only when the browser offers an on-device switch.
        if (!('processLocally' in recognition) && !('mode' in recognition)) {
            this.emit({ error: 'This browser cannot promise on-device recognition, so dictation did not start.' }); return false;
        }
        if ('processLocally' in recognition) recognition.processLocally = true;
        if ('mode' in recognition) (recognition as unknown as { mode: string }).mode = 'ondevice-only';
        recognition.lang = this.state.lang; recognition.continuous = true; recognition.interimResults = true; recognition.maxAlternatives = 1;
        this.finals = []; this.deliver = deliver; this.recognition = recognition;
        recognition.onresult = event => {
            if (session !== this.session) return;
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i]; const text = result[0]?.transcript ?? '';
                if (result.isFinal) this.finals.push(text); else interim += text;
            }
            this.emit({ interim: cleanTranscript([...this.finals, interim].join(' '), 400) });
        };
        recognition.onerror = event => {
            if (session !== this.session) return;
            if (event.error === 'aborted' || event.error === 'no-speech') return;
            const denied = event.error === 'not-allowed' || event.error === 'service-not-allowed';
            this.emit({ error: denied ? 'Microphone permission was denied. Dictation needs your browser permission.' : `Dictation error: ${event.error}${event.message ? ` · ${event.message}` : ''}` });
        };
        recognition.onend = () => {
            if (session !== this.session) return;
            this.recognition = undefined;
            const text = cleanTranscript(this.finals.join(' ') || this.state.interim);
            const deliverTo = this.deliver; this.deliver = undefined;
            this.emit({ phase: this.state.phase === 'off' ? 'off' : 'ready', interim: '', targetLabel: '' });
            if (!text) { this.emit({ notice: 'No speech heard. Nothing was typed.' }); return; }
            void Promise.resolve(deliverTo?.(text)).then(() => this.emit({ lastDraft: text })).catch(error => this.emit({ error: `Draft not placed: ${String(error)}` }));
        };
        try { recognition.start(); } catch (error) { this.recognition = undefined; this.emit({ error: `Speech recognition could not start: ${String(error)}` }); return false; }
        this.emit({ phase: 'listening', interim: '', targetLabel, error: '', notice: `Listening for ${targetLabel}… release T to place a draft.` });
        return true;
    }
    /** Key up: finish the utterance; the transcript becomes a draft (no Enter). */
    finish(): void {
        if (!this.recognition || this.state.phase !== 'listening') return;
        this.emit({ phase: 'finishing' });
        try { this.recognition.stop(); } catch { this.cancel(); }
    }
    /** Focus lost or target gone: discard without typing anything. */
    cancel(): void {
        this.session++; this.deliver = undefined; this.finals = [];
        const r = this.recognition; this.recognition = undefined;
        try { r?.abort(); } catch { /* already ended */ }
        if (this.state.phase === 'listening' || this.state.phase === 'finishing') this.emit({ phase: 'ready', interim: '', targetLabel: '', notice: 'Dictation cancelled. Nothing was typed.' });
    }
    dispose(): void { this.cancel(); this.disposed = true; }
}

/**
 * Optional read-aloud of agent replies (opt-in toggle, off by default).
 *
 * - Uses the browser's speechSynthesis with ON-DEVICE voices only (`localService`), so reply
 *   text is not sent to a cloud voice. If there is no local voice, read-aloud stays off.
 * - Reads only what newly appeared on an agent tab's screen after it worked and went quiet.
 * - Never types, never presses keys, never starts or wakes an agent.
 */

export interface SpeechLike {
    speak(utterance: SpeechSynthesisUtterance): void;
    cancel(): void;
    getVoices(): SpeechSynthesisVoice[];
    speaking: boolean;
}

const CHROME = /^[\s\u2500-\u257f\u2580-\u259f\u25a0-\u25ff\u2800-\u28ff|+\-=_*#>:.·•…~`'"[\](){}<>\\/]*$/u;
const SPINNER = /^[\s\u2800-\u28ff◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\-]+\s*(thinking|working|running|loading)?/iu;

/** Lines that are new on screen relative to `before`, cleaned of TUI chrome, bounded for speech. */
export function replyText(before: readonly string[], after: readonly string[], skip: readonly string[] = [], limit = 700): string {
    const seen = new Set(before.map(line => line.trim()));
    const ignore = new Set(skip.map(s => s.trim().toLowerCase()).filter(Boolean));
    const out: string[] = [];
    for (const raw of after) {
        const line = raw.replace(/[\u2500-\u259f\u2800-\u28ff]+/gu, ' ').replace(/\s+/g, ' ').trim();
        if (!line || seen.has(raw.trim()) || CHROME.test(line) || SPINNER.test(line) && line.length < 24) continue;
        const lower = line.toLowerCase();
        if (ignore.has(lower) || [...ignore].some(s => (s.length > 8 && lower.includes(s)) || (lower.length > 8 && s.includes(lower)))) continue; // our own (wrapped) draft
        if (/^[>$#❯›»]\s/u.test(line)) continue; // prompt / input line
        out.push(line);
    }
    const text = out.join(' ').replace(/https?:\/\/\S+/g, 'a link').trim();
    return text.length > limit ? `${text.slice(0, limit).replace(/\s+\S*$/, '')}…` : text;
}

export class ReadAloud {
    enabled = false;
    speakingKey?: string;
    private voice?: SpeechSynthesisVoice;
    constructor(private synth: SpeechLike | undefined, private onChange: () => void, private lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US') {}

    get supported(): boolean { return !!this.synth && typeof SpeechSynthesisUtterance !== 'undefined'; }
    /** The on-device voice to use, if any. Remote (network) voices are never used. */
    localVoice(): SpeechSynthesisVoice | undefined {
        if (!this.synth) return undefined;
        const voices = this.synth.getVoices().filter(v => v.localService);
        const base = this.lang.split('-')[0].toLowerCase();
        return voices.find(v => v.lang.toLowerCase() === this.lang.toLowerCase()) ?? voices.find(v => v.lang.toLowerCase().startsWith(base)) ?? voices[0];
    }
    /** User toggle. Returns an explanation when it cannot be turned on. */
    setEnabled(on: boolean): string {
        if (!on) { this.enabled = false; this.stop(); this.onChange(); return 'Read-aloud off.'; }
        if (!this.supported) return 'This browser cannot read aloud.';
        this.voice = this.localVoice();
        if (!this.voice) return 'No on-device voice found, so read-aloud stays off (replies are never sent to an online voice).';
        this.enabled = true; this.onChange();
        return `Read-aloud on · ${this.voice.name}.`;
    }
    speak(key: string, text: string): boolean {
        if (!this.enabled || !this.synth || !text.trim()) return false;
        const voice = this.voice?.localService ? this.voice : this.localVoice();
        if (!voice) return false;
        this.synth.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 1.05;
        utterance.onend = utterance.onerror = () => { if (this.speakingKey === key) { this.speakingKey = undefined; this.onChange(); } };
        this.speakingKey = key; this.onChange();
        this.synth.speak(utterance);
        return true;
    }
    stop(): void { this.synth?.cancel(); if (this.speakingKey) { this.speakingKey = undefined; this.onChange(); } }
}

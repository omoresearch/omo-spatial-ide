/**
 * promise-agent — talk to Omo out loud: hold the mic button on the Shape prompt (or Alt+T in it) to dictate.
 * The transcript runs exactly like typing (the same send path). Uses the on-device DictationController
 * (voice-dictation.ts): no cloud speech, the microphone only while held, nothing typed into a terminal.
 */
import { cleanTranscript, DictationController } from './voice-dictation';

/** Spoken words -> one Shape prompt line ("Hey Omo, where is the Claude desk." -> "where is the Claude desk?"). */
export function voicePrompt(spoken: string): string {
    let t = cleanTranscript(spoken, 400);
    t = t.replace(/^(?:hey|ok|okay|hi)?\s*,?\s*omo\s*[,.:!]?\s+/i, '').trim();
    if (/^(?:where|what|which|how many|who)\b/i.test(t)) t = t.replace(/[.!]+$/, '').replace(/\?*$/, '?');
    else t = t.replace(/[.!]+$/, '');
    return t;
}

/**
 * The talk key in the Shape prompt. voice-hub's hold-to-dictate key is T (V is push-to-talk to people), but
 * the prompt is a text box where a plain T types a letter, so Shape uses the same letter with Alt: hold Alt+T.
 */
export const SHAPE_TALK_KEY = 't';
export function isTalkKey(e: { key: string; altKey: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean {
    return e.key.toLowerCase() === SHAPE_TALK_KEY && e.altKey && !e.ctrlKey && !e.metaKey;
}
/** Releasing either key of the chord ends the line. */
export function isTalkRelease(e: { key: string }): boolean { return e.key.toLowerCase() === SHAPE_TALK_KEY || e.key === 'Alt'; }
/**
 * The spoken line goes into the prompt (so you see it) and is then sent by the same send() Enter uses,
 * on the next tick, after the prompt shows the words.
 */
export function intoPrompt(setText: (text: string) => void, send: (text: string) => void, defer: (fn: () => void) => void = fn => { setTimeout(fn, 0); }): (text: string) => void {
    return text => { setText(text); defer(() => send(text)); };
}

export class ShapeVoice {
    private held = false;
    constructor(private readonly dictation: DictationController, private readonly submit: (text: string) => void) {}
    get state(): DictationController['state'] { return this.dictation.state; }
    get available(): boolean { return this.dictation.state.availability === 'available'; }
    get listening(): boolean { return this.dictation.state.phase === 'listening' || this.dictation.state.phase === 'finishing'; }
    /** Button / key down (a user gesture): turn dictation on (first time) and listen for one line. */
    hold(): boolean {
        if (this.held) return false;
        if (this.dictation.state.phase === 'off' || this.dictation.state.phase === 'error') this.dictation.enable();
        if (this.dictation.state.phase !== 'ready') return false;
        this.held = this.dictation.begin('Omo', text => { const line = voicePrompt(text); if (line) this.submit(line); });
        return this.held;
    }
    /** Button / key up: the words become the prompt and run. */
    release(): void { if (!this.held) return; this.held = false; this.dictation.finish(); }
    cancel(): void { this.held = false; this.dictation.cancel(); }
    dispose(): void { this.dictation.dispose(); }
}

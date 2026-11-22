/**
 * world-magic — quiet synthesised sound (WebAudio only, no asset files, no licences).
 *
 * - creation chime: a low soft bell (two detuned sines + a fifth, long exponential tail, light lowpass);
 * - removal: the same bell falling a fourth, shorter;
 * - room tone: very low filtered noise with a slow swell plus a faint distant city hum (off by default until the
 *   first user gesture, because browsers only start audio after one);
 * - tick: a tiny soft click for UI.
 * Master volume follows world-magic settings; muted or effects off = silent. Nothing is created before a gesture.
 */
import { onWorldMagicChange, worldMagicSettings } from './world-magic-settings';

type Ctx = AudioContext;

export class WorldMagicSound {
    private ctx?: Ctx;
    private master?: GainNode;
    private tone?: { gain: GainNode; stop: () => void };
    private unlocked = false;
    private readonly off: Array<() => void> = [];
    /** Chimes requested (tests read this; audio may still be locked). */
    chimes = 0;

    constructor(private readonly roomTone = true) {
        if (typeof window === 'undefined') return;
        const unlock = (): void => { this.unlocked = true; this.ensure(); };
        for (const name of ['pointerdown', 'keydown'] as const) { window.addEventListener(name, unlock, { capture: true, passive: true }); this.off.push(() => window.removeEventListener(name, unlock, { capture: true } as EventListenerOptions)); }
        this.off.push(onWorldMagicChange(() => this.applyVolume()));
    }

    private level(): number { return worldMagicSettings.enabled && !worldMagicSettings.muted ? worldMagicSettings.volume : 0; }

    private ensure(): Ctx | undefined {
        if (!this.unlocked || this.level() <= 0) return this.ctx;
        if (!this.ctx) {
            const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
                ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AC) return undefined;
            try { this.ctx = new AC(); } catch { return undefined; }
            this.master = this.ctx.createGain(); this.master.gain.value = this.level() * 0.6; this.master.connect(this.ctx.destination);
            if (this.roomTone) this.startTone();
        }
        if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
        return this.ctx;
    }
    private applyVolume(): void {
        if (!this.ctx || !this.master) { if (this.level() > 0) this.ensure(); return; }
        this.master.gain.setTargetAtTime(this.level() * 0.6, this.ctx.currentTime, 0.2);
    }

    /** Low soft chime. `kind` 'remove' falls instead of rising. */
    chime(kind: 'create' | 'remove' = 'create'): void {
        this.chimes++;
        const ctx = this.ensure(); if (!ctx || !this.master || this.level() <= 0) return;
        const t = ctx.currentTime + 0.01;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.3; lp.connect(this.master);
        const notes = kind === 'create' ? [[392, 0.16, 0], [392 * 1.003, 0.1, 0], [587.3, 0.07, 0.09], [784, 0.035, 0.18]] : [[392, 0.12, 0], [293.7, 0.08, 0.12]];
        const tail = kind === 'create' ? 2.6 : 1.3;
        for (const [freq, amp, delay] of notes) {
            const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
            if (kind === 'remove') o.frequency.exponentialRampToValueAtTime(freq * 0.94, t + delay + tail);
            const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t + delay);
            g.gain.exponentialRampToValueAtTime(amp, t + delay + 0.025); g.gain.exponentialRampToValueAtTime(0.0001, t + delay + tail);
            o.connect(g); g.connect(lp); o.start(t + delay); o.stop(t + delay + tail + 0.05);
        }
    }
    /** Tiny UI tick. */
    tick(): void {
        const ctx = this.ensure(); if (!ctx || !this.master || this.level() <= 0) return;
        const t = ctx.currentTime + 0.005, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.04);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.025, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
        o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.08);
    }

    private startTone(): void {
        const ctx = this.ctx!, master = this.master!;
        const gain = ctx.createGain(); gain.gain.value = 0; gain.connect(master);
        // Filtered noise: soft room air.
        const len = ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
        let b = 0; for (let i = 0; i < len; i++) { b = 0.985 * b + 0.015 * (Math.random() * 2 - 1); d[i] = b * 3.2; }
        const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
        const ng = ctx.createGain(); ng.gain.value = 0.05; noise.connect(lp); lp.connect(ng); ng.connect(gain);
        // Distant city hum: two low detuned sines with a very slow swell.
        const hum = [55, 82.6].map(f => { const o = ctx.createOscillator(); o.frequency.value = f; const g = ctx.createGain(); g.gain.value = 0.006; o.connect(g); g.connect(gain); o.start(); return o; });
        const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05; const lg = ctx.createGain(); lg.gain.value = 0.02; lfo.connect(lg); lg.connect(ng.gain); lfo.start();
        noise.start();
        gain.gain.setTargetAtTime(1, ctx.currentTime, 3);
        this.tone = { gain, stop: () => { try { noise.stop(); lfo.stop(); hum.forEach(o => o.stop()); } catch { /* stopped */ } } };
    }

    dispose(): void {
        this.off.forEach(fn => fn()); this.off.length = 0;
        this.tone?.stop(); this.tone = undefined;
        void this.ctx?.close().catch(() => undefined); this.ctx = undefined;
    }
}

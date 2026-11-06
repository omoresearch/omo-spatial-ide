import * as React from 'react';
import { Icon } from './icons';
import type { IconName } from './icons';

/**
 * omo keys6 lane: first-run coach mark. Four short steps, shown once after a room exists.
 * "Seen" is saved on this device. It never takes the keys: WASD keeps working while it shows.
 */
export const COACH_KEY = 'omo.coach.v1';
export function coachSeen(): boolean { try { return localStorage.getItem(COACH_KEY) === 'seen'; } catch { return false; } }
export function markCoachSeen(): void { try { localStorage.setItem(COACH_KEY, 'seen'); } catch { /* storage blocked: hidden for this session only */ } }

interface CoachStep { title: string; body: string; keys: string[]; icon: IconName }
export const COACH_STEPS: readonly CoachStep[] = [
    { title: 'Walk around', body: 'Use W A S D to walk. Drag to look.', keys: ['W', 'A', 'S', 'D'], icon: 'walk' },
    { title: 'Use a screen', body: 'Click a desk screen to attach to it. Your keys go to that terminal.', keys: ['Click'], icon: 'monitor' },
    { title: 'Full screen and back', body: 'Press F for full screen. Esc goes back, one step at a time. F1 shows every key.', keys: ['F', 'Esc'], icon: 'maximize' },
    { title: 'Immersive world', body: 'Press G and the room fills the whole window. Press G again to bring the panels back.', keys: ['G'], icon: 'expand' },
];

export function CoachMark(props: { onDone: () => void; refocus: () => void }): React.ReactElement {
    const [step, setStep] = React.useState(0);
    const last = step === COACH_STEPS.length - 1;
    const s = COACH_STEPS[step];
    // Buttons must not keep the focus, or WASD would stop reaching the room.
    const keep = (event: React.MouseEvent): void => event.preventDefault();
    const go = (next: number): void => { setStep(next); props.refocus(); };
    return <div className="omo-coach" role="dialog" aria-label="Getting started" aria-live="polite" data-testid="coach-mark" data-step={String(step + 1)} onMouseDown={keep}>
        <div className="omo-coach-top">
            <span className="omo-coach-count">{step + 1} of {COACH_STEPS.length}</span>
            <span className="omo-coach-dots" aria-hidden="true">{COACH_STEPS.map((_, i) => <i key={i} className={i === step ? 'is-on' : i < step ? 'is-done' : ''} />)}</span>
            <button type="button" className="omo-coach-skip" data-testid="coach-skip" onClick={props.onDone} aria-label="Close the tips"><Icon name="x" size={14} /></button>
        </div>
        <div className="omo-coach-body">
            <Icon name={s.icon} size={20} className="omo-coach-icon" /><span className="omo-coach-keys" aria-hidden="true">{s.keys.map(k => <kbd key={k}>{k}</kbd>)}</span>
            <div><strong>{s.title}</strong><p>{s.body}</p></div>
        </div>
        <div className="omo-coach-actions">
            {step > 0 && <button type="button" data-testid="coach-back" onClick={() => go(step - 1)}>Back</button>}
            <button type="button" className="is-primary" data-testid={last ? 'coach-done' : 'coach-next'} onClick={() => last ? props.onDone() : go(step + 1)}>{last ? 'Got it' : 'Next'}</button>
        </div>
    </div>;
}

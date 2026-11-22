// Avatars v2, direction C. Refined human: real proportions, simple hair, knit + trousers in the person colour.
// Drop-in for avatars.js (same API, SOCIAL-CONTRACT.md): import { createAvatar, attachAvatars } from './avatars/avatars-v2-human.js';
import { makeDirection, HATS, STATES, TIMING } from './avatars-v2.js';
const d = makeDirection('human');
export const createAvatar = d.createAvatar;
export const attachAvatars = d.attachAvatars;
export { HATS, STATES, TIMING };

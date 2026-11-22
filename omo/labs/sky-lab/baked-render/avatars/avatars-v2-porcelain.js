// Avatars v2, direction A. Porcelain: matte warm-white mannequin, colour as a rim light.
// Drop-in for avatars.js (same API, SOCIAL-CONTRACT.md): import { createAvatar, attachAvatars } from './avatars/avatars-v2-porcelain.js';
import { makeDirection, HATS, STATES, TIMING } from './avatars-v2.js';
const d = makeDirection('porcelain');
export const createAvatar = d.createAvatar;
export const attachAvatars = d.attachAvatars;
export { HATS, STATES, TIMING };

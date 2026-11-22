// Avatars v2, direction B. Light form: frosted glowing figure, solid head and hands, pulses when speaking.
// Drop-in for avatars.js (same API, SOCIAL-CONTRACT.md): import { createAvatar, attachAvatars } from './avatars/avatars-v2-light.js';
import { makeDirection, HATS, STATES, TIMING } from './avatars-v2.js';
const d = makeDirection('light');
export const createAvatar = d.createAvatar;
export const attachAvatars = d.attachAvatars;
export { HATS, STATES, TIMING };

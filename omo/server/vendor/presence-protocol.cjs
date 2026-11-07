// GENERATED from omo/extension/src/common/presence-protocol.ts (sha256 09c12f70d7e9bcd91b9c0684738c29af655f61787a0c5eeafa0f99d24fb609e9). Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VOICE_INBOX_MAX = exports.VOICE_SIGNAL_MAX_CHARS = exports.CHAT_RATE_WINDOW_MS = exports.CHAT_RATE_COUNT = exports.CHAT_INBOX_MAX = exports.CHAT_TEXT_MAX = exports.CHAT_EMOTES = exports.PRESENCE_COLOUR_HEX = exports.PRESENCE_COLOURS = exports.OmoPresenceService = exports.OMO_PRESENCE_PATH = void 0;
exports.presenceColour = presenceColour;
exports.chatSay = chatSay;
exports.voiceStatus = voiceStatus;
exports.voiceSignal = voiceSignal;
exports.presenceLayout = presenceLayout;
exports.presenceJoin = presenceJoin;
exports.presencePose = presencePose;
exports.presenceStation = presenceStation;
exports.OMO_PRESENCE_PATH = '/services/omo-presence';
exports.OmoPresenceService = Symbol('OmoPresenceService');
/** A small fixed palette. Colours are never free text, so a tag cannot carry markup or tracking. */
exports.PRESENCE_COLOURS = ['rose', 'sky', 'amber', 'mint', 'coral', 'violet', 'lime', 'sand'];
exports.PRESENCE_COLOUR_HEX = {
    coral: '#ff7a6b', amber: '#ffc04d', lime: '#a6e35a', mint: '#5fe0b5', sky: '#5fb4ff', violet: '#b48cff', rose: '#ff6fc4', sand: '#e0c9a0'
};
function presenceColour(input) {
    if (typeof input !== 'string' || !exports.PRESENCE_COLOURS.includes(input))
        throw new Error('Choose one of the room colours.');
    return input;
}
/** Emotes are a closed set: the receiver draws them, the sender cannot send pictures or markup. */
exports.CHAT_EMOTES = ['wave', 'cheer', 'thumbsup', 'clap'];
exports.CHAT_TEXT_MAX = 500;
exports.CHAT_INBOX_MAX = 100;
/** At most CHAT_RATE_COUNT lines per CHAT_RATE_WINDOW_MS per member. */
exports.CHAT_RATE_COUNT = 8;
exports.CHAT_RATE_WINDOW_MS = 10000;
function chatSay(input) {
    if (!input || typeof input !== 'object')
        throw new Error('Invalid chat message.');
    if (input.kind === 'emote') {
        if (!exports.CHAT_EMOTES.includes(input.emote))
            throw new Error('Unknown emote.');
        return { kind: 'emote', emote: input.emote };
    }
    if (input.kind !== 'text' || typeof input.text !== 'string')
        throw new Error('Invalid chat message.');
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(input.text))
        throw new Error('Chat is one line of plain text, without control characters.');
    const text = input.text.trim();
    if (!text)
        throw new Error('Type a message first.');
    if (text.length > exports.CHAT_TEXT_MAX)
        throw new Error(`Chat lines are at most ${exports.CHAT_TEXT_MAX} characters.`);
    return { kind: 'text', text };
}
exports.VOICE_SIGNAL_MAX_CHARS = 16 * 1024;
exports.VOICE_INBOX_MAX = 64;
const VOICE_SESSION = /^[a-f0-9]{8,32}$/;
function voiceStatus(input) {
    if (input === null)
        return null;
    if (!input || typeof input.session !== 'string' || !VOICE_SESSION.test(input.session) || typeof input.muted !== 'boolean' || typeof input.speaking !== 'boolean')
        throw new Error('Invalid voice status.');
    return { session: input.session, muted: input.muted, speaking: input.speaking && !input.muted };
}
function voiceSignal(input) {
    if (!input || typeof input.to !== 'string' || input.to.length > 64 || typeof input.toSession !== 'string' || !VOICE_SESSION.test(input.toSession)
        || typeof input.session !== 'string' || !VOICE_SESSION.test(input.session))
        throw new Error('Invalid voice signal address.');
    if (input.kind !== 'offer' && input.kind !== 'answer' && input.kind !== 'ice' && input.kind !== 'bye')
        throw new Error('Invalid voice signal kind.');
    if (typeof input.data !== 'string' || input.data.length > exports.VOICE_SIGNAL_MAX_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.data))
        throw new Error('Invalid voice signal payload.');
    if ((input.kind === 'offer' || input.kind === 'answer') && /^m=(?!audio)/m.test(input.data))
        throw new Error('Room voice carries audio only.');
    return { to: input.to, toSession: input.toSession, session: input.session, kind: input.kind, data: input.data };
}
function presenceLayout(input) {
    return input.layout ?? 'classic';
}
function presenceJoin(input) {
    if (!input || typeof input.roomId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(input.roomId))
        throw new Error('Room code must be 3–32 lowercase letters, numbers or hyphens.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name))
        throw new Error('Name must be 1–32 characters without control characters.');
    if (typeof input.clientId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.clientId))
        throw new Error('Invalid tab identity.');
    if (typeof input.projectUri !== 'string' || input.projectUri.length > 4096 || !input.projectUri.startsWith('file:///') || /[\u0000-\u001f]/u.test(input.projectUri))
        throw new Error('Choose a local project.');
    if (input.theme !== 'station' && input.theme !== 'jungle')
        throw new Error('Invalid room theme.');
    if (input.layout !== undefined && input.layout !== 'classic' && input.layout !== 'wide')
        throw new Error('Invalid room layout.');
    const normalized = { roomId: input.roomId, name: input.name.trim(), clientId: input.clientId, projectUri: input.projectUri, theme: input.theme };
    if (input.layout === 'wide')
        normalized.layout = 'wide';
    return normalized;
}
function presencePose(pose) {
    if (!pose || ![pose.x, pose.z, pose.yaw, pose.pitch].every(n => typeof n === 'number' && Number.isFinite(n)) || Math.abs(pose.x) > 5.5 || pose.z < -3.8 || pose.z > 4.45 || Math.abs(pose.yaw) > Math.PI || Math.abs(pose.pitch) > 1.2)
        throw new Error('Invalid room position.');
    return { x: pose.x, z: pose.z, yaw: pose.yaw, pitch: pose.pitch };
}
/** Default binding separation, NOT authorization. Existing workspace tools remain OS-user shared. */
function presenceStation(input, station) {
    const valid = presenceJoin(input);
    return `room-${valid.roomId}-${valid.clientId}-${station}`;
}

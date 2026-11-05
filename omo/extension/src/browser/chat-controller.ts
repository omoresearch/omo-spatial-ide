import type { ChatEmote, ChatMessage, ChatSay, OmoPresenceService, PresenceColour, RoomSnapshot } from '../common/presence-protocol';
import { CHAT_EMOTES, CHAT_TEXT_MAX, PRESENCE_COLOURS } from '../common/presence-protocol';
import type { RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';
import type { DeskId } from './agent-avatars';
import { DESKS, DESK_NAME, DeskTabs, MentionTarget, mentionsName, parseMention } from './chat-mentions';

export type ChatLineKind = 'text' | 'emote' | 'system' | 'draft' | 'error';
export interface ChatLine { id: string; kind: ChatLineKind; at: number; from?: string; fromName?: string; colour?: PresenceColour; self?: boolean; text: string; emote?: ChatEmote; mentionsMe?: boolean }
export type ToastKind = 'join' | 'leave' | 'mention' | 'info';
export interface Toast { id: string; kind: ToastKind; text: string; at: number; colour?: PresenceColour; /** Line icon name (icons.tsx) for agent notices. */ icon?: 'check' | 'alert' | 'bell' }
export interface ChatState { lines: ChatLine[]; unread: number; open: boolean; sending: boolean; error: string }

export interface ChatHost {
    service: Pick<OmoPresenceService, 'say' | 'takeChat' | 'setColour'>;
    /** Joined room snapshot, or undefined when solo. */
    room(): RoomSnapshot | undefined;
    desk(desk: DeskId): { state: RuntimeConsoleState; controller?: RuntimeConsoleController };
    toast(kind: ToastKind, text: string, colour?: PresenceColour): void;
    emote(memberId: string, emote: ChatEmote): void;
    command(name: 'follow' | 'tp' | 'unfollow', arg: string): string;
    onChange(): void;
}

export const EMOTE_TEXT: Record<ChatEmote, { glyph: string; verb: string }> = {
    wave: { glyph: '👋', verb: 'waves' }, cheer: { glyph: '🎉', verb: 'cheers' }, thumbsup: { glyph: '👍', verb: 'gives a thumbs up' }, clap: { glyph: '👏', verb: 'claps' }
};
const LOG_MAX = 200;
const POLL_MS = 600;
export const CHAT_HELP = 'Chat: type and press Enter. @desk1 / @desk2 / @hermes / @claude / @codex / @<tab-name> at the start puts a DRAFT in your own agent tab (never sent, never shared). /wave /cheer /thumbsup /clap · /follow <name> · /tp <name> · /unfollow · /colour <name>.';

let counter = 0;
const localId = (): string => `local-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Room text chat. Lines go only to members of the same room. Agent drafts never leave this tab. */
export class ChatController {
    state: ChatState = { lines: [], unread: 0, open: false, sending: false, error: '' };
    private timer = 0;
    private polling = false;
    private roomKey = '';
    private disposed = false;
    constructor(private host: ChatHost) { this.timer = window.setInterval(() => void this.poll(), POLL_MS); }

    private set(patch: Partial<ChatState>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.host.onChange(); }
    private push(line: ChatLine): void {
        const lines = [...this.state.lines, line];
        if (lines.length > LOG_MAX) lines.splice(0, lines.length - LOG_MAX);
        this.set({ lines, unread: this.state.open || line.self || (line.kind !== 'text' && line.kind !== 'emote') ? this.state.unread : this.state.unread + 1 });
    }
    system(text: string): void { this.push({ id: localId(), kind: 'system', at: Date.now(), text }); }
    setOpen(open: boolean): void { this.set({ open, unread: open ? 0 : this.state.unread, error: open ? this.state.error : '' }); }

    private deskTabs(): DeskTabs[] {
        return DESKS.map(desk => { const { state } = this.host.desk(desk); return { desk, tabs: state.workspace?.tabs ?? [], activeTabId: state.activeTabId, live: state.phase === 'live' }; });
    }

    /** One line from the local user. Returns true when the input box may clear. */
    async submit(raw: string): Promise<boolean> {
        const line = raw.replace(/[\r\n]+/g, ' ').trim();
        if (!line || this.state.sending) return false;
        if (line.startsWith('/')) return this.slash(line);
        const mention = parseMention(line, this.deskTabs());
        if (mention.kind === 'error') { this.set({ error: mention.error }); return false; }
        if (mention.kind === 'draft') return this.draft(mention.target, mention.text);
        if (!this.host.room()) { this.set({ error: 'Join a shared room to chat with people. Start a line with @desk1 or @hermes to draft for your own agent.' }); return false; }
        return this.say({ kind: 'text', text: line.slice(0, CHAT_TEXT_MAX) });
    }

    private async say(message: ChatSay): Promise<boolean> {
        this.set({ sending: true, error: '' });
        try {
            const sent = await this.host.service.say(message);
            this.set({ sending: false });
            this.push(this.toLine(sent, true));
            if (sent.kind === 'emote' && sent.emote) this.host.emote(sent.from, sent.emote);
            return true;
        } catch (error) { this.set({ sending: false, error: errorText(error) }); return false; }
    }

    /**
     * Paste `text` as a DRAFT into one agent tab on the user's own desk. Uses the desk's own
     * prepareTask (safe paste, no Enter). Never opens, starts, wakes or revives anything.
     */
    async draft(target: MentionTarget, text: string): Promise<boolean> {
        const { state, controller } = this.host.desk(target.desk);
        if (!controller || state.phase !== 'live') { this.set({ error: `${DESK_NAME[target.desk]} is not open. Click its monitor first. Nothing was typed.` }); return false; }
        const tab = state.workspace?.tabs.find(t => t.id === target.tabId);
        if (!tab || tab.kind === 'shell' || tab.state !== 'running') { this.set({ error: `${target.label} is not running. Nothing was started or typed.` }); return false; }
        this.set({ sending: true, error: '' });
        try {
            if (state.activeTabId !== target.tabId) await controller.selectTab(target.tabId);
            const where = controller.taskTarget();
            if (!where || where.tabId !== target.tabId) throw new Error(`${target.label} is not ready for a draft yet. Nothing was typed.`);
            const ok = await controller.prepareTask(where, text);
            if (!ok) throw new Error(controller.state.error || 'The agent tab changed, so nothing was typed.');
            this.set({ sending: false });
            this.push({ id: localId(), kind: 'draft', at: Date.now(), self: true, text: `Draft for ${target.label}: “${text}” · Review it on the monitor and press Enter yourself. Not sent, not shared.` });
            return true;
        } catch (error) { this.set({ sending: false, error: errorText(error) }); return false; }
    }

    private async slash(line: string): Promise<boolean> {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        const arg = rest.join(' ').trim();
        const name = cmd.toLowerCase();
        if ((CHAT_EMOTES as readonly string[]).includes(name)) {
            if (!this.host.room()) { this.set({ error: 'Join a shared room to wave at people.' }); return false; }
            return this.say({ kind: 'emote', emote: name as ChatEmote });
        }
        if (name === 'help' || name === '?') { this.system(CHAT_HELP); return true; }
        if (name === 'follow' || name === 'tp' || name === 'unfollow') { const result = this.host.command(name, arg); if (result) this.system(result); return true; }
        if (name === 'colour' || name === 'color') {
            const colour = arg.toLowerCase();
            if (!(PRESENCE_COLOURS as readonly string[]).includes(colour)) { this.set({ error: `Colours: ${PRESENCE_COLOURS.join(', ')}.` }); return false; }
            return this.setColour(colour as PresenceColour);
        }
        this.set({ error: `Unknown command /${cmd}. Type /help.` });
        return false;
    }

    async setColour(colour: PresenceColour): Promise<boolean> {
        if (!this.host.room()) { this.set({ error: 'Join a shared room first.' }); return false; }
        try { await this.host.service.setColour(colour); this.system(`Your name colour is now ${colour}.`); return true; }
        catch (error) { this.set({ error: errorText(error) }); return false; }
    }

    private toLine(message: ChatMessage, self: boolean): ChatLine {
        const me = this.host.room()?.members.find(m => m.id === this.host.room()?.selfId)?.name ?? '';
        const text = message.kind === 'emote' && message.emote ? `${EMOTE_TEXT[message.emote].glyph} ${self ? 'You' : message.fromName} ${self ? EMOTE_TEXT[message.emote].verb.replace(/s\b/, '') : EMOTE_TEXT[message.emote].verb}` : message.text ?? '';
        return { id: message.id, kind: message.kind, at: message.at, from: message.from, fromName: message.fromName, colour: message.colour, self, text, emote: message.emote, mentionsMe: !self && message.kind === 'text' && !!me && mentionsName(text, me) };
    }

    private async poll(): Promise<void> {
        if (this.disposed || this.polling) return;
        const room = this.host.room();
        const key = room ? `${room.roomId}:${room.selfId}` : '';
        if (key !== this.roomKey) { this.roomKey = key; if (key) this.system(`Joined room ${room!.roomId}. Chat goes only to people in this room. Type /help.`); }
        if (!room) return;
        this.polling = true;
        try {
            const messages = await this.host.service.takeChat();
            for (const message of messages) {
                if (message.from === room.selfId) continue;
                const line = this.toLine(message, false);
                this.push(line);
                if (message.kind === 'emote' && message.emote) this.host.emote(message.from, message.emote);
                if (line.mentionsMe) this.host.toast('mention', `${message.fromName}: ${line.text}`, message.colour);
            }
        } catch { /* presence loss is reported by the presence bar */ }
        finally { this.polling = false; }
    }

    dispose(): void { this.disposed = true; window.clearInterval(this.timer); }
}

function errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/^Error:\s*/, '').replace(/^Request '[^']*' failed\s*/i, '');
}

import type { ChatEmote, OmoPresenceService, PresenceColour, RoomMember, RoomSnapshot } from '../common/presence-protocol';
import type { RoomLayoutId } from '../common/player-state';
import type { PresenceState } from './presence-controller';
import type { RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';
import type { RoomScene } from './room-scene';
import type { AgentPresence, DeskId } from './agent-avatars';
import type { RoomVoiceState } from './voice-controller';
import { ChatController, Toast, ToastKind } from './chat-controller';
import { NotificationsHub, AgentNotice } from './notifications-hub';
import { HudPeers } from './hud-peers';
import { sceneControls } from './focus-screen';
import { DESK_NAME, slug } from './chat-mentions';

/** What the widget lends the HUD. Getters only; the HUD owns no terminals, rooms or microphones. */
export interface HudHost {
    presenceService: Pick<OmoPresenceService, 'say' | 'takeChat' | 'setColour'>;
    presence(): PresenceState;
    scene(): RoomScene | undefined;
    layout(): RoomLayoutId;
    desk(desk: DeskId): { state: RuntimeConsoleState; controller?: RuntimeConsoleController };
    activeDesk(): DeskId | 'web' | string;
    /** Agent tabs (from the voice lane's roster). */
    agents(): AgentPresence[];
    /** Existing room voice state (read only). */
    voice(): RoomVoiceState | undefined;
    /** Choose the desk that receives keys and frame its screen. Opens/starts nothing new. */
    goToDesk(desk: DeskId): void;
    onChange(): void;
}

export interface SpeakingEntry { key: string; name: string; colour?: PresenceColour; who: 'self' | 'peer' | 'agent' }
export interface HudView {
    joined: boolean;
    selfId?: string;
    members: RoomMember[];
    following?: string;
    toasts: Toast[];
    notices: AgentNotice[];
    unreadNotices: number;
    speaking: SpeakingEntry[];
}

const TOAST_MS = 5000;
const TOAST_MAX = 4;
let toastSeq = 0;

/**
 * The multiplayer + agent HUD: room chat, join/leave toasts, agent notifications with
 * jump-to-desk, follow/teleport, name colours and who-is-speaking.
 */
export class HudHub {
    readonly chat: ChatController;
    readonly notices: NotificationsHub;
    readonly peers: HudPeers;
    private toasts: Toast[] = [];
    private known = new Map<string, RoomMember>();
    private roomKey = '';
    private timer = 0;
    private view: HudView;
    private version = '';
    private listeners: Array<() => void> = [];
    private disposed = false;
    /** Called by the overlay to focus the chat box (Enter or / while walking). */
    focusChat?: (prefill?: string) => void;

    constructor(private host: HudHost) {
        this.peers = new HudPeers(() => host.scene(), () => host.layout());
        this.chat = new ChatController({
            service: host.presenceService, room: () => this.room(), desk: desk => host.desk(desk),
            toast: (kind, text, colour) => this.toast(kind, text, colour), emote: (id, emote) => this.emote(id, emote),
            command: (name, arg) => this.command(name, arg), onChange: () => this.changed()
        });
        this.notices = new NotificationsHub({
            desk: desk => host.desk(desk).state, agents: () => host.agents(), now: () => Date.now(),
            watching: () => this.watching()
        }, notice => this.toast('info', notice.text, undefined, notice.kind === 'approval' ? 'alert' : notice.kind === 'finished' ? 'check' : 'bell'));
        this.view = this.compute();
        this.bindKeys();
        this.timer = window.setInterval(() => this.tick(), 250);
    }

    get state(): HudView { return this.view; }
    room(): RoomSnapshot | undefined { const p = this.host.presence(); return p.phase === 'joined' ? p.snapshot : undefined; }

    private canvas(): HTMLCanvasElement | undefined { return sceneControls(this.host.scene())?.element; }
    private watching(): DeskId | undefined {
        const c = sceneControls(this.host.scene()); const active = this.host.activeDesk();
        if (active !== 'terminal' && active !== 'terminal-2') return undefined;
        return c && (c.typing || c.attached) ? active : undefined;
    }

    private bindKeys(): void {
        // Enter or / while walking (world focused, not typing on a monitor) opens chat, like Minecraft's T.
        const down = (event: KeyboardEvent): void => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const c = sceneControls(this.host.scene());
            if (!c?.enabled || document.activeElement !== c.element || c.typing || c.cameraOwned) return;
            if (event.key === 'Enter' || event.key === '/') { event.preventDefault(); event.stopImmediatePropagation(); this.chat.setOpen(true); this.focusChat?.(event.key === '/' ? '/' : ''); return; }
            // Taking the controls back (any walking key) ends follow at once; the key still walks.
            if (this.peers.following && ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(event.key.toLowerCase())) this.follow(undefined);
        };
        window.addEventListener('keydown', down, true);
        this.listeners.push(() => window.removeEventListener('keydown', down, true));
    }

    toast(kind: ToastKind, text: string, colour?: PresenceColour, icon?: Toast['icon']): void {
        const now = Date.now();
        this.toasts = [...this.toasts.filter(t => now - t.at < TOAST_MS), { id: `t${++toastSeq}`, kind, text, at: now, colour, icon }].slice(-TOAST_MAX);
        this.changed();
    }
    dismissToast(id: string): void { this.toasts = this.toasts.filter(t => t.id !== id); this.changed(); }

    private emote(memberId: string, emote: ChatEmote): void { this.peers.emote(memberId, emote); }

    private findMember(arg: string): RoomMember | undefined | 'many' {
        const room = this.room(); if (!room) return undefined;
        const want = slug(arg.replace(/^@/, ''));
        const others = room.members.filter(m => m.id !== room.selfId);
        const exact = others.filter(m => slug(m.name) === want);
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) return 'many';
        const prefix = others.filter(m => slug(m.name).startsWith(want));
        return prefix.length === 1 ? prefix[0] : prefix.length > 1 ? 'many' : undefined;
    }
    private command(name: 'follow' | 'tp' | 'unfollow', arg: string): string {
        if (name === 'unfollow') { const was = this.peers.following; this.follow(undefined); return was ? 'Stopped following.' : 'You are not following anyone.'; }
        if (!this.room()) return 'Join a shared room first.';
        if (!arg) return `Usage: /${name} <name>`;
        const member = this.findMember(arg);
        if (member === 'many') return `More than one person matches “${arg}”. Type more of the name.`;
        if (!member) return `No one called “${arg}” is in this room.`;
        return name === 'tp' ? this.teleport(member.id) : this.follow(member.id);
    }
    teleport(id: string): string {
        const member = this.room()?.members.find(m => m.id === id);
        if (!member) return 'That person left the room.';
        const text = this.peers.teleportTo(member); this.toast('info', text); return text;
    }
    follow(id: string | undefined): string {
        const member = id ? this.room()?.members.find(m => m.id === id) : undefined;
        if (id && !member) return 'That person left the room.';
        this.peers.follow(member?.id);
        this.peers.paint(this.room()?.members ?? []);
        const text = member ? `Following ${member.name}. Press W/A/S/D or Esc to stop.` : 'Stopped following.';
        this.toast('info', text); this.changed();
        return text;
    }
    /** Jump to the desk a notice is about: stand at the desk, choose it, frame its screen. */
    jump(notice: AgentNotice): void {
        this.follow(undefined);
        this.peers.jumpToDesk(notice.desk);
        this.host.goToDesk(notice.desk);
        if (notice.kind === 'bell') this.host.desk(notice.desk).controller?.acknowledgeBells();
        this.notices.markRead(notice.id);
        this.toast('info', `At ${DESK_NAME[notice.desk]}. Nothing was typed or started.`);
        this.changed();
    }
    markAllRead(): void { this.notices.markRead(); this.changed(); }
    clearNotices(): void { this.notices.clear(); this.changed(); }

    /** Room membership diff → join/leave toasts and chat lines. */
    sync(): void {
        const room = this.room();
        const key = room ? `${room.roomId}:${room.selfId}` : '';
        if (key !== this.roomKey) {
            this.roomKey = key; this.known.clear();
            if (room) for (const m of room.members) this.known.set(m.id, m);
            else this.follow(undefined);
        } else if (room) {
            const now = new Map(room.members.map(m => [m.id, m] as const));
            for (const [id, m] of now) if (!this.known.has(id)) { this.toast('join', `${m.name} joined the room`, m.colour); this.chat.system(`${m.name} joined the room.`); }
            for (const [id, m] of this.known) if (!now.has(id)) { this.toast('leave', `${m.name} left the room`, m.colour); this.chat.system(`${m.name} left the room.`); if (this.peers.following === id) this.follow(undefined); }
            this.known = now;
        }
        if (room) this.peers.paint(room.members);
    }

    private tick(): void {
        if (this.disposed) return;
        this.sync();
        this.notices.tick();
        const room = this.room();
        if (room && this.peers.following) {
            if (this.peers.step(room.members) === 'gone') this.toast('info', 'The person you followed left. Follow stopped.');
        }
        this.changed();
    }

    private compute(): HudView {
        const room = this.room();
        const now = Date.now();
        this.toasts = this.toasts.filter(t => now - t.at < TOAST_MS);
        const speaking: SpeakingEntry[] = [];
        const voice = this.host.voice();
        const self = room?.members.find(m => m.id === room.selfId);
        if (voice?.phase === 'on' && voice.transmitting && voice.speaking) speaking.push({ key: 'self', name: `${self?.name ?? 'You'} (you)`, colour: self?.colour, who: 'self' });
        if (room) for (const m of room.members) if (m.id !== room.selfId && m.voice?.speaking) speaking.push({ key: m.id, name: m.name, colour: m.colour, who: 'peer' });
        for (const a of this.host.agents()) if (a.speaking) speaking.push({ key: a.key, name: `${a.label} (read-aloud)`, who: 'agent' });
        return { joined: !!room, selfId: room?.selfId, members: room?.members ?? [], following: this.peers.following, toasts: [...this.toasts],
            notices: [...this.notices.items], unreadNotices: this.notices.unread, speaking };
    }
    private changed(): void {
        if (this.disposed) return;
        this.view = this.compute();
        const version = JSON.stringify({ ...this.view, members: this.view.members.map(m => [m.id, m.name, m.colour, !!m.voice?.speaking]) }) + JSON.stringify(this.chat.state);
        if (version !== this.version) { this.version = version; this.host.onChange(); }
        const canvas = this.canvas();
        if (canvas) canvas.dataset.hudFollowing = this.peers.following ?? '';
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        window.clearInterval(this.timer);
        this.listeners.forEach(fn => fn()); this.listeners = [];
        this.chat.dispose(); this.peers.dispose();
    }
}

import * as THREE from 'three';
import type { OmoPresenceService, RoomMember } from '../common/presence-protocol';
import type { PlayerPose, RoomLayoutId } from '../common/player-state';
import { PLAYER_HOME } from '../common/player-state';
import type { RuntimeConsoleController, RuntimeConsoleState } from './runtime-console-controller';
import type { PresenceState } from './presence-controller';
import { RoomVoiceController, RoomVoiceState, browserVoiceMedia, VoiceStorage } from './voice-controller';
import { VoiceSignalTransport, localPresenceTransport } from '../common/voice-transport';
import type { OmoVoiceSettingsService } from '../common/voice-settings-protocol';
import { DictationController, DictationState, recognitionCtor } from './voice-dictation';
import { ReadAloud, replyText } from './voice-readaloud';
import { AgentAvatars, AgentPresence, DeskId, agentLabel, aimedDesk, deskAgents } from './agent-avatars';

/** What the widget lends the hub. Read-only getters; the hub never owns terminals or rooms. */
export interface VoiceHubHost {
    presenceService: Pick<OmoPresenceService, 'setVoice' | 'signal' | 'takeSignals'>;
    /** Backend STUN/TURN settings (Theia config dir). Optional: without it voice uses public STUN. */
    voiceSettings?: OmoVoiceSettingsService;
    presence(): PresenceState;
    /** The live RoomScene instance (or undefined while the scene is rebuilt). */
    scene(): unknown;
    layout(): RoomLayoutId;
    desk(desk: DeskId): { state: RuntimeConsoleState; controller?: RuntimeConsoleController };
    activeDesk(): DeskId;
    onChange(): void;
    message(text: string): void;
}

export interface VoiceHubView {
    voice: RoomVoiceState;
    dictation: DictationState;
    readAloud: { supported: boolean; enabled: boolean; speaking?: string };
    agents: AgentPresence[];
    aimed?: DeskId;
    joined: boolean;
    supported: boolean;
}

const QUIET_MS = 2500;
const OFF_STATE: RoomVoiceState = { phase: 'off', mode: 'push', muted: false, transmitting: false, pushHeld: false, speaking: false, level: 0, proximity: true, spatial: true, spatialSupported: false, peers: [],
    prefs: { inputId: '', outputId: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true, mode: 'push', proximity: true, spatial: true, people: {} },
    devices: { inputs: [], outputs: [], outputSelectable: false }, transport: 'local-presence', network: { hasTurn: false, relayOnly: false, stunServers: 0 }, error: '', notice: '' };
function voiceStorage(): VoiceStorage | undefined {
    try { const s = window.localStorage; return { get: k => s.getItem(k), set: (k, v) => s.setItem(k, v) }; } catch { return undefined; }
}
const DESKS: DeskId[] = ['terminal', 'terminal-2'];
const DESK_NAME: Record<DeskId, string> = { terminal: 'Desk one', 'terminal-2': 'Desk two' };

/** armedUntil: read-aloud waits for the reply to a dictated draft on this desk, until this time. */
interface DeskWatch { screen: string; changedAt: number; tabId?: string; quietLines: string[]; working: boolean; armedUntil: number; draft: string }

/**
 * Voice and agent presence for the Omo world.
 * Safety: microphone only after a click + browser permission; push-to-talk by default; audio only
 * to voice-enabled peers in the same room; dictation is on-device and lands as a draft without
 * Enter; read-aloud is opt-in and on-device; no agent is started, woken or sent a key.
 */
export class VoiceHub {
    readonly voice?: RoomVoiceController;
    readonly dictation: DictationController;
    readonly readAloud: ReadAloud;
    private avatars = new AgentAvatars();
    private view: VoiceHubView;
    private timer = 0;
    private sceneRef?: unknown;
    private layoutRef?: RoomLayoutId;
    private watch: Record<DeskId, DeskWatch> = { terminal: { screen: '', changedAt: 0, quietLines: [], working: false, armedUntil: 0, draft: '' }, 'terminal-2': { screen: '', changedAt: 0, quietLines: [], working: false, armedUntil: 0, draft: '' } };
    private listeners: Array<() => void> = [];
    private dictating?: DeskId;
    private version = '';
    private disposed = false;
    private readonly localTransport: VoiceSignalTransport;

    constructor(private host: VoiceHubHost) {
        const media = browserVoiceMedia();
        this.localTransport = localPresenceTransport(host.presenceService);
        const settings = host.voiceSettings;
        if (media) this.voice = new RoomVoiceController({ transport: this.localTransport, media, pose: () => this.pose(), storage: voiceStorage(),
            iceConfig: settings ? () => settings.iceConfig() : undefined,
            schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: id => window.clearTimeout(id as number), onChange: () => this.changed() });
        // A network change (Wi-Fi switch, VPN, sleep/wake) restarts ICE on every link at once.
        const online = (): void => this.voice?.restartAll();
        window.addEventListener('online', online);
        this.listeners.push(() => window.removeEventListener('online', online));
        this.dictation = new DictationController({ ctor: recognitionCtor(), onChange: () => this.changed() });
        this.readAloud = new ReadAloud(typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis, () => this.changed());
        this.view = this.compute();
        this.bindKeys();
        this.timer = window.setInterval(() => this.tick(), 250);
    }

    get state(): VoiceHubView { return this.view; }
    get settings(): OmoVoiceSettingsService | undefined { return this.host.voiceSettings; }

    /**
     * Multiplayer hook (mp-client lane): run room voice over the remote room server instead of local
     * presence. Pass `remoteRoomVoiceTransport(channel)`; pass undefined to go back to local presence.
     * Voice turns off when the transport changes; the user turns it on again with a click.
     */
    async useTransport(transport: VoiceSignalTransport | undefined): Promise<void> {
        await this.voice?.setTransport(transport ?? this.localTransport);
        this.changed();
    }

    private pose(): PlayerPose {
        const scene = this.host.scene() as { getPlayerPose?(): PlayerPose } | undefined;
        return scene?.getPlayerPose?.() ?? { ...PLAYER_HOME };
    }
    private canvas(): HTMLCanvasElement | undefined {
        const scene = this.host.scene() as { renderer?: { domElement?: HTMLCanvasElement } } | undefined;
        const el = scene?.renderer?.domElement;
        return el instanceof HTMLCanvasElement ? el : undefined;
    }
    /** RoomScene keeps its THREE.Scene private; read it without changing room-scene.ts. */
    private threeScene(): THREE.Scene | undefined {
        const scene = (this.host.scene() as { scene?: unknown } | undefined)?.scene;
        return scene instanceof THREE.Scene ? scene : undefined;
    }

    private bindKeys(): void {
        const editable = (el: Element | null): boolean => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);
        // Only while the 3D world has focus and the player is walking (not typing into a monitor).
        const walking = (): boolean => { const c = this.canvas(); return !!c && document.activeElement === c && c.dataset.typing !== 'true' && !editable(document.activeElement); };
        const down = (event: KeyboardEvent): void => {
            if (event.ctrlKey || event.metaKey || event.altKey || !walking()) return;
            const key = event.key.toLowerCase();
            if (key === 'v' && this.voice && this.voice.state.phase === 'on') { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) this.voice.setPushHeld(true); }
            else if (key === 'm' && this.voice && this.voice.state.phase === 'on') { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) this.voice.toggleMuted(); }
            else if (key === 't' && this.dictation.state.phase !== 'off' && this.dictation.state.phase !== 'error') { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) this.startDictation(this.aimed()); }
        };
        const up = (event: KeyboardEvent): void => {
            const key = event.key.toLowerCase();
            if (key === 'v' && this.voice?.state.pushHeld) { event.stopImmediatePropagation(); this.voice.setPushHeld(false); }
            if (key === 't' && this.dictating) { event.stopImmediatePropagation(); this.finishDictation(); }
        };
        const blur = (): void => { this.voice?.setPushHeld(false); if (this.dictating) { this.dictating = undefined; this.dictation.cancel(); } };
        // Registered at widget start, before the scene's own window-capture listeners, so V/T/M
        // are consumed here and never reach movement or a terminal.
        window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', blur);
        this.listeners.push(() => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); });
    }

    /** The desk the first-person player looks at; undefined in overview or when looking elsewhere. */
    aimed(): DeskId | undefined {
        const c = this.canvas();
        if (!c || !c.dataset.playerX) return undefined;
        const scene = this.host.scene() as { navigation?: string } | undefined;
        if (scene?.navigation && scene.navigation !== 'walk') return undefined;
        return aimedDesk(this.pose(), this.host.layout());
    }

    /** Begin dictation into `desk` (user gesture: key or button down). */
    startDictation(desk: DeskId | undefined): void {
        if (!desk) { this.host.message('Look at an agent monitor (Desk one or Desk two) and hold T to dictate.'); return; }
        const { controller, state } = this.host.desk(desk);
        const target = controller?.taskTarget();
        const tab = state.workspace?.tabs.find(t => t.id === state.activeTabId);
        if (!controller || !target || !tab || tab.kind === 'shell') { this.host.message(`${DESK_NAME[desk]} has no live agent tab on screen. Open a Hermes, Claude Code or Codex tab there first. Nothing was started.`); return; }
        const label = `${agentLabel(tab.kind, tab.name)} (${DESK_NAME[desk]})`;
        this.readAloud.stop();
        const started = this.dictation.begin(label, async text => {
            const ok = await controller.prepareTask(target, text);
            if (!ok) throw new Error(controller.state.error || 'the agent tab changed, so nothing was typed');
            const w = this.watch[desk]; w.armedUntil = Date.now() + 5 * 60_000; w.draft = text;
            this.host.message(`Draft placed in ${label}. Review it, then press Enter on the monitor to send. Enter was not pressed.`);
        });
        if (started) this.dictating = desk;
    }
    finishDictation(): void { this.dictating = undefined; this.dictation.finish(); }

    setReadAloud(on: boolean): void { this.host.message(this.readAloud.setEnabled(on)); }

    private changed(): void {
        if (this.disposed) return;
        this.view = this.compute();
        const version = JSON.stringify(this.view);
        if (version !== this.version) { this.version = version; this.host.onChange(); }
    }

    private compute(): VoiceHubView {
        const presence = this.host.presence();
        const now = Date.now();
        const agents: AgentPresence[] = [];
        for (const desk of DESKS) {
            const { state } = this.host.desk(desk);
            const working = now - this.watch[desk].changedAt < QUIET_MS;
            for (const agent of deskAgents(desk, state.workspace?.tabs, state.activeTabId, working)) {
                agent.speaking = this.readAloud.speakingKey === agent.key;
                agents.push(agent);
            }
        }
        return {
            voice: this.voice?.state ?? OFF_STATE,
            dictation: this.dictation.state,
            readAloud: { supported: this.readAloud.supported, enabled: this.readAloud.enabled, speaking: this.readAloud.speakingKey },
            agents, aimed: this.aimed(), joined: presence.phase === 'joined' && !!presence.snapshot, supported: !!this.voice
        };
    }

    private tick(): void {
        if (this.disposed) return;
        const presence = this.host.presence();
        // Local presence supplies the roster here; a remote-room transport supplies its own.
        if (this.voice && this.voice.transportKind === 'local-presence') this.voice.roomChanged(presence.phase === 'joined' ? presence.snapshot : undefined);
        else this.voice?.pullRoster();
        // Re-attach avatars when the RoomScene is rebuilt (theme/layout/kit change).
        const scene = this.host.scene(), layout = this.host.layout();
        if (scene !== this.sceneRef || layout !== this.layoutRef) { this.sceneRef = scene; this.layoutRef = layout; this.avatars.attach(this.threeScene(), layout, this.canvas()); }
        this.watchDesks();
        this.view = this.compute();
        this.avatars.setAgents(this.view.agents);
        this.avatars.setPeers(this.peerIndicators(presence));
        const version = JSON.stringify(this.view);
        if (version !== this.version) { this.version = version; this.host.onChange(); }
    }

    /** Voice peers for in-world rings: local presence snapshot, or the remote room roster. */
    private peerIndicators(presence: PresenceState): Array<{ id: string; name: string; pose: PlayerPose; speaking: boolean; muted: boolean }> {
        const snap = presence.phase === 'joined' ? presence.snapshot : undefined;
        if (!snap) return [];
        return snap.members.filter((m: RoomMember) => m.id !== snap.selfId && m.voice).map(m => ({ id: m.id, name: m.name, pose: m.pose, speaking: !!m.voice!.speaking, muted: !!m.voice!.muted }));
    }

    /** Screen-change activity per desk, and read-aloud of new reply text once an agent goes quiet. */
    private watchDesks(): void {
        const now = Date.now();
        for (const desk of DESKS) {
            const { state } = this.host.desk(desk);
            const w = this.watch[desk];
            const tab = state.workspace?.tabs.find(t => t.id === state.activeTabId);
            // Screen content, not the frame counter: a re-attached view restarts its sequence.
            const screen = state.lines.join('\n');
            // A different tab resets everything. A brief re-attach (clicking the monitor) only pauses.
            if (!tab || tab.id !== w.tabId) { w.tabId = tab?.id; w.screen = screen; w.quietLines = [...state.lines]; w.working = false; w.changedAt = 0; w.armedUntil = 0; continue; }
            if (state.phase !== 'live' || !state.lines.length) continue;
            if (screen !== w.screen) { if (!w.working) w.quietLines = w.screen ? w.screen.split('\n') : w.quietLines; w.screen = screen; w.changedAt = now; w.working = true; continue; }
            if (w.working && now - w.changedAt >= QUIET_MS) {
                w.working = false;
                // Read only the reply to a dictated message, never what the user types by hand.
                if (tab.kind !== 'shell' && this.readAloud.enabled && !this.dictating && now < w.armedUntil) {
                    const text = replyText(w.quietLines, state.lines, [w.draft]);
                    if (text.length >= 2) { try { this.readAloud.speak(`${desk}:${tab.id}`, text); } catch (error) { this.host.message(`Read-aloud failed: ${String(error)}`); } w.armedUntil = 0; }
                }
                w.quietLines = [...state.lines];
            }
        }
    }

    dispose(): void {
        if (this.disposed) return;
        window.clearInterval(this.timer);
        this.listeners.forEach(fn => fn()); this.listeners = [];
        this.dictation.dispose(); this.readAloud.stop();
        void this.voice?.dispose();
        this.avatars.dispose();
        this.disposed = true;
    }
}

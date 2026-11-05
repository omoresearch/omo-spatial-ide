import * as THREE from 'three';
import type { AgentKind, SessionTab } from '../common/runtime-protocol';
import { ROOM_LAYOUTS } from '../common/player-state';
import type { PlayerPose, RoomLayoutId } from '../common/player-state';

/**
 * In-world agent presence and voice indicators.
 *
 * This module owns its own THREE objects and adds them to the RoomScene's THREE.Scene.
 * It never edits room-scene.ts. Agents shown here are ONLY tabs that already run on a desk;
 * nothing here starts, wakes or types into an agent.
 */

export type DeskId = 'terminal' | 'terminal-2';
export type AgentActivity = 'working' | 'idle' | 'background' | 'sleeping' | 'interrupted' | 'exited';
export interface AgentPresence {
    key: string;
    desk: DeskId;
    kind: Exclude<AgentKind, 'shell'>;
    tabName: string;
    label: string;
    activity: AgentActivity;
    /** True while read-aloud is speaking this agent's reply. */
    speaking?: boolean;
}
export interface VoiceIndicator { id: string; name: string; pose: PlayerPose; speaking: boolean; muted: boolean }

export const AGENT_KIND_LABEL: Record<Exclude<AgentKind, 'shell'>, string> = { hermes: 'Hermes', claude: 'Claude', codex: 'Codex' };
const KIND_COLOR: Record<Exclude<AgentKind, 'shell'>, number> = { hermes: 0xe9b949, claude: 0xe07a45, codex: 0x4f8fe8 };
const ACTIVITY_COLOR: Record<AgentActivity, string> = { working: '#ffcf5a', idle: '#7fe0a4', background: '#b9c6d6', sleeping: '#9aa7b8', interrupted: '#ff6b6b', exited: '#9aa7b8' };
const ACTIVITY_TEXT: Record<AgentActivity, string> = { working: 'working', idle: 'idle', background: 'running · other tab', sleeping: 'asleep', interrupted: 'interrupted', exited: 'ended' };

/** "Hermes · Research" — the mod pack's name-tag convention, with the tab name. */
export function agentLabel(kind: Exclude<AgentKind, 'shell'>, tabName: string): string {
    const base = AGENT_KIND_LABEL[kind];
    const tab = tabName.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, 24);
    return !tab || tab.toLowerCase() === base.toLowerCase() || tab.toLowerCase() === `${base.toLowerCase()} code` ? base : `${base} · ${tab}`;
}

/**
 * Agent tabs on one desk, from runtime metadata. For the tab on screen, "working" means its screen
 * changed in the last moments (an agent CLI is always the pane's foreground process, so the
 * runtime's busy flag cannot tell working from idle). Tabs not on screen are only "running".
 */
export function deskAgents(desk: DeskId, tabs: SessionTab[] | undefined, activeTabId: string | undefined, screenWorking: boolean): AgentPresence[] {
    return (tabs ?? []).filter((tab): tab is SessionTab & { kind: Exclude<AgentKind, 'shell'> } => tab.kind !== 'shell').map(tab => {
        const activity: AgentActivity = tab.state === 'sleeping' ? 'sleeping' : tab.state === 'interrupted' ? 'interrupted' : tab.state === 'exited' ? 'exited'
            : tab.id === activeTabId ? (screenWorking ? 'working' : 'idle') : 'background';
        return { key: `${desk}:${tab.id}`, desk, kind: tab.kind, tabName: tab.name, label: agentLabel(tab.kind, tab.name), activity };
    });
}

/** Screen-centre of a desk monitor in world space (matches RoomScene.desk geometry). */
export function deskScreen(desk: DeskId, layout: RoomLayoutId): { x: number; y: number; z: number } {
    const d = ROOM_LAYOUTS[layout].desks[desk];
    return { x: d.x, y: 1.99, z: d.z - 0.296 };
}

/**
 * Where an agent stands: at the OUTER end of its desk (never between the player and the
 * monitor), turned to face the screen. Extra agents on the same desk queue behind.
 */
export function agentSpot(layout: RoomLayoutId, desk: DeskId, slot: number): { x: number; z: number; yaw: number } {
    const d = ROOM_LAYOUTS[layout].desks[desk];
    const side = d.x < 0 ? -1 : 1;
    const x = Math.max(-5.4, Math.min(5.4, d.x + side * (2.05 + Math.floor(slot / 2) * 0.55)));
    const z = Math.max(-3.7, Math.min(4.3, d.z + 0.2 + (slot % 2) * 0.6));
    const s = deskScreen(desk, layout);
    return { x, z, yaw: Math.atan2(-(s.x - x), -(s.z - z)) };
}

/** Which desk monitor the first-person player is looking at, if any (distance and angle bounded). */
export function aimedDesk(pose: PlayerPose, layout: RoomLayoutId, maxDistance = 4.5, maxAngle = 0.42): DeskId | undefined {
    const forward = { x: -Math.sin(pose.yaw) * Math.cos(pose.pitch), y: Math.sin(pose.pitch), z: -Math.cos(pose.yaw) * Math.cos(pose.pitch) };
    let best: { desk: DeskId; angle: number } | undefined;
    for (const desk of ['terminal', 'terminal-2'] as DeskId[]) {
        const s = deskScreen(desk, layout);
        const v = { x: s.x - pose.x, y: s.y - 1.75, z: s.z - pose.z };
        const length = Math.hypot(v.x, v.y, v.z);
        if (length > maxDistance || length < 0.05) continue;
        const angle = Math.acos(Math.max(-1, Math.min(1, (v.x * forward.x + v.y * forward.y + v.z * forward.z) / length)));
        if (angle <= maxAngle && (!best || angle < best.angle)) best = { desk, angle };
    }
    return best?.desk;
}

function tagTexture(lines: Array<{ text: string; color: string; size: number }>, accent: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#0d141ee8'; c.fillRect(0, 0, 512, 128);
    c.fillStyle = accent; c.fillRect(0, 0, 8, 128);
    c.textAlign = 'center';
    let y = lines.length === 1 ? 76 : 54;
    for (const line of lines) { c.font = `${line.size}px sans-serif`; c.fillStyle = line.color; c.fillText(line.text, 260, y, 480); y += line.size + 12; }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

function disposeTree(root: THREE.Object3D): void {
    root.traverse(node => {
        if (node instanceof THREE.Mesh) { node.geometry.dispose(); (Array.isArray(node.material) ? node.material : [node.material]).forEach(m => m.dispose()); }
        if (node instanceof THREE.Sprite) { node.material.map?.dispose(); node.material.dispose(); }
    });
}

/** Where agents enter and leave the room: the doorway in the back corner by the player's start. */
export const AGENT_DOOR = { x: 4.6, z: 4.25 };
/** Walking speed in metres per second. */
const WALK_SPEED = 1.5;
/** Agents that appear this soon after attach (page load, scene rebuilt) are placed at the desk, not walked in. */
const ATTACH_GRACE_MS = 1500;

type WalkMode = 'desk' | 'entering' | 'leaving' | 'away';
interface AgentBody {
    root: THREE.Group; body: THREE.Group; tag: THREE.Sprite; ring: THREE.Mesh; legs: [THREE.Mesh, THREE.Mesh];
    tagKey: string; presence: AgentPresence; baseY: number; slot: string;
    /** Walk state: 'entering' walks door → desk; 'leaving' walks to the door, then is removed (closed tab) or hidden as 'away' (asleep). */
    mode: WalkMode; target: { x: number; z: number; yaw: number }; stride: number;
}

/**
 * Optional hooks a host scene puts on `scene.userData.omoAmbient` so ambient modules join its single
 * render loop instead of running their own. RoomScene provides them.
 */
export interface AmbientHost {
    /** Register a per-frame tick. It returns true while it still animates (the host keeps drawing). */
    add(tick: (seconds: number) => boolean): () => void;
    /** Something changed outside a tick: draw one frame. `shadows` also refreshes the shadow map. */
    invalidate(shadows?: boolean): void;
}
export function ambientHost(scene: THREE.Scene | undefined): AmbientHost | undefined {
    const host = scene?.userData.omoAmbient as AmbientHost | undefined;
    return host && typeof host.add === 'function' && typeof host.invalidate === 'function' ? host : undefined;
}
interface PeerMark { root: THREE.Group; ring: THREE.Mesh; icon: THREE.Sprite; state: string }

/** Asleep agents wait outside the room; they walk back in when the tab wakes. */
function asleep(activity: AgentActivity): boolean { return activity === 'sleeping'; }

/** Owns agent avatars and voice rings. Attach to a RoomScene's THREE.Scene; re-attach after the scene is rebuilt. */
export class AgentAvatars {
    private scene?: THREE.Scene;
    private canvas?: HTMLCanvasElement;
    private group = new THREE.Group();
    private agents = new Map<string, AgentBody>();
    private peers = new Map<string, PeerMark>();
    private layout: RoomLayoutId = 'classic';
    private frame = 0;
    private agentList: AgentPresence[] = [];
    private peerList: VoiceIndicator[] = [];
    private host?: AmbientHost;
    private untick?: () => void;
    private published = { agents: '', peers: '' };
    /** Bodies of closed tabs walking out of the room; removed when they reach the door. */
    private leaving = new Set<AgentBody>();
    private attachedAt = 0;
    private lastTick = 0;

    constructor() { this.group.name = 'omo-agent-avatars'; }

    attach(scene: THREE.Scene | undefined, layout: RoomLayoutId, canvas?: HTMLCanvasElement): void {
        if (scene === this.scene && layout === this.layout) return;
        this.detach();
        this.scene = scene; this.layout = layout; this.canvas = canvas; this.published = { agents: '', peers: '' };
        if (!scene) return;
        this.group = new THREE.Group(); this.group.name = 'omo-agent-avatars';
        scene.add(this.group);
        this.host = ambientHost(scene);
        this.attachedAt = performance.now(); this.lastTick = 0;
        this.setAgents(this.agentList); this.setPeers(this.peerList);
        // Join the host's single render loop. Without a host, fall back to an own loop.
        if (this.host) this.untick = this.host.add(seconds => this.tick(seconds));
        else { const animate = (): void => { this.tick(performance.now() / 1000); this.frame = requestAnimationFrame(animate); }; this.frame = requestAnimationFrame(animate); }
    }
    detach(): void {
        cancelAnimationFrame(this.frame); this.frame = 0;
        this.untick?.(); this.untick = undefined;
        const host = this.host; this.host = undefined;
        for (const agent of this.agents.values()) disposeTree(agent.root);
        for (const peer of this.peers.values()) disposeTree(peer.root);
        for (const agent of this.leaving) disposeTree(agent.root);
        this.leaving.clear();
        const had = this.group.children.length > 0;
        this.agents.clear(); this.peers.clear();
        this.scene?.remove(this.group); this.scene = undefined;
        if (had) host?.invalidate(true);
    }
    /** Draw one frame after a visible change (no-op without a host: the own loop draws nothing itself). */
    private changed(shadows: boolean): void { this.host?.invalidate(shadows); }

    setAgents(list: AgentPresence[]): void {
        this.agentList = list;
        if (!this.scene) return;
        let moved = false, redraw = false;
        const keep = new Set(list.map(a => a.key));
        // A closed tab's agent walks out of the door (removed in tick when it gets there).
        for (const [key, agent] of this.agents) if (!keep.has(key)) { this.agents.delete(key); this.walkOut(agent); moved = true; }
        const placeDirect = performance.now() - this.attachedAt < ATTACH_GRACE_MS;
        const perDesk: Record<DeskId, number> = { terminal: 0, 'terminal-2': 0 };
        for (const presence of list) {
            const slot = perDesk[presence.desk]++;
            let agent = this.agents.get(presence.key);
            if (!agent || agent.presence.kind !== presence.kind) {
                if (agent) { this.group.remove(agent.root); disposeTree(agent.root); }
                agent = this.build(presence); this.agents.set(presence.key, agent); this.group.add(agent.root); moved = true;
                if (placeDirect && asleep(presence.activity)) { agent.mode = 'away'; agent.root.visible = false; }
                else if (!placeDirect && !asleep(presence.activity)) this.walkIn(agent);
                else if (!placeDirect) { agent.mode = 'away'; agent.root.visible = false; }
            } else if (!placeDirect && asleep(agent.presence.activity) !== asleep(presence.activity)) {
                // Falls asleep: walks out and waits outside. Wakes: walks back in from the door.
                if (asleep(presence.activity)) this.walkOut(agent, false); else this.walkIn(agent);
                moved = true;
            } else if (placeDirect && asleep(presence.activity) && agent.mode === 'desk') {
                agent.mode = 'away'; agent.root.visible = false;
            } else if (placeDirect && !asleep(presence.activity) && agent.mode === 'away') {
                agent.mode = 'desk'; agent.root.visible = true;
            }
            const was = agent.presence;
            agent.presence = presence;
            const slotKey = `${presence.desk}:${slot}`;
            if (slotKey !== agent.slot) {
                agent.slot = slotKey; moved = true;
                const at = agentSpot(this.layout, presence.desk, slot);
                agent.target = at; agent.baseY = 0;
                if (agent.mode === 'desk' || agent.mode === 'away') { agent.root.position.set(at.x, 0, at.z); agent.root.rotation.y = at.yaw; }
            }
            if (was.activity !== presence.activity || !!was.speaking !== !!presence.speaking) redraw = true;
            const tagKey = `${presence.label}|${presence.activity}|${presence.speaking ? 1 : 0}`;
            if (tagKey !== agent.tagKey) {
                redraw = true;
                agent.tag.material.map?.dispose();
                const accent = `#${KIND_COLOR[presence.kind].toString(16).padStart(6, '0')}`;
                agent.tag.material.map = tagTexture([{ text: presence.label, color: '#f4efe3', size: 36 }, { text: `● ${ACTIVITY_TEXT[presence.activity]}${presence.speaking ? ' · speaking' : ''}`, color: ACTIVITY_COLOR[presence.activity], size: 26 }], accent);
                agent.tag.material.needsUpdate = true; agent.tagKey = tagKey;
            }
        }
        if (moved || redraw) { this.pose(performance.now() / 1000); this.changed(moved); }
        this.publish();
    }

    setPeers(list: VoiceIndicator[]): void {
        this.peerList = list;
        if (!this.scene) return;
        let changed = false;
        const keep = new Set(list.map(p => p.id));
        for (const [id, mark] of this.peers) if (!keep.has(id)) { this.group.remove(mark.root); disposeTree(mark.root); this.peers.delete(id); changed = true; }
        for (const peer of list) {
            let mark = this.peers.get(peer.id);
            if (!mark) {
                changed = true;
                const root = new THREE.Group();
                const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 8, 32), new THREE.MeshBasicMaterial({ color: 0x5dff9d, transparent: true, opacity: 0.9 }));
                ring.rotation.x = Math.PI / 2; ring.position.y = 2.32; root.add(ring);
                const icon = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: true }));
                icon.position.y = 2.62; icon.scale.set(0.34, 0.34, 1); root.add(icon);
                mark = { root, ring, icon, state: '' };
                this.peers.set(peer.id, mark); this.group.add(root);
            }
            if (mark.root.position.x !== peer.pose.x || mark.root.position.z !== peer.pose.z) { mark.root.position.set(peer.pose.x, 0, peer.pose.z); changed = true; }
            const state = peer.muted ? 'muted' : peer.speaking ? 'speaking' : 'quiet';
            if (state !== mark.state) {
                mark.state = state; changed = true;
                mark.ring.visible = state === 'speaking';
                mark.icon.visible = state !== 'quiet';
                mark.icon.material.map?.dispose();
                const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
                const c = canvas.getContext('2d')!; c.fillStyle = state === 'muted' ? '#4a1f26' : '#163a29'; c.beginPath(); c.arc(32, 32, 30, 0, Math.PI * 2); c.fill();
                c.font = '34px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff'; c.fillText(state === 'muted' ? '✕' : '♪', 32, 34);
                mark.icon.material.map = new THREE.CanvasTexture(canvas); mark.icon.material.needsUpdate = true;
            }
        }
        if (changed) { this.pose(performance.now() / 1000); this.changed(false); }
        this.publish();
    }

    private build(presence: AgentPresence): AgentBody {
        const color = KIND_COLOR[presence.kind];
        const root = new THREE.Group(); root.name = `omo-agent-${presence.key}`;
        const body = new THREE.Group(); root.add(body);
        const mat = (c: number, emissive = 0): THREE.MeshStandardMaterial => { const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.15 }); if (emissive) { m.emissive.setHex(emissive); m.emissiveIntensity = 0.9; } return m; };
        const box = (size: [number, number, number], at: [number, number, number], m: THREE.Material): THREE.Mesh => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), m); mesh.position.set(...at); mesh.castShadow = true; body.add(mesh); return mesh; };
        box([0.42, 0.62, 0.28], [0, 1.0, 0], mat(color));
        box([0.36, 0.36, 0.36], [0, 1.52, 0], mat(0xd9d4c7));
        box([0.28, 0.08, 0.02], [0, 1.55, -0.19], mat(0x111111, color)); // visor faces the monitor (-z)
        const legs: [THREE.Mesh, THREE.Mesh] = [box([0.14, 0.5, 0.16], [-0.12, 0.45, 0], mat(0x2b3442)), box([0.14, 0.5, 0.16], [0.12, 0.45, 0], mat(0x2b3442))];
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.03, 8, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
        ring.rotation.x = Math.PI / 2; ring.position.y = 1.86; ring.visible = false; body.add(ring);
        const tag = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: true }));
        tag.position.y = 2.25; tag.scale.set(1.5, 0.375, 1); root.add(tag);
        return { root, body, tag, ring, legs, tagKey: '', presence, baseY: 0, slot: '', mode: 'desk', target: { x: 0, z: 0, yaw: 0 }, stride: 0 };
    }

    /** Start at the door and walk to the desk spot. */
    private walkIn(agent: AgentBody): void {
        if (agent.mode !== 'leaving') agent.root.position.set(AGENT_DOOR.x, 0, AGENT_DOOR.z); // turning back mid-walk keeps its place
        agent.mode = 'entering'; agent.root.visible = true;
        const slot = Number(agent.slot.split(':').pop() ?? 0);
        agent.target = agentSpot(this.layout, agent.presence.desk, Number.isFinite(slot) ? slot : 0);
        if (!this.host) this.arrive(agent);
    }
    /** Walk from wherever the agent is to the door. A closed tab (`remove`) is disposed there; a sleeping one is hidden. */
    private walkOut(agent: AgentBody, remove = true): void {
        agent.mode = 'leaving';
        agent.target = { x: AGENT_DOOR.x, z: AGENT_DOOR.z, yaw: agent.root.rotation.y };
        if (remove) { agent.presence = { ...agent.presence, speaking: false }; this.leaving.add(agent); }
        if (!this.host || !agent.root.visible) this.arrive(agent);
    }
    /** Finish a walk: settle at the desk, or vanish at the door. */
    private arrive(agent: AgentBody): void {
        const p = agent.root.position;
        p.set(agent.target.x, 0, agent.target.z);
        agent.root.rotation.y = agent.target.yaw;
        agent.legs[0].rotation.x = 0; agent.legs[1].rotation.x = 0; agent.stride = 0;
        if (agent.mode === 'leaving') {
            if (this.leaving.delete(agent)) { this.group.remove(agent.root); disposeTree(agent.root); return; }
            agent.mode = 'away'; agent.root.visible = false;
            const at = agentSpot(this.layout, agent.presence.desk, Number(agent.slot.split(':').pop() ?? 0) || 0);
            agent.target = at; p.set(at.x, 0, at.z); agent.root.rotation.y = at.yaw;
            return;
        }
        agent.mode = 'desk';
    }
    /** Move one walking agent by `delta` seconds. Returns true while it still walks. */
    private stepWalk(agent: AgentBody, delta: number): boolean {
        if (agent.mode !== 'entering' && agent.mode !== 'leaving') return false;
        const p = agent.root.position, dx = agent.target.x - p.x, dz = agent.target.z - p.z;
        const distance = Math.hypot(dx, dz), step = WALK_SPEED * delta;
        if (distance <= step || distance < 0.01) { this.arrive(agent); return false; }
        p.x += dx / distance * step; p.z += dz / distance * step;
        agent.root.rotation.y = Math.atan2(-dx, -dz); // body's front is -z
        agent.stride += delta * 9;
        const swing = Math.sin(agent.stride) * 0.5;
        agent.legs[0].rotation.x = swing; agent.legs[1].rotation.x = -swing;
        return true;
    }

    /**
     * One frame of ambient motion, driven by the host's render loop (`t` in seconds). Returns true while
     * anything still animates (a working agent bobs, a speaker's ring pulses); otherwise the host may idle.
     */
    tick(t: number): boolean {
        const delta = this.lastTick ? Math.min(0.1, Math.max(0, t - this.lastTick)) : 1 / 60;
        this.lastTick = t;
        let walking = false;
        for (const agent of this.agents.values()) if (this.stepWalk(agent, delta)) walking = true;
        for (const agent of [...this.leaving]) if (this.stepWalk(agent, delta)) walking = true;
        // Walking bodies cast moving shadows: refresh the shadow map while anyone walks (and once on arrival).
        if (walking || this.wasWalking) this.host?.invalidate(true);
        this.wasWalking = walking;
        if (this.canvas) this.canvas.dataset.agentsWalking = String(walking);
        return this.pose(t) || walking;
    }
    private wasWalking = false;
    private pose(t: number): boolean {
        let animating = false;
        for (const agent of this.leaving) { agent.ring.visible = false; agent.body.rotation.x = 0; agent.body.position.y = agent.baseY; }
        for (const agent of this.agents.values()) {
            const working = agent.mode === 'desk' && agent.presence.activity === 'working';
            const slumped = agent.mode === 'desk' && agent.presence.activity === 'exited';
            agent.body.position.y = agent.baseY + (working ? Math.abs(Math.sin(t * 6)) * 0.04 : 0);
            agent.body.rotation.x = slumped ? 0.28 : 0;
            agent.ring.visible = !!agent.presence.speaking;
            if (agent.ring.visible) agent.ring.scale.setScalar(1 + Math.sin(t * 9) * 0.12);
            if (working || agent.ring.visible) animating = true;
        }
        for (const mark of this.peers.values()) if (mark.ring.visible) { mark.ring.scale.setScalar(1 + Math.sin(t * 10) * 0.15); animating = true; }
        return animating;
    }

    /** Test/inspection data on the canvas (names and states only). Written only when it changes. */
    private publish(): void {
        if (!this.canvas) return;
        const agents = JSON.stringify(this.agentList.map(a => ({ key: a.key, desk: a.desk, kind: a.kind, label: a.label, activity: a.activity, speaking: !!a.speaking })));
        const peers = JSON.stringify(this.peerList.map(p => ({ id: p.id, name: p.name, speaking: p.speaking, muted: p.muted })));
        if (agents !== this.published.agents) { this.published.agents = agents; this.canvas.dataset.agentAvatars = agents; }
        if (peers !== this.published.peers) { this.published.peers = peers; this.canvas.dataset.voiceIndicators = peers; }
    }

    dispose(): void { this.detach(); this.agentList = []; this.peerList = []; }
}

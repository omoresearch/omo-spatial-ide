import * as THREE from 'three';
import { advancePlayer, ROOM_LAYOUTS } from '../common/player-state';
import type { PlayerPose, RoomLayoutId } from '../common/player-state';
import type { ChatEmote, PresenceColour, RoomMember } from '../common/presence-protocol';
import { PRESENCE_COLOUR_HEX } from '../common/presence-protocol';
import { sceneControls } from './focus-screen';
import type { RoomScene } from './room-scene';
import type { DeskId } from './agent-avatars';
import { EMOTE_TEXT } from './chat-controller';

/**
 * Per-member name colour, emote markers, teleport and follow.
 *
 * Reads the RoomScene's private peer avatars and walker without editing room-scene.ts
 * (same pattern as focus-screen.ts and voice-hub.ts). It only ever moves THIS user's own
 * camera; it has no way to move another member.
 */

const DEFAULT_PEER = '#ff56c8';
interface PeerAvatar { root: THREE.Group; member: RoomMember }
interface Emote { root: THREE.Sprite; until: number; start: number; member: string }

function blocked(layout: RoomLayoutId, x: number, z: number): boolean {
    return Object.values(ROOM_LAYOUTS[layout].desks).some(d => x > d.x - 1.85 && x < d.x + 1.85 && z > d.z - 1.15 && z < d.z + 1.03);
}
function inRoom(x: number, z: number): boolean { return Math.abs(x) <= 5.4 && z >= -3.7 && z <= 4.4; }
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** A free standing spot about 1 m from `target`, facing it. Tries behind, beside, then in front. */
export function placeBeside(target: PlayerPose, layout: RoomLayoutId, pitch = 0): PlayerPose | undefined {
    for (const radius of [1.1, 1.6, 2.2]) for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI / 4, -Math.PI / 4]) {
        // Behind the target = along +z of its facing direction (yaw 0 faces -z).
        const a = target.yaw + turn;
        const x = target.x + Math.sin(a) * radius, z = target.z + Math.cos(a) * radius;
        if (!inRoom(x, z) || blocked(layout, x, z)) continue;
        return { x, z, yaw: wrap(Math.atan2(-(target.x - x), -(target.z - z))), pitch };
    }
    return undefined;
}

/** Where to stand to use a desk monitor (in front of the desk, facing the screen). */
export function deskSpot(layout: RoomLayoutId, desk: DeskId): PlayerPose {
    const d = ROOM_LAYOUTS[layout].desks[desk];
    return { x: d.x, z: Math.min(4.4, d.z + 1.3), yaw: 0, pitch: -0.05 };
}

function tagTexture(name: string, colour: string, note: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96;
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#101622e8'; c.fillRect(0, 0, 512, 96);
    c.fillStyle = colour; c.fillRect(0, 0, 10, 96); c.fillRect(0, 90, 512, 6);
    c.textAlign = 'center'; c.font = '600 34px sans-serif'; c.fillStyle = colour; c.fillText(name, 262, note ? 50 : 60, 470);
    if (note) { c.font = '22px sans-serif'; c.fillStyle = '#d8e2ea'; c.fillText(note, 262, 80, 470); }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}
function emoteTexture(emote: ChatEmote): THREE.CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#ffffffee'; c.beginPath(); c.arc(64, 60, 54, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.moveTo(52, 108); c.lineTo(64, 126); c.lineTo(76, 108); c.fill();
    c.font = '64px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(EMOTE_TEXT[emote].glyph, 64, 64);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

export class HudPeers {
    following?: string;
    private applied = new WeakMap<THREE.Group, string>();
    private emotes: Emote[] = [];
    private frame = 0;
    private lastFollowAt = 0;
    private stuckSince = 0;
    constructor(private scene: () => RoomScene | undefined, private layout: () => RoomLayoutId) {}

    private avatars(): Map<string, PeerAvatar> | undefined {
        const map = (this.scene() as unknown as { peerAvatars?: Map<string, PeerAvatar> } | undefined)?.peerAvatars;
        return map instanceof Map ? map : undefined;
    }
    private threeScene(): THREE.Scene | undefined {
        const s = (this.scene() as unknown as { scene?: unknown } | undefined)?.scene;
        return s instanceof THREE.Scene ? s : undefined;
    }

    /** Recolour peer bodies and redraw their tags when colour, name or follow state changed. */
    paint(members: RoomMember[]): void {
        const avatars = this.avatars(); if (!avatars) return;
        let changed = false;
        for (const [id, avatar] of avatars) {
            const member = members.find(m => m.id === id) ?? avatar.member;
            const colour = member.colour ? PRESENCE_COLOUR_HEX[member.colour] : DEFAULT_PEER;
            const note = this.following === id ? '👣 following' : '';
            const key = `${member.name}|${colour}|${note}`;
            if (this.applied.get(avatar.root) === key) continue;
            this.applied.set(avatar.root, key); changed = true;
            const body = new THREE.Color(colour), legs = new THREE.Color(colour).multiplyScalar(0.55);
            let index = 0;
            avatar.root.traverse(node => {
                if (node instanceof THREE.Mesh && node.material instanceof THREE.MeshStandardMaterial) { node.material.color.copy(index < 2 ? body : legs); index++; }
                if (node instanceof THREE.Sprite) { node.material.map?.dispose(); node.material.map = tagTexture(member.name, colour, note); node.material.needsUpdate = true; }
            });
            avatar.root.userData.omoColour = member.colour ?? '';
        }
        if (changed) this.scene()?.invalidate();
        const canvas = (this.scene() as unknown as { renderer?: { domElement?: HTMLCanvasElement } } | undefined)?.renderer?.domElement;
        if (canvas) canvas.dataset.peerColours = JSON.stringify(Object.fromEntries([...avatars].map(([id, a]) => [id, a.root.userData.omoColour || ''])));
    }

    /** Show an emote bubble over a member (or over yourself: nothing drawn, chat shows it). */
    emote(memberId: string, emote: ChatEmote): void {
        const avatar = this.avatars()?.get(memberId), scene = this.threeScene();
        if (!avatar || !scene) return;
        this.emotes = this.emotes.filter(e => { if (e.member !== memberId) return true; e.root.parent?.remove(e.root); e.root.material.map?.dispose(); e.root.material.dispose(); return false; });
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: emoteTexture(emote), depthTest: true, transparent: true }));
        sprite.scale.set(0.5, 0.5, 1); sprite.position.set(0, 2.6, 0); sprite.name = 'omo-emote';
        avatar.root.add(sprite);
        const now = performance.now();
        this.emotes.push({ root: sprite, start: now, until: now + 3200, member: memberId });
        if (!this.frame) this.frame = requestAnimationFrame(this.animate);
        const canvas = (this.scene() as unknown as { renderer?: { domElement?: HTMLCanvasElement } } | undefined)?.renderer?.domElement;
        if (canvas) canvas.dataset.lastEmote = JSON.stringify({ member: memberId, emote });
    }
    private animate = (): void => {
        const now = performance.now();
        this.emotes = this.emotes.filter(e => {
            if (now < e.until) { const t = (now - e.start) / 1000; e.root.position.y = 2.6 + Math.sin(t * 6) * 0.06; return true; }
            e.root.parent?.remove(e.root); e.root.material.map?.dispose(); e.root.material.dispose(); return false;
        });
        this.scene()?.invalidate();
        this.frame = this.emotes.length ? requestAnimationFrame(this.animate) : 0;
    };

    /** Move only your own body next to a member. Returns a message for the user. */
    teleportTo(member: RoomMember): string {
        const controls = sceneControls(this.scene());
        if (!controls?.enabled) return 'Switch to First person to go to someone.';
        if (controls.cameraOwned) return 'Leave the attached screen first (Esc), then go to someone.';
        const spot = placeBeside(member.pose, this.layout(), controls.pose.pitch);
        if (!spot) return `There is no free spot next to ${member.name} right now.`;
        controls.releaseTyping(); controls.pose = spot; this.scene()?.invalidate();
        return `You are next to ${member.name}.`;
    }
    /** Stand in front of a desk monitor, facing it. Only your own camera moves. */
    jumpToDesk(desk: DeskId): boolean {
        const controls = sceneControls(this.scene());
        if (!controls?.enabled || controls.cameraOwned) return false;
        controls.releaseTyping(); controls.pose = deskSpot(this.layout(), desk); this.scene()?.invalidate();
        return true;
    }
    follow(id: string | undefined): void { this.following = id; this.stuckSince = 0; }

    /**
     * Follow step (call at 4 Hz). Walks toward a spot behind the member through the normal
     * collision rules; jumps beside them when stuck or far. Never moves the other member.
     */
    step(members: RoomMember[]): 'ok' | 'gone' | 'paused' {
        if (!this.following) return 'ok';
        const target = members.find(m => m.id === this.following);
        if (!target) { this.following = undefined; return 'gone'; }
        const controls = sceneControls(this.scene());
        if (!controls?.enabled || controls.cameraOwned || controls.typing) return 'paused';
        const now = performance.now();
        const seconds = Math.min(0.5, (now - (this.lastFollowAt || now - 250)) / 1000); this.lastFollowAt = now;
        const me = controls.pose;
        const distance = Math.hypot(target.pose.x - me.x, target.pose.z - me.z);
        if (distance <= 1.5) { this.stuckSince = 0; controls.pose = { ...me, yaw: wrap(Math.atan2(-(target.pose.x - me.x), -(target.pose.z - me.z))) }; this.scene()?.invalidate(); return 'ok'; }
        if (distance > 6) { const spot = placeBeside(target.pose, this.layout(), me.pitch); if (spot) { controls.pose = spot; this.scene()?.invalidate(); } return 'ok'; }
        let pose: PlayerPose = { ...me, yaw: wrap(Math.atan2(-(target.pose.x - me.x), -(target.pose.z - me.z))) };
        for (let left = seconds; left > 0.001; left -= 0.1) pose = advancePlayer(pose, { forward: 1, right: 0 }, Math.min(0.1, left), this.layout());
        const moved = Math.hypot(pose.x - me.x, pose.z - me.z);
        if (moved < 0.05) { this.stuckSince ||= now; if (now - this.stuckSince > 1500) { const spot = placeBeside(target.pose, this.layout(), me.pitch); if (spot) pose = spot; this.stuckSince = 0; } }
        else this.stuckSince = 0;
        controls.pose = pose; this.scene()?.invalidate();
        return 'ok';
    }

    dispose(): void {
        cancelAnimationFrame(this.frame); this.frame = 0;
        for (const e of this.emotes) { e.root.parent?.remove(e.root); e.root.material.map?.dispose(); e.root.material.dispose(); }
        this.emotes = []; this.following = undefined;
    }
}

export const colourHex = (colour: PresenceColour | undefined): string => colour ? PRESENCE_COLOUR_HEX[colour] : DEFAULT_PEER;

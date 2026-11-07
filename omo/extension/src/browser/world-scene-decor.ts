/**
 * w2:render — decor kinds as simple low-poly meshes. Each builder draws at the local origin, front
 * towards +z (the same convention as a desk: rotation 0 faces the back wall from the player's side).
 * Colours follow the room theme. Variety (book colours, leaf tilt) comes from the entity id, so the
 * same world always looks the same. No lights are added: glowing parts use emissive materials, so
 * adding decor never recompiles the room's shaders.
 */
import * as THREE from 'three';
import type { DecorKind } from '../common/world-model';
import { canvasTexture, facet, mesh } from './world-scene-kit';

/** Small deterministic PRNG from an id. */
export function seeded(id: string): () => number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Palette { wood: number; woodDark: number; fabric: number; fabricDark: number; metal: number; leaf: number[]; pot: number; glow: number; crystal: number; rug: number[] }
function palette(jungle: boolean): Palette {
    return jungle
        ? { wood: 0xb08f62, woodDark: 0x6e5636, fabric: 0x7f9a6c, fabricDark: 0x5d7a52, metal: 0x3d4c42, leaf: [0x4c7e62, 0x6d9b71, 0x86b46f], pot: 0xc9a27a, glow: 0xffe1a0, crystal: 0xa8f0c0, rug: [0x6f5a3c, 0xd8c9a0, 0x9cae7a] }
        : { wood: 0xa98d6c, woodDark: 0x5b4a3a, fabric: 0x5f7f96, fabricDark: 0x45627a, metal: 0x34404d, leaf: [0x4c7e62, 0x6d9b71, 0x5fa58a], pot: 0xd1c7af, glow: 0xffe6bf, crystal: 0x8fe3f0, rug: [0x2c3a52, 0x8ab6c8, 0xd7c6a3] };
}

export function buildDecor(kind: DecorKind, id: string, jungle: boolean): THREE.Group {
    const g = new THREE.Group(); const p = palette(jungle); const rnd = seeded(id);
    switch (kind) {
        case 'plant': plant(g, p, rnd); break;
        case 'lamp': lamp(g, p); break;
        case 'crystal': crystal(g, p, rnd); break;
        case 'sofa': sofa(g, p); break;
        case 'bookshelf': bookshelf(g, p, rnd); break;
        case 'whiteboard': whiteboard(g, p, rnd); break;
        case 'rug': rug(g, p); break;
        case 'window': windowPane(g, jungle); break;
    }
    return g;
}

function plant(g: THREE.Group, p: Palette, rnd: () => number): void {
    mesh(g, new THREE.CylinderGeometry(0.3, 0.22, 0.5, 8), facet(p.pot), [0, 0.25, 0]);
    mesh(g, new THREE.CylinderGeometry(0.32, 0.32, 0.05, 8), facet(p.pot, 0.6), [0, 0.5, 0]);
    mesh(g, new THREE.CylinderGeometry(0.27, 0.27, 0.02, 8), facet(0x4a3a2c, 0.95), [0, 0.52, 0], false);
    // Leaves: tall facetted blades fanning out, plus a soft bush at the centre.
    const blades = 9;
    for (let i = 0; i < blades; i++) {
        const a = i / blades * Math.PI * 2 + rnd() * 0.3, tilt = 0.35 + rnd() * 0.35, h = 0.7 + rnd() * 0.45;
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.09, h, 4), facet(p.leaf[i % p.leaf.length]));
        blade.position.set(Math.sin(a) * 0.12, 0.52 + h / 2 * Math.cos(tilt), Math.cos(a) * 0.12);
        blade.rotation.set(Math.cos(a) * tilt, 0, -Math.sin(a) * tilt); blade.castShadow = true; g.add(blade);
    }
    mesh(g, new THREE.IcosahedronGeometry(0.22, 0), facet(p.leaf[1]), [0, 0.68, 0]).scale.set(1, 0.8, 1);
}

function lamp(g: THREE.Group, p: Palette): void {
    mesh(g, new THREE.CylinderGeometry(0.22, 0.26, 0.05, 10), facet(p.metal, 0.4, 0.5), [0, 0.025, 0]);
    mesh(g, new THREE.CylinderGeometry(0.022, 0.022, 1.45, 6), facet(p.metal, 0.4, 0.5), [0, 0.75, 0]);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 0.34, 8, 1, true), new THREE.MeshStandardMaterial({ color: p.glow, roughness: 0.9, side: THREE.DoubleSide, emissive: p.glow, emissiveIntensity: 0.35, flatShading: true }));
    shade.position.set(0, 1.58, 0); shade.castShadow = true; g.add(shade);
    const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), new THREE.MeshStandardMaterial({ color: p.glow, emissive: p.glow, emissiveIntensity: 2.2 }));
    bulb.position.set(0, 1.5, 0); g.add(bulb);
    // A warm pool of light on the floor (a flat emissive disc, no real light).
    const pool = new THREE.Mesh(new THREE.CircleGeometry(0.7, 20), new THREE.MeshBasicMaterial({ color: p.glow, transparent: true, opacity: 0.12, depthWrite: false }));
    pool.rotation.x = -Math.PI / 2; pool.position.y = 0.012; pool.raycast = () => undefined; g.add(pool);
}

function crystal(g: THREE.Group, p: Palette, rnd: () => number): void {
    const rock = mesh(g, new THREE.DodecahedronGeometry(0.42, 0), facet(0x5b6470, 0.9), [0, 0.12, 0]);
    rock.scale.set(1, 0.42, 0.9);
    const shard = (x: number, z: number, h: number, lean: number, turn: number): void => {
        const m = new THREE.MeshStandardMaterial({ color: p.crystal, emissive: p.crystal, emissiveIntensity: 0.55, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.88, flatShading: true });
        const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), m);
        s.scale.set(0.7, h / 0.32, 0.7); s.position.set(x, 0.2 + h / 2, z); s.rotation.set(Math.cos(turn) * lean, turn, Math.sin(turn) * lean); s.castShadow = true; g.add(s);
    };
    shard(0, 0, 0.95, 0, 0);
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2 + rnd(); shard(Math.sin(a) * 0.18, Math.cos(a) * 0.16, 0.35 + rnd() * 0.35, 0.35 + rnd() * 0.2, a); }
}

function sofa(g: THREE.Group, p: Palette): void {
    const fabric = facet(p.fabric, 0.95), dark = facet(p.fabricDark, 0.95), wood = facet(p.woodDark, 0.7);
    for (const x of [-1.05, 1.05]) for (const z of [-0.38, 0.38]) mesh(g, new THREE.CylinderGeometry(0.035, 0.025, 0.12, 6), wood, [x, 0.06, z]);
    mesh(g, new THREE.BoxGeometry(2.4, 0.26, 1.0), dark, [0, 0.25, 0]);
    for (const x of [-0.58, 0.58]) mesh(g, new THREE.BoxGeometry(1.1, 0.16, 0.8), fabric, [x, 0.46, 0.08]).scale.set(1, 1, 1);
    mesh(g, new THREE.BoxGeometry(2.4, 0.6, 0.24), dark, [0, 0.66, -0.4]);
    for (const x of [-0.58, 0.58]) { const c = mesh(g, new THREE.BoxGeometry(1.06, 0.46, 0.16), fabric, [x, 0.74, -0.24]); c.rotation.x = -0.12; }
    for (const x of [-1.24, 1.24]) mesh(g, new THREE.BoxGeometry(0.2, 0.5, 1.0), dark, [x, 0.5, 0]);
    // One accent cushion.
    const pillow = mesh(g, new THREE.BoxGeometry(0.4, 0.34, 0.12), facet(p.rug[2], 0.95), [0.9, 0.7, -0.12]); pillow.rotation.set(-0.2, -0.3, 0.12);
}

function bookshelf(g: THREE.Group, p: Palette, rnd: () => number): void {
    const wood = facet(p.wood, 0.8), dark = facet(p.woodDark, 0.8);
    const W = 1.6, H = 2.0, D = 0.42;
    for (const x of [-W / 2, W / 2]) mesh(g, new THREE.BoxGeometry(0.05, H, D), wood, [x, H / 2, 0]);
    mesh(g, new THREE.BoxGeometry(W + 0.05, 0.05, D), wood, [0, H, 0]);
    mesh(g, new THREE.BoxGeometry(W, H, 0.03), dark, [0, H / 2, -D / 2 + 0.015]);
    const books = [0x9a4f48, 0x4f7a9a, 0xd1b26f, 0x5e8a68, 0x7a5f9a, 0xc98a5a, 0x3f5163, 0xb8c4c8];
    for (let s = 0; s < 4; s++) {
        const y = 0.06 + s * 0.48;
        mesh(g, new THREE.BoxGeometry(W, 0.04, D), wood, [0, y, 0]);
        let x = -W / 2 + 0.06;
        while (x < W / 2 - 0.12) {
            const w = 0.04 + rnd() * 0.05, h = 0.26 + rnd() * 0.14;
            if (rnd() < 0.12) { x += 0.1; continue; }
            const book = mesh(g, new THREE.BoxGeometry(w, h, 0.26 + rnd() * 0.06), facet(books[Math.floor(rnd() * books.length)], 0.85), [x + w / 2, y + 0.02 + h / 2, 0.02]);
            if (rnd() < 0.08) { book.rotation.z = 0.25; book.position.x += 0.03; }
            x += w + 0.008;
        }
    }
}

function whiteboard(g: THREE.Group, p: Palette, rnd: () => number): void {
    const metal = facet(p.metal, 0.5, 0.4);
    for (const x of [-0.92, 0.92]) {
        mesh(g, new THREE.BoxGeometry(0.05, 1.9, 0.05), metal, [x, 0.95, 0]);
        mesh(g, new THREE.BoxGeometry(0.08, 0.04, 0.6), metal, [x, 0.03, 0]);
    }
    mesh(g, new THREE.BoxGeometry(1.86, 1.1, 0.05), facet(0xc9d1d6, 0.4, 0.3), [0, 1.3, 0]);
    const board = mesh(g, new THREE.PlaneGeometry(1.76, 1.0), new THREE.MeshStandardMaterial({ color: 0xf4f6f4, roughness: 0.35 }), [0, 1.3, 0.027], false);
    board.receiveShadow = true;
    // A few marker strokes: a box diagram and two lines of "writing".
    const ink = [0x2f6db5, 0xc0463e, 0x2e8a5a];
    const stroke = (w: number, h: number, x: number, y: number, c: number): void => { mesh(g, new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c }), [x, y, 0.029], false); };
    stroke(0.42, 0.012, -0.45, 1.6, ink[0]); stroke(0.42, 0.012, -0.45, 1.36, ink[0]); stroke(0.012, 0.24, -0.66, 1.48, ink[0]); stroke(0.012, 0.24, -0.24, 1.48, ink[0]);
    stroke(0.28, 0.012, 0.0, 1.48, ink[1]);
    stroke(0.42, 0.012, 0.38, 1.6, ink[0]); stroke(0.42, 0.012, 0.38, 1.36, ink[0]); stroke(0.012, 0.24, 0.17, 1.48, ink[0]); stroke(0.012, 0.24, 0.59, 1.48, ink[0]);
    for (let i = 0; i < 3; i++) stroke(0.5 + rnd() * 0.7, 0.01, -0.85 + 0.3 + rnd() * 0.2 + 0.2, 1.1 - i * 0.12, ink[2]);
    mesh(g, new THREE.BoxGeometry(1.2, 0.03, 0.08), metal, [0, 0.76, 0.05]);
    for (let i = 0; i < 3; i++) { const m = mesh(g, new THREE.CylinderGeometry(0.012, 0.012, 0.12, 6), facet(ink[i]), [-0.2 + i * 0.16, 0.79, 0.06]); m.rotation.z = Math.PI / 2; }
}

function rug(g: THREE.Group, p: Palette): void {
    const layer = (rx: number, rz: number, y: number, color: number): void => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.012, 40), new THREE.MeshStandardMaterial({ color, roughness: 1 }));
        m.scale.set(rx, 1, rz); m.position.y = y; m.receiveShadow = true; g.add(m);
    };
    layer(1.6, 1.05, 0.006, p.rug[0]); layer(1.42, 0.9, 0.012, p.rug[1]); layer(1.2, 0.72, 0.018, p.rug[0]); layer(0.55, 0.32, 0.024, p.rug[2]);
}

function windowPane(g: THREE.Group, jungle: boolean): void {
    const W = 2.0, H = 1.5, y = 1.85;
    const { canvas, texture } = canvasTexture(256, 192);
    const c = canvas.getContext('2d');
    if (c) {
        const sky = c.createLinearGradient(0, 0, 0, 192);
        if (jungle) { sky.addColorStop(0, '#f6c886'); sky.addColorStop(0.55, '#9fc7a2'); sky.addColorStop(1, '#2f5a46'); }
        else { sky.addColorStop(0, '#0b1430'); sky.addColorStop(0.6, '#26407a'); sky.addColorStop(1, '#6a87b8'); }
        c.fillStyle = sky; c.fillRect(0, 0, 256, 192);
        if (jungle) {
            c.fillStyle = '#ffe9b5'; c.beginPath(); c.arc(70, 70, 22, 0, Math.PI * 2); c.fill();
            c.fillStyle = '#2f5a46'; for (let i = 0; i < 9; i++) { c.beginPath(); c.arc(i * 32, 192, 40 + (i % 3) * 14, Math.PI, 0); c.fill(); }
        } else {
            c.fillStyle = '#e8f1ff'; for (let i = 0; i < 40; i++) c.fillRect((i * 97) % 256, (i * 53) % 120, i % 5 ? 1 : 2, i % 5 ? 1 : 2);
            c.fillStyle = '#d9e4ff'; c.beginPath(); c.arc(190, 52, 16, 0, Math.PI * 2); c.fill();
            c.fillStyle = '#0b1430'; c.beginPath(); c.arc(198, 46, 14, 0, Math.PI * 2); c.fill();
            c.fillStyle = '#1b2748'; for (let i = 0; i < 10; i++) c.fillRect(i * 26, 150 - (i * 37) % 40, 20, 60);
        }
        texture.needsUpdate = true;
    }
    const glass = mesh(g, new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }), [0, y, 0.0], false);
    glass.userData.ownsMap = true;
    const frame = facet(0xe7e2d6, 0.6);
    mesh(g, new THREE.BoxGeometry(W + 0.16, 0.08, 0.1), frame, [0, y + H / 2 + 0.04, 0.02]);
    mesh(g, new THREE.BoxGeometry(W + 0.16, 0.08, 0.1), frame, [0, y - H / 2 - 0.04, 0.02]);
    for (const x of [-W / 2 - 0.04, W / 2 + 0.04]) mesh(g, new THREE.BoxGeometry(0.08, H + 0.16, 0.1), frame, [x, y, 0.02]);
    mesh(g, new THREE.BoxGeometry(0.04, H, 0.06), frame, [0, y, 0.03]);
    mesh(g, new THREE.BoxGeometry(W, 0.04, 0.06), frame, [0, y + 0.1, 0.03]);
    mesh(g, new THREE.BoxGeometry(W + 0.3, 0.05, 0.22), frame, [0, y - H / 2 - 0.1, 0.1]);
}

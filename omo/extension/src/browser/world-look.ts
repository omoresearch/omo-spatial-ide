/**
 * beauty:foundation — THE design system of the world. Every runtime builder (rooms, decor, paths, signs, boards, the
 * open ground, the skyline floor and its city) asks this file for a named material, a palette colour, a plate painter
 * or the light rig. Nothing in a `world-scene-*.ts` builder may create a material or write a colour literal
 * (extension/test/beauty-lint.test.cjs fails if one does).
 *
 * Art direction (from the hand-made skyline penthouse): warm plaster walls, oak and herringbone floors, walnut trim,
 * brushed brass, graphite steel, linen and sage fabrics with one terracotta accent, clear low-iron glass, warm 2700 K
 * light. Solid surfaces are PBR (MeshStandard / MeshPhysical) with a roughness value and a subtle procedural
 * roughness + normal detail map, never a flat unlit colour. Unlit materials exist only for screens, painted text plates,
 * the sky and decals (contact shadows, light pools).
 *
 * Materials are shared: `look('wall')` returns the same instance for every wall in every room (one shader program,
 * one upload). Shared materials carry userData.lookShared and are never disposed with a room (disposeTree skips them).
 * Every material made here carries userData.look = its recipe name, so a real-browser check can prove that no mesh in
 * the world uses a material from anywhere else.
 */
import * as THREE from 'three';
import type { RoomTheme } from '../common/room-state';
import { kitAssetUrl } from '../common/world-style-kits';

// ------------------------------------------------------------------------------------------------ palette
/** The one palette. Builders refer to these names; nobody writes a hex colour elsewhere. */
export const PALETTE = {
    plaster: 0xebe5da, plasterShade: 0xd8d0c2, ceiling: 0xf1ece4,
    oak: 0xb48c5e, oakLight: 0xc9a77a, walnut: 0x4a3122, walnutDark: 0x2e1f16,
    graphite: 0x232428, ink: 0x15161a, steel: 0x8d9096,
    brass: 0xb38f55, bronze: 0x6b5236,
    linen: 0xd6cbb6, sage: 0x7d8c74, fabric: 0x4f5b57, terracotta: 0xb4623e, cognac: 0x8a5232,
    ceramic: 0xe8e2d6, soil: 0x3b2d22,
    stone: 0xcfc4b0, stoneDark: 0x8e8473, travertine: 0xd9cfbd, concrete: 0x9a958c,
    lawn: 0x6f8c55, lawnDark: 0x55703f, earth: 0x6e5b44, surround: 0x46583a,
    leaf: 0x4b7348, leafLight: 0x6e9a58, leafDark: 0x355a3a, bark: 0x5b4734,
    glass: 0xb8c8d2, glassTint: 0x0b1218,
    board: 0xf5f2ea, boardFrame: 0xd9d3c7,
    warm: 0xffcf96, warmBright: 0xffe6c4, cool: 0xbfe4ff, crystal: 0x9fe6ef,
    screenOff: 0x07090c, bezel: 0x101114,
    dusk: { top: 0x070a22, mid: 0x232454, horizon: 0xc8684e, sun: 0xff8a4a, haze: 0x1a1d33 },
    day: { low: 0xdcebf2, high: 0x5f9fd4, ground: 0x46583a },
    status: { idle: 0x6d7c86 }
} as const;

/** CSS colours for painted plates and boards (canvas 2D). The same palette, as strings. */
export const INK = {
    plate: '#1d1e22', plateEdge: '#b38f55', plateText: '#f3ece0', plateSub: '#c9b99c',
    paper: '#f5f2ea', paperText: '#1d2228', paperSub: '#5b5f63', rule: '#b38f55', accent: '#b4623e', accentCool: '#4f7a72',
    shadow: 'rgba(0, 0, 0, 0.18)'
} as const;

/** The type every sign, board and plate uses (the penthouse's): a humanist sans for text, a serif for titles. */
export const LOOK_TYPE = {
    sans: '"Inter", "Helvetica Neue", "Segoe UI", Arial, sans-serif',
    serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    mono: 'ui-monospace, "SFMono-Regular", Menlo, monospace'
} as const;

/**
 * The one light rig. Kit worlds use their baked light; every other world gets the same: an environment probe for
 * reflections, a warm key (the sun / main lamp), a cool sky fill and a warm accent, ACES tone mapping at one exposure.
 */
export const LIGHT_RIG = {
    exposure: 1.05,
    env: 0.55,
    hemi: { sky: 0xdfe8f0, ground: 0x3a3128, intensity: 1.6 },
    key: { color: 0xffe2bf, intensity: 3.2 },
    fill: { color: 0xffc690, intensity: 16 },
    skyline: { hemiSky: 0x8fa2d8, hemiGround: 0x2a2020, hemi: 1.4, key: 0xffb27a, keyIntensity: 2.0, fill: 0xffc68a, fillIntensity: 16, exposure: 1.0, env: 0.5 }
} as const;

/** Penthouse proportions shared by architecture builders. */
export const PROPORTIONS = { ceiling: 3.4, wall: 0.12, skirting: 0.12, trim: 0.06, cove: 0.28 } as const;

// ------------------------------------------------------------------------------------------------ procedural detail
/** Deterministic hash (no Math.random: the same world always looks the same). */
function h2(x: number, y: number, seed: number): number {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
/** Tileable value noise in 0..1 (size x size, `cells` lattice cells across, a few octaves). */
function noise(size: number, cells: number, seed: number, octaves = 4): Float32Array {
    const out = new Float32Array(size * size);
    let amp = 1, total = 0;
    for (let o = 0; o < octaves; o++) {
        const c = cells << o;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const fx = x / size * c, fy = y / size * c, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
            const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
            const v = (a: number, b: number): number => h2(((a % c) + c) % c, ((b % c) + c) % c, seed + o * 31);
            const top = v(ix, iy) * (1 - sx) + v(ix + 1, iy) * sx, bottom = v(ix, iy + 1) * (1 - sx) + v(ix + 1, iy + 1) * sx;
            out[y * size + x] += (top * (1 - sy) + bottom * sy) * amp;
        }
        total += amp; amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
}
function dataTexture(size: number, fill: (x: number, y: number, px: Uint8Array, i: number) => void, color = false): THREE.DataTexture {
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const i = (y * size + x) * 4; px[i + 3] = 255; fill(x, y, px, i); }
    const t = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.anisotropy = 8; t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true;
    return t;
}
/** A normal map from a height field (Sobel), `strength` = slope scale. */
function normalFrom(height: Float32Array, size: number, strength: number): THREE.DataTexture {
    const at = (x: number, y: number): number => height[((y + size) % size) * size + ((x + size) % size)];
    return dataTexture(size, (x, y, px, i) => {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        const len = Math.hypot(dx, dy, 1);
        px[i] = Math.round((-dx / len * 0.5 + 0.5) * 255); px[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255); px[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
    });
}
const texCache = new Map<string, THREE.Texture>();
function cachedTex(key: string, make: () => THREE.Texture): THREE.Texture {
    let t = texCache.get(key); if (!t) { t = make(); t.userData.lookShared = true; texCache.set(key, t); } return t;
}
/** Fine plaster / fabric grain: roughness detail (G channel) + normal. */
function grain(kind: 'fine' | 'coarse'): { rough: THREE.Texture; normal: THREE.Texture } {
    const size = 128;
    const rough = cachedTex(`grain-r-${kind}`, () => { const n = noise(size, kind === 'fine' ? 16 : 6, kind === 'fine' ? 11 : 17); return dataTexture(size, (x, y, px, i) => { const v = Math.round((0.82 + n[y * size + x] * 0.18) * 255); px[i] = px[i + 1] = px[i + 2] = v; }); });
    const normal = cachedTex(`grain-n-${kind}`, () => normalFrom(noise(size, kind === 'fine' ? 24 : 8, kind === 'fine' ? 5 : 9, 3), size, kind === 'fine' ? 1.2 : 2.2));
    return { rough, normal };
}
/** Oak planks (straight) or herringbone, as a colour multiplier (warm greys around 0.8) + a matching roughness map. */
function woodFloor(pattern: 'oak' | 'herringbone'): { map: THREE.Texture; rough: THREE.Texture } {
    const size = 512, grainN = noise(size, 64, pattern === 'oak' ? 3 : 7, 3);
    const tone = (id: number): number => 0.8 + h2(id, id * 7, 99) * 0.2;
    // 1 texture = 2 x 2 m (world UVs are metres / LOOK_TILE).
    const plankAt = (u: number, v: number): { id: number; along: number; edge: number } => {
        if (pattern === 'oak') {
            const w = 0.18, row = Math.floor(v / w), len = 1.2 + h2(row, 3, 5) * 0.8, off = h2(row, 9, 1) * len;
            const col = Math.floor((u + off) / len);
            const eu = Math.min(((u + off) % len + len) % len, len - ((u + off) % len + len) % len), ev = Math.min(v - row * w, (row + 1) * w - v);
            return { id: row * 131 + col, along: u, edge: Math.min(eu * 4, ev) };
        }
        const W = 0.25, L = 0.6, c = Math.floor(u / W), local = u / W - c, dir = c % 2 === 0 ? 1 : -1;
        const vv = v + dir * local * W, k = Math.floor(vv / (L * 0.5));
        const ev = Math.min(vv - k * L * 0.5, (k + 1) * L * 0.5 - vv), eu = Math.min(local, 1 - local) * W;
        return { id: c * 977 + k, along: vv, edge: Math.min(eu, ev * 0.7) };
    };
    const map = cachedTex(`floor-${pattern}`, () => dataTexture(size, (x, y, px, i) => {
        const u = x / size * 2, v = y / size * 2, p = plankAt(u, v);
        const seam = p.edge < 0.004 ? 0.55 : p.edge < 0.008 ? 0.82 : 1;
        const streak = 0.92 + 0.08 * Math.sin(p.along * 90 + grainN[y * size + x] * 9 + p.id);
        const k = tone(p.id) * streak * seam;
        px[i] = Math.min(255, Math.round(k * 255)); px[i + 1] = Math.min(255, Math.round(k * 0.96 * 255)); px[i + 2] = Math.min(255, Math.round(k * 0.9 * 255));
    }, true));
    const rough = cachedTex(`floor-r-${pattern}`, () => dataTexture(size, (x, y, px, i) => {
        const p = plankAt(x / size * 2, y / size * 2), v = Math.round((p.edge < 0.006 ? 1 : 0.7 + h2(p.id, 1, 2) * 0.2) * 255); px[i] = px[i + 1] = px[i + 2] = v;
    }));
    return { map, rough };
}
/** Square stone pavers with soft grout (2.4 m tile), or a lawn (4 m tile). */
function groundTex(kind: 'pavers' | 'lawn' | 'travertine'): THREE.Texture {
    return cachedTex(`ground-${kind}`, () => {
        const size = 256, n = noise(size, kind === 'lawn' ? 32 : 12, kind === 'lawn' ? 21 : 23, 4);
        return dataTexture(size, (x, y, px, i) => {
            let k = 0.86 + n[y * size + x] * 0.22;
            if (kind !== 'lawn') {
                const cell = kind === 'pavers' ? size / 4 : size / 2, gx = x % cell, gy = y % cell, edge = Math.min(gx, gy, cell - gx, cell - gy);
                const id = Math.floor(x / cell) * 7 + Math.floor(y / cell) * 13;
                k *= (0.93 + h2(id, 2, 3) * 0.1) * (edge < 1.5 ? 0.72 : 1);
            }
            const g = kind === 'lawn' ? k * 1.03 : k;
            px[i] = Math.min(255, Math.round(k * 235)); px[i + 1] = Math.min(255, Math.round(g * 235)); px[i + 2] = Math.min(255, Math.round(k * 230));
        }, true);
    });
}
/** A woven rug: a field with a soft weave, an inner border line and a wide outer band (0..1 UVs over the rug top). */
function rugTex(): THREE.Texture {
    return cachedTex('rug', () => {
        const size = 256, n = noise(size, 48, 41, 2);
        const field = [0.84, 0.79, 0.7], band = [0.33, 0.37, 0.35], line = [0.71, 0.39, 0.25];
        return dataTexture(size, (x, y, px, i) => {
            const u = x / size, v = y / size, d = Math.min(u, v, 1 - u, 1 - v);
            const c = d < 0.07 ? band : d < 0.085 ? line : d < 0.1 ? field : (Math.floor(u * 24) + Math.floor(v * 24)) % 2 ? field : field.map(f => f * 0.96);
            const k = 0.92 + n[y * size + x] * 0.12;
            px[i] = Math.round(c[0] * k * 255); px[i + 1] = Math.round(c[1] * k * 255); px[i + 2] = Math.round(c[2] * k * 255);
        }, true);
    });
}
/** Radial (blob) or edge (wall strip) contact-shadow alpha. */
function aoTex(kind: 'blob' | 'edge'): THREE.Texture {
    return cachedTex(`ao-${kind}`, () => {
        const size = 64;
        const t = dataTexture(size, (x, y, px, i) => {
            const u = x / (size - 1) * 2 - 1, v = y / (size - 1) * 2 - 1;
            const d = kind === 'blob' ? Math.min(1, Math.hypot(u, v)) : Math.min(1, (v + 1) / 2);
            px[i] = px[i + 1] = px[i + 2] = 0; px[i + 3] = Math.round(Math.pow(1 - d, 2) * 255);
        });
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
    });
}

// ------------------------------------------------------------------------------------------------ material recipes
export type LookName =
    | 'wall' | 'wall.outer' | 'ceiling' | 'floor.oak' | 'floor.herringbone' | 'floor.stone' | 'floor.polished'
    | 'trim' | 'trim.graphite' | 'glass' | 'glass.kit.tint' | 'glass.kit.reflect'
    | 'fabric' | 'fabric.accent' | 'fabric.linen' | 'fabric.sage' | 'leather'
    | 'metal.brass' | 'metal.graphite' | 'metal.steel' | 'metal.bronze'
    | 'wood' | 'wood.dark' | 'ceramic' | 'soil' | 'board' | 'board.frame'
    | 'emissive.warm' | 'emissive.cove' | 'emissive.cool' | 'crystal'
    | 'stone' | 'stone.dark' | 'ground.lawn' | 'ground.surround' | 'foliage' | 'foliage.light' | 'foliage.dark' | 'bark'
    | 'rug' | 'screen.off' | 'bezel' | 'ao.blob' | 'ao.edge' | 'light.pool' | 'grid' | 'beacon';

/** Metres per texture repeat on world-UV geometry (see worldUVBox). */
export const LOOK_TILE = 2;

const cache = new Map<LookName, THREE.Material>();
function tag<T extends THREE.Material>(m: T, name: string, shared = true): T { m.name = `look:${name}`; m.userData.look = name; if (shared) m.userData.lookShared = true; return m; }
function std(p: THREE.MeshStandardMaterialParameters, detail: 'fine' | 'coarse' | false = 'fine', normalScale = 0.18): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(p);
    if (detail) { const g = grain(detail); m.roughnessMap = g.rough; m.normalMap = g.normal; m.normalScale.set(normalScale, normalScale); }
    return m;
}
function make(name: LookName): THREE.Material {
    const P = PALETTE;
    switch (name) {
        case 'wall': return std({ color: P.plaster, roughness: 0.92, metalness: 0 }, 'fine', 0.12);
        case 'wall.outer': return std({ color: P.plasterShade, roughness: 0.9, metalness: 0 }, 'fine', 0.14);
        case 'ceiling': return std({ color: P.ceiling, roughness: 0.95, metalness: 0, side: THREE.BackSide }, 'fine', 0.08);
        case 'floor.oak': case 'floor.herringbone': {
            const t = woodFloor(name === 'floor.oak' ? 'oak' : 'herringbone');
            const m = new THREE.MeshStandardMaterial({ color: P.oak, map: t.map, roughnessMap: t.rough, roughness: 0.62, metalness: 0 });
            m.normalMap = grain('fine').normal; m.normalScale.set(0.08, 0.08); return m;
        }
        case 'floor.stone': return new THREE.MeshStandardMaterial({ color: P.stone, map: groundTex('pavers'), roughness: 0.82, metalness: 0, normalMap: grain('coarse').normal, normalScale: new THREE.Vector2(0.25, 0.25) });
        case 'floor.polished': return new THREE.MeshPhysicalMaterial({ color: P.travertine, map: groundTex('travertine'), roughness: 0.34, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.3, roughnessMap: grain('coarse').rough });
        case 'trim': return std({ color: P.walnut, roughness: 0.45, metalness: 0.02 }, 'fine', 0.1);
        case 'trim.graphite': return std({ color: P.graphite, roughness: 0.4, metalness: 0.55 }, 'fine', 0.06);
        case 'glass': return new THREE.MeshPhysicalMaterial({ color: P.glass, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.22, envMapIntensity: 1.4, depthWrite: false, side: THREE.DoubleSide });
        case 'glass.kit.tint': return new THREE.MeshStandardMaterial({ color: P.glassTint, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
        case 'glass.kit.reflect': return new THREE.MeshStandardMaterial({ color: 0, roughness: 0.03, metalness: 0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, envMapIntensity: 0.55, side: THREE.DoubleSide });
        case 'fabric': return std({ color: P.fabric, roughness: 0.96, metalness: 0 }, 'coarse', 0.35);
        case 'fabric.accent': return std({ color: P.terracotta, roughness: 0.95, metalness: 0 }, 'coarse', 0.35);
        case 'fabric.linen': return std({ color: P.linen, roughness: 0.97, metalness: 0 }, 'coarse', 0.3);
        case 'fabric.sage': return std({ color: P.sage, roughness: 0.96, metalness: 0 }, 'coarse', 0.35);
        case 'leather': return std({ color: P.cognac, roughness: 0.55, metalness: 0 }, 'coarse', 0.15);
        case 'metal.brass': return std({ color: P.brass, roughness: 0.32, metalness: 0.92 }, 'fine', 0.05);
        case 'metal.graphite': return std({ color: P.graphite, roughness: 0.38, metalness: 0.7 }, 'fine', 0.05);
        case 'metal.steel': return std({ color: P.steel, roughness: 0.3, metalness: 0.85 }, 'fine', 0.04);
        case 'metal.bronze': return std({ color: P.bronze, roughness: 0.35, metalness: 0.85 }, 'fine', 0.05);
        case 'wood': { const t = woodFloor('oak'); const m = new THREE.MeshStandardMaterial({ color: P.oakLight, map: t.map, roughness: 0.55, metalness: 0 }); return m; }
        case 'wood.dark': return std({ color: P.walnut, roughness: 0.5, metalness: 0 }, 'fine', 0.12);
        case 'ceramic': return std({ color: P.ceramic, roughness: 0.4, metalness: 0 }, 'fine', 0.05);
        case 'soil': return std({ color: P.soil, roughness: 1, metalness: 0 }, 'coarse', 0.5);
        case 'board': return std({ color: P.board, roughness: 0.4, metalness: 0 }, 'fine', 0.03);
        case 'board.frame': return std({ color: P.boardFrame, roughness: 0.35, metalness: 0.6 }, 'fine', 0.04);
        case 'emissive.warm': return new THREE.MeshStandardMaterial({ color: P.warm, emissive: P.warm, emissiveIntensity: 2.2, roughness: 0.5, metalness: 0 });
        case 'emissive.cove': return new THREE.MeshStandardMaterial({ color: P.warmBright, emissive: P.warm, emissiveIntensity: 1.6, roughness: 0.6, metalness: 0 });
        case 'emissive.cool': return new THREE.MeshStandardMaterial({ color: P.cool, emissive: P.cool, emissiveIntensity: 1.2, roughness: 0.5, metalness: 0 });
        case 'crystal': return new THREE.MeshPhysicalMaterial({ color: P.crystal, emissive: P.crystal, emissiveIntensity: 0.35, roughness: 0.08, metalness: 0, transmission: 0, transparent: true, opacity: 0.86, clearcoat: 1 });
        case 'stone': return new THREE.MeshStandardMaterial({ color: P.stone, map: groundTex('pavers'), roughness: 0.85, metalness: 0, normalMap: grain('coarse').normal, normalScale: new THREE.Vector2(0.3, 0.3) });
        case 'stone.dark': return std({ color: P.stoneDark, roughness: 0.8, metalness: 0 }, 'coarse', 0.3);
        case 'ground.lawn': return new THREE.MeshStandardMaterial({ color: P.lawn, map: groundTex('lawn'), roughness: 1, metalness: 0, normalMap: grain('coarse').normal, normalScale: new THREE.Vector2(0.6, 0.6) });
        case 'ground.surround': return std({ color: P.surround, roughness: 1, metalness: 0 }, 'coarse', 0.4);
        case 'foliage': return std({ color: P.leaf, roughness: 0.8, metalness: 0 }, 'coarse', 0.6);
        case 'foliage.light': return std({ color: P.leafLight, roughness: 0.8, metalness: 0 }, 'coarse', 0.6);
        case 'foliage.dark': return std({ color: P.leafDark, roughness: 0.82, metalness: 0 }, 'coarse', 0.6);
        case 'bark': return std({ color: P.bark, roughness: 0.95, metalness: 0 }, 'coarse', 0.8);
        case 'rug': return new THREE.MeshStandardMaterial({ color: 0xffffff, map: rugTex(), roughness: 1, metalness: 0, normalMap: grain('coarse').normal, normalScale: new THREE.Vector2(0.5, 0.5) });
        case 'screen.off': return new THREE.MeshStandardMaterial({ color: P.screenOff, roughness: 0.15, metalness: 0.2 });
        case 'bezel': return std({ color: P.bezel, roughness: 0.3, metalness: 0.5 }, 'fine', 0.03);
        // Decals: lit by nothing, never shadowed, never picked.
        case 'ao.blob': return new THREE.MeshBasicMaterial({ map: aoTex('blob'), transparent: true, depthWrite: false, opacity: 0.55, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 });
        case 'ao.edge': return new THREE.MeshBasicMaterial({ map: aoTex('edge'), transparent: true, depthWrite: false, opacity: 0.4, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 });
        case 'light.pool': return new THREE.MeshBasicMaterial({ color: P.warm, map: aoTex('blob'), transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
        case 'grid': return new THREE.LineBasicMaterial({ color: P.stone, transparent: true, opacity: 0.08, depthWrite: false });
        case 'beacon': return new THREE.MeshBasicMaterial({ color: 0xff3322 });
    }
}
/** The shared material for a recipe. */
export function look(name: LookName): THREE.Material {
    let m = cache.get(name);
    if (!m) { m = tag(make(name), name); cache.set(name, m); }
    return m;
}
/** The floor a room of this theme gets. */
export function roomFloor(theme: RoomTheme | undefined): LookName { return theme === 'jungle' ? 'floor.oak' : 'floor.herringbone'; }

/** A live screen (terminal, web page, mirror): unlit so text stays exact. Not shared (each screen has its own map). */
export function lookScreen(map: THREE.Texture, toneMapped = false): THREE.MeshBasicMaterial {
    return tag(new THREE.MeshBasicMaterial({ map, toneMapped }), 'screen', false);
}
/** A painted plate (sign, board face, name plate): its own canvas map, unlit so the type reads exactly. */
export function lookPlate(map: THREE.Texture | undefined, transparent = false): THREE.MeshBasicMaterial {
    return tag(new THREE.MeshBasicMaterial({ color: map ? 0xffffff : PALETTE.graphite, ...(map ? { map } : {}), transparent, toneMapped: false, fog: false }), 'plate', false);
}
/** A painted surface that is lit like paper (board writing, note cards). */
export function lookPaper(map: THREE.Texture): THREE.MeshStandardMaterial {
    return tag(new THREE.MeshStandardMaterial({ color: 0xffffff, map, roughness: 0.55, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.35 }), 'paper', false);
}
/** A station status lamp: its own material (RoomScene recolours it from the terminal's status). */
export function lookStatusLamp(): THREE.MeshStandardMaterial {
    return tag(new THREE.MeshStandardMaterial({ color: PALETTE.status.idle, emissive: PALETTE.status.idle, emissiveIntensity: 1.5, roughness: 0.5 }), 'status', false);
}
/** A glowing ink colour (marker strokes etc.): shared per colour. */
const inkCache = new Map<string, THREE.Material>();
export function lookInk(which: 'accent' | 'cool' | 'dark'): THREE.Material {
    let m = inkCache.get(which);
    if (!m) { const c = which === 'accent' ? PALETTE.terracotta : which === 'cool' ? 0x4f7a72 : PALETTE.ink; m = tag(new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }), `ink.${which}`); inkCache.set(which, m); }
    return m;
}

// ------------------------------------------------------------------------------------------------ geometry helpers
/** A box whose UVs are in metres / LOOK_TILE on every face, so tiled recipes (oak, pavers, plaster grain) keep one scale. */
export function worldUVBox(w: number, h: number, d: number): THREE.BoxGeometry {
    const g = new THREE.BoxGeometry(w, h, d), pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
        const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const [u, v] = ny > 0.5 ? [x, z] : nx > 0.5 ? [z, y] : [x, y];
        uv.setXY(i, u / LOOK_TILE, v / LOOK_TILE);
    }
    uv.needsUpdate = true; return g;
}
/** A soft contact shadow under a prop or along a wall base (flat decal; never casts, never picked). */
export function aoDecal(width: number, depth: number, kind: 'blob' | 'edge' = 'blob'): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), look(kind === 'blob' ? 'ao.blob' : 'ao.edge'));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.004; m.renderOrder = 1; m.raycast = () => undefined; m.userData.decal = true; m.name = 'omo-ao';
    return m;
}
/** A warm light pool on the floor under a lamp (additive decal). */
export function lightPool(radius: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), look('light.pool'));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.006; m.raycast = () => undefined; m.userData.decal = true; m.name = 'omo-lamp-pool';
    return m;
}

// ------------------------------------------------------------------------------------------------ plates and boards
/** A canvas + sRGB texture (undefined outside a browser: Node tests build scenes without a DOM). */
export function plateCanvas(width: number, height: number): { canvas: HTMLCanvasElement; c: CanvasRenderingContext2D; texture: THREE.CanvasTexture } | undefined {
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const c = canvas.getContext('2d'); if (!c) return undefined;
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
    return { canvas, c, texture };
}
export function wrapWords(c: CanvasRenderingContext2D, text: string, max: number): string[] {
    const lines: string[] = []; let line = '';
    for (const w of text.split(/\s+/).filter(Boolean)) { const next = line ? `${line} ${w}` : w; if (c.measureText(next).width > max && line) { lines.push(line); line = w; } else line = next; }
    if (line) lines.push(line);
    return lines;
}
export function fitLine(c: CanvasRenderingContext2D, text: string, max: number): string {
    if (c.measureText(text).width <= max) return text;
    const words = text.split(/\s+/); let out = '';
    for (const w of words) { const next = out ? `${out} ${w}` : w; if (c.measureText(`${next}…`).width > max) break; out = next; }
    return `${out || text.slice(0, 12)}…`;
}
/** The room sign plate: graphite with a brass hairline, warm letter-spaced capitals (the penthouse plate). */
export function paintSignPlate(text: string, width = 1024, height = 224): THREE.CanvasTexture | undefined {
    const p = plateCanvas(width, height); if (!p) return undefined;
    const { c, texture } = p, r = height * 0.16;
    c.fillStyle = INK.plate; c.beginPath(); c.roundRect?.(6, 6, width - 12, height - 12, r); c.fill();
    c.strokeStyle = INK.plateEdge; c.lineWidth = 4; c.beginPath(); c.roundRect?.(20, 20, width - 40, height - 40, r * 0.7); c.stroke();
    c.fillStyle = INK.plateText; c.font = `500 ${Math.round(height * 0.36)}px ${LOOK_TYPE.sans}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.round(height * 0.04)}px`;
    c.fillText(text.toUpperCase(), width / 2, height / 2 + 4, width - 120);
    return texture;
}
/** A desk name plate (graphite, a status dot in the accent, the name and a small caps tag). */
export function paintNamePlate(name: string, tag: string, hermes: boolean, narrow: boolean): THREE.CanvasTexture | undefined {
    const p = plateCanvas(512, 80); if (!p) return undefined;
    const { c, texture } = p;
    c.fillStyle = INK.plate; c.fillRect(0, 0, 512, 80);
    c.fillStyle = INK.plateEdge; c.fillRect(0, 76, 512, 4);
    c.fillStyle = hermes ? INK.accentCool : INK.plateEdge; c.beginPath(); c.arc(34, 40, 9, 0, Math.PI * 2); c.fill();
    c.font = `600 32px ${LOOK_TYPE.sans}`; c.fillStyle = INK.plateText; c.textBaseline = 'middle';
    c.fillText(name, 58, 41, narrow ? 330 : 430);
    c.font = `18px ${LOOK_TYPE.mono}`; c.textAlign = 'right'; c.fillStyle = INK.plateSub;
    c.fillText(tag, 496, 42);
    return texture;
}
export interface BoardRow { text: string; title: boolean; top: number; bottom: number }
/** A topic board face: warm paper, a serif title over a brass rule, 2-4 note lines with accent bullets. */
export function paintTopicBoard(c: CanvasRenderingContext2D, W: number, H: number, title: string, notes: readonly string[]): BoardRow[] {
    const X = 56, MAX = W - 2 * X - 34, rows: BoardRow[] = [];
    c.fillStyle = INK.paper; c.fillRect(0, 0, W, H);
    c.fillStyle = INK.plate; c.fillRect(0, 0, W, 136);
    c.fillStyle = INK.rule; c.fillRect(0, 136, W, 6);
    c.textBaseline = 'alphabetic';
    c.fillStyle = INK.plateText; c.font = `600 74px ${LOOK_TYPE.serif}`;
    const t = fitLine(c, title, W - 2 * X);
    c.fillText(t, X, 98); rows.push({ text: t, title: true, top: 98 - 58, bottom: 98 + 4 });
    c.font = `500 50px ${LOOK_TYPE.sans}`;
    let lines = notes.slice(0, 4).map(n => fitLine(c, n, MAX));
    if (notes.length && notes.length < 2) lines = wrapWords(c, notes[0], MAX).slice(0, 2).map(l => fitLine(c, l, MAX));
    if (!lines.length) lines = ['No notes yet'];
    const step = Math.min(102, (H - 176) / Math.max(1, lines.length));
    lines.forEach((l, i) => {
        const base = 142 + 30 + step * i + 50;
        c.fillStyle = INK.accent; c.beginPath(); c.arc(X + 9, base - 17, 9, 0, Math.PI * 2); c.fill();
        c.fillStyle = INK.paperText; c.fillText(l, X + 34, base, MAX);
        rows.push({ text: l, title: false, top: base - 38, bottom: base + 2 });
    });
    return rows;
}
/** A data board note: up to 4 wrapped lines of dark ink on warm paper with an accent rule. */
export function paintNote(text: string, width = 704, height = 400): THREE.CanvasTexture | undefined {
    const p = plateCanvas(width, height); if (!p) return undefined;
    const { c, texture } = p;
    c.fillStyle = INK.paper; c.fillRect(0, 0, width, height);
    c.fillStyle = INK.paperText; c.font = `600 54px ${LOOK_TYPE.sans}`; c.textBaseline = 'top';
    const lines = wrapWords(c, text, width - 64), shown = lines.slice(0, 4); if (lines.length > 4) shown[3] = `${shown[3].slice(0, 18)}…`;
    shown.forEach((l, i) => c.fillText(l, 32, 40 + i * 84, width - 64));
    c.fillStyle = INK.accent; c.fillRect(32, height - 28, 120, 8);
    return texture;
}
/** A reading-stand card: the chat title on paper with a brass tab. */
export function paintCard(text: string): THREE.CanvasTexture | undefined {
    const p = plateCanvas(512, 320); if (!p) return undefined;
    const { c, texture } = p;
    c.fillStyle = INK.paper; c.fillRect(0, 0, 512, 320);
    c.fillStyle = INK.rule; c.fillRect(32, 34, 56, 8);
    c.fillStyle = INK.paperText; c.font = `600 46px ${LOOK_TYPE.sans}`; c.textBaseline = 'top';
    wrapWords(c, text, 448).slice(0, 4).forEach((l, i) => c.fillText(l, 32, 64 + i * 58, 448));
    return texture;
}
/** The view through a decor window: dusk city (station / skyline) or a soft garden (jungle). */
export function paintWindowView(jungle: boolean): THREE.CanvasTexture | undefined {
    const p = plateCanvas(256, 192); if (!p) return undefined;
    const { c, texture } = p, sky = c.createLinearGradient(0, 0, 0, 192);
    if (jungle) { sky.addColorStop(0, '#f6d29a'); sky.addColorStop(0.55, '#b3cfa6'); sky.addColorStop(1, '#3f6a4f'); }
    else { sky.addColorStop(0, '#141a3a'); sky.addColorStop(0.6, '#3a3a6a'); sky.addColorStop(1, '#c8784e'); }
    c.fillStyle = sky; c.fillRect(0, 0, 256, 192);
    c.fillStyle = jungle ? '#355a3a' : '#191c2c';
    for (let i = 0; i < 12; i++) { const w = 14 + (i * 37) % 18, h = jungle ? 30 + (i * 23) % 30 : 40 + (i * 53) % 70; if (jungle) { c.beginPath(); c.arc(i * 24, 192, h, Math.PI, 0); c.fill(); } else c.fillRect(i * 22, 192 - h, w, h); }
    if (!jungle) { c.fillStyle = '#ffcf96'; for (let i = 0; i < 70; i++) c.fillRect((i * 97) % 256, 120 + (i * 31) % 70, 2, 2); }
    texture.needsUpdate = true;
    return texture;
}

// ------------------------------------------------------------------------------------------------ sky and city
/** An open world's sky dome (pale horizon to deep blue), centred on the camera every frame. */
export function lookSkyDome(): THREE.Mesh {
    const dome = new THREE.SphereGeometry(330, 32, 16), pos = dome.getAttribute('position'), colors: number[] = [];
    const low = new THREE.Color(PALETTE.day.low), high = new THREE.Color(PALETTE.day.high), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) { const t = Math.max(0, pos.getY(i) / 330); c.copy(low).lerp(high, Math.pow(t, 0.6)); colors.push(c.r, c.g, c.b); }
    dome.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(dome, tag(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }), 'sky', false));
    sky.renderOrder = -10; sky.raycast = () => undefined; sky.userData.part = 'sky'; sky.frustumCulled = false;
    sky.onBeforeRender = (_r, _s, camera) => { sky.position.copy(camera.position); sky.updateMatrixWorld(true); };
    return sky;
}
/** The kit's city panorama backdrop: a depth-reprojected sphere around the camera (parallax from the stored depth). */
export function lookCityBackdrop(colorTex: THREE.Texture, depthTex: THREE.Texture, centre: THREE.Vector3): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
        uniforms: { cmap: { value: colorTex }, dmap: { value: depthTex }, C: { value: centre }, gain: { value: 0.9 }, haze: { value: 0.45 }, horizon: { value: 2 }, knee: { value: 0 } },
        vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: `
            uniform sampler2D cmap, dmap; uniform vec3 C; uniform float gain, haze, horizon, knee; varying vec3 vW;
            const float PI = 3.14159265359;
            vec2 puv(vec3 d){ return vec2(fract(atan(d.z, d.x) / (2.0 * PI) + 0.75), asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5); }
            float depthAt(vec3 d){ vec3 e = texture2D(dmap, puv(d)).rgb * 255.0; return exp((e.r * 256.0 + e.g) / 65535.0 * log(6000.0)); }
            void main(){
                vec3 r = normalize(vW - cameraPosition); vec3 m = cameraPosition - C; float b = dot(m, r), c0 = dot(m, m);
                float t = 300.0; vec3 q = m + r * t; float dist = 300.0;
                for (int i = 0; i < 6; i++) { q = m + r * t; dist = depthAt(normalize(q)); t = -b + sqrt(max(b * b - c0 + dist * dist, 0.0)); }
                q = m + r * t; vec3 col = pow(texture2D(cmap, puv(normalize(q))).rgb, vec3(2.2)) * gain;
                col = mix(col, vec3(0.055, 0.045, 0.06), haze * (1.0 - exp(-max(dist - 250.0, 0.0) / 2200.0)));
                col = col * (1.0 + knee * 0.1) / (1.0 + knee * col);
                float above = smoothstep(horizon - 0.05, horizon + 0.01, r.y);
                vec3 sky = mix(vec3(0.085, 0.06, 0.075), vec3(0.035, 0.04, 0.07), smoothstep(horizon, horizon + 0.35, r.y));
                col = mix(col, sky, above);
                gl_FragColor = vec4(col, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: true
    });
    tag(mat, 'city', false);
    const m = new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), mat);
    m.name = 'omo-kit-backdrop'; m.frustumCulled = false; m.renderOrder = -10; m.raycast = () => undefined;
    m.onBeforeRender = (_r, _s, camera) => { m.position.copy(camera.position); m.updateMatrix(); m.updateMatrixWorld(true); };
    return m;
}
/** City panorama textures, prepared like the kit loader does (no mips, raw values; nearest for the depth). */
export function prepareCityTextures(city: THREE.Texture, depth: THREE.Texture): void {
    city.colorSpace = THREE.NoColorSpace; city.generateMipmaps = false; city.minFilter = THREE.LinearFilter;
    depth.colorSpace = THREE.NoColorSpace; depth.generateMipmaps = false; depth.minFilter = depth.magFilter = THREE.NearestFilter;
}
/** Where the lab rendered the city panorama from (kit baked space): world centre = this + the kit offset. */
export const CITY_PANO_CENTRE = { x: 9.0, y: 1.65, z: -6.0 } as const;
/**
 * The kit city backdrop for any skyline world (the procedural speckled towers are gone). Starts loading at once; until
 * the panorama arrives the sphere draws the dusk haze. In Node (no DOM) returns undefined.
 */
export function kitCityBackdrop(base = ''): THREE.Mesh | undefined {
    if (typeof document === 'undefined') return undefined;
    const loader = new THREE.TextureLoader(), url = (f: string): string => base + kitAssetUrl('skyline-penthouse', f);
    const blank = (): THREE.DataTexture => { const t = new THREE.DataTexture(new Uint8Array([22, 20, 34, 255]), 1, 1); t.needsUpdate = true; return t; };
    const mesh = lookCityBackdrop(blank(), blank(), new THREE.Vector3(CITY_PANO_CENTRE.x, CITY_PANO_CENTRE.y, CITY_PANO_CENTRE.z));
    const u = (mesh.material as THREE.ShaderMaterial).uniforms;
    let city: THREE.Texture | undefined, depth: THREE.Texture | undefined;
    const ready = (): void => { if (city && depth) { prepareCityTextures(city, depth); u.cmap.value = city; u.dmap.value = depth; mesh.userData.cityReady = true; mesh.userData.onReady?.(); } };
    city = undefined; depth = undefined;
    loader.load(url('city.jpg'), t => { city = t; ready(); }, undefined, () => { mesh.userData.cityMissing = true; });
    loader.load(url('city_depth.png'), t => { depth = t; ready(); }, undefined, () => { mesh.userData.cityMissing = true; });
    mesh.userData.ownsMap = true;
    return mesh;
}

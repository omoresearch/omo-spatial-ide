/**
 * sky:render — the "skyline" theme: a glass-walled penthouse floor high in a Manhattan tower at dusk.
 *
 * Everything here is procedural (no downloaded assets):
 *   - the interior shell: polished dark stone floor, ceiling with warm light coves, bronze mullions,
 *     floor-to-ceiling glass, dark steel columns, a perimeter uplight strip;
 *   - the city: ~1000 instanced towers on a rotated Manhattan grid, drawn by one shader that paints lit
 *     windows from world position (no textures), with distance haze into the dusk horizon;
 *   - landmarks: a stepped Art Deco spire and a tapered glass tower, a river, lit street grid far below;
 *   - a dusk sky dome (gradient + low sun glow).
 * Interior surfaces facing outwards are single-sided, so the overview camera sees into the floor from above
 * (the same cutaway idea as the classic room). The city sits ~220 m below the floor level (y = 0).
 * Emissive values above 1.0 are what the bloom pass picks up; terminal screens stay <= 1.0 and do not bloom.
 */
import * as THREE from 'three';
import type { WorldShell } from '../common/world-model';
import type { Footprint } from './world-scene-collision';
import { inside } from './world-scene-collision';

/** Height of the floor above the street (metres). */
export const SKYLINE_ALTITUDE = 330;
export const SKYLINE_CEILING = 4.6;
/** Dusk colours shared with RoomScene (background, fog, lights). */
export const SKYLINE_COLORS = { background: '#1a1d33', hemiSky: 0x8fa2d8, sun: 0xffb27a, accent: 0xffc68a } as const;
/** Haze: walking view (metres). The city fades into the horizon colour; the room never does. */
export const SKYLINE_FOG = { near: 400, far: 2600 } as const;

function hash(i: number, salt: number): number {
    const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return s - Math.floor(s);
}

function std(color: number, roughness: number, metalness: number, extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}): THREE.MeshPhysicalMaterial {
    return new THREE.MeshPhysicalMaterial({ color, roughness, metalness, ...extra });
}
function add(parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadows = true): THREE.Mesh {
    const m = new THREE.Mesh(geometry, mat); m.position.set(x, y, z);
    if (shadows) { m.castShadow = true; m.receiveShadow = true; }
    parent.add(m); return m;
}
function emissive(color: number, intensity: number): THREE.MeshBasicMaterial {
    const c = new THREE.Color(color).multiplyScalar(intensity);
    return new THREE.MeshBasicMaterial({ color: c, toneMapped: true });
}
const noRay = (o: THREE.Object3D): THREE.Object3D => { o.traverse(n => { n.raycast = () => undefined; }); return o; };

// ------------------------------------------------------------------------------------------- shaders
const FACADE_VERT = /* glsl */`
    attribute float aSeed;
    attribute float aTone;
    varying vec3 vWorld; varying vec3 vNormalW; varying float vSeed; varying float vTone;
    void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
            m = modelMatrix * instanceMatrix;
        #endif
        vec4 w = m * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormalW = normalize(mat3(m) * normal);
        #ifdef USE_INSTANCING
            vSeed = aSeed; vTone = aTone;
        #else
            vSeed = 0.37; vTone = 0.5;
        #endif
        gl_Position = projectionMatrix * viewMatrix * w;
    }`;
const FACADE_FRAG = /* glsl */`
    uniform vec3 uHorizon; uniform vec3 uSky; uniform vec3 uCam; uniform float uLit; uniform float uFloorH;
    varying vec3 vWorld; varying vec3 vNormalW; varying float vSeed; varying float vTone;
    float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main() {
        vec3 n = normalize(vNormalW);
        float dist = length(vWorld - uCam);
        // Facade base: dark glass / stone, lit a little by the sky from above and the horizon glow.
        vec3 base = mix(vec3(0.020, 0.024, 0.040), vec3(0.055, 0.050, 0.060), vTone);
        float skyLight = 0.5 + 0.5 * n.y;
        vec3 col = base * (0.6 + 1.4 * skyLight) + uHorizon * 0.05 * (1.0 - abs(n.y));
        if (abs(n.y) < 0.5) {
            // Window grid from world position: floors every uFloorH m, bays every 2.6 m along the face.
            vec2 t = abs(n.x) > abs(n.z) ? vWorld.zy : vWorld.xy;
            vec2 g = vec2(t.x / 2.6, t.y / uFloorH);
            vec2 cell = floor(g), f = fract(g);
            float win = step(0.12, f.x) * step(f.x, 0.88) * step(0.22, f.y) * step(f.y, 0.86);
            float r = h21(cell + vSeed * 97.0);
            float lit = step(1.0 - uLit, r);
            // Whole floors tend to be lit together (offices), with a warm / cool mix.
            float floorBias = step(0.72, h21(vec2(cell.y, vSeed * 13.0)));
            lit = max(lit, floorBias * step(0.45, r));
            vec3 warm = vec3(1.0, 0.72, 0.42), cool = vec3(0.70, 0.82, 1.0);
            vec3 light = mix(warm, cool, step(0.78, h21(cell.yx + vSeed)));
            float intensity = mix(0.55, 1.7, h21(cell * 1.7 + vSeed)) * (0.7 + 0.6 * vTone);
            // Unlit windows reflect the dusk sky a little.
            vec3 glass = mix(base * 1.6, uSky * 0.22, 0.5);
            col = mix(col, glass, win * (1.0 - lit));
            col += win * lit * light * intensity;
        } else if (n.y > 0.5) {
            col = base * 0.8; // roofs
        }
        // Distance haze into the horizon colour.
        float haze = smoothstep(200.0, 2600.0, dist);
        // Low haze is thicker: tower bases dissolve into a warm glow, tops stay crisp.
        float low = 1.0 - smoothstep(-220.0, -60.0, vWorld.y);
        vec3 hz = mix(vec3(0.10, 0.10, 0.20), uHorizon * 0.85, smoothstep(-260.0, 60.0, vWorld.y));
        col = mix(col, hz, clamp(haze * 0.75 + low * 0.3 * haze, 0.0, 0.88));
        gl_FragColor = vec4(col, 1.0);
    }`;
const SKY_VERT = /* glsl */`
    varying vec3 vDir;
    void main() { vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; }`;
const SKY_FRAG = /* glsl */`
    uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uSun; uniform vec3 uSunDir;
    varying vec3 vDir;
    void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uMid, smoothstep(-0.02, 0.18, h));
        col = mix(col, uTop, smoothstep(0.18, 0.75, h));
        col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.35, h));
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSun * (pow(s, 5.0) * 0.6 + pow(s, 40.0) * 0.5) * smoothstep(-0.12, 0.04, h);
        gl_FragColor = vec4(col, 1.0);
    }`;
const STREET_FRAG = /* glsl */`
    uniform vec3 uCam; uniform vec3 uHorizon;
    varying vec3 vWorld;
    void main() {
        // Rotated Manhattan grid: avenues every 260 m, streets every 80 m, with headlight-coloured glow.
        float a = 0.506;
        vec2 p = vec2(cos(a) * vWorld.x - sin(a) * vWorld.z, sin(a) * vWorld.x + cos(a) * vWorld.z);
        float ave = 1.0 - smoothstep(0.0, 6.0, abs(mod(p.x, 260.0) - 130.0) - 8.0);
        float st = 1.0 - smoothstep(0.0, 3.0, abs(mod(p.y, 80.0) - 40.0) - 4.0);
        vec3 col = vec3(0.012, 0.012, 0.018);
        col += vec3(1.0, 0.58, 0.26) * ave * 0.9 + vec3(0.9, 0.7, 0.5) * st * 0.35;
        float dist = length(vWorld - uCam);
        col = mix(col, uHorizon * 0.8, smoothstep(300.0, 1700.0, dist) * 0.9);
        gl_FragColor = vec4(col, 1.0);
    }`;
const STREET_VERT = /* glsl */`
    varying vec3 vWorld;
    void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

const DUSK = { top: new THREE.Color(0x070a22), mid: new THREE.Color(0x232454), horizon: new THREE.Color(0xc8684e), sun: new THREE.Color(0xff8a4a) };

function facadeMaterial(camera: { position: THREE.Vector3 }, lit = 0.16): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
        vertexShader: FACADE_VERT, fragmentShader: FACADE_FRAG,
        uniforms: { uHorizon: { value: DUSK.horizon.clone().multiplyScalar(0.55) }, uSky: { value: DUSK.mid }, uCam: { value: camera.position }, uLit: { value: lit }, uFloorH: { value: 3.8 } }
    });
    return mat;
}

/** The camera whose position drives distance haze (set by RoomScene). Shared uniform object. */
export interface SkylineCamera { position: THREE.Vector3 }

// ------------------------------------------------------------------------------------------- city
function buildCity(root: THREE.Group, camera: SkylineCamera): void {
    const city = new THREE.Group(); city.name = 'omo-skyline-city';
    const ground = -SKYLINE_ALTITUDE;
    // Rotated grid (Manhattan's ~29° tilt), blocks 260 x 80 m with 2-5 towers each.
    const angle = 0.506, cos = Math.cos(angle), sin = Math.sin(angle);
    const towers: Array<{ x: number; z: number; w: number; d: number; h: number; tone: number; seed: number }> = [];
    let i = 0;
    for (let gx = -11; gx <= 11; gx++) for (let gz = -30; gz <= 30; gz++) {
        const bx = gx * 260, bz = gz * 80;
        const n = 2 + Math.floor(hash(gx * 101 + gz, 1) * 3);
        for (let k = 0; k < n; k++) {
            i++;
            const lx = bx - 110 + (k + 0.5) * (220 / n) + (hash(i, 2) - 0.5) * 12, lz = bz + (hash(i, 3) - 0.5) * 18;
            const x = cos * lx + sin * lz, z = -sin * lx + cos * lz;
            const r = Math.hypot(x, z);
            if (r < 170 || r > 2400) continue;
            // River to the west (x < -650): no towers in the water band.
            if (x < -620 && x > -1050) continue;
            // Most towers sit below our floor (we look down on them); a few supertalls rise past it, further out.
            const midtown = Math.exp(-Math.pow((r - 700) / 600, 2));
            const near = Math.min(1, (r - 170) / 500);
            let h = 30 + Math.pow(hash(i, 4), 2.2) * (140 + 300 * midtown * near) + 60 * midtown;
            // Within ~600 m nothing rises past our floor except rare towers: the view looks DOWN onto roofs.
            const supertall = hash(i, 9) > 0.985 && r > 500;
            const cap = supertall ? SKYLINE_ALTITUDE + 60 : SKYLINE_ALTITUDE * Math.min(0.85, 0.35 + r / 2400);
            h = Math.min(h, cap);
            towers.push({ x, z, w: 22 + hash(i, 5) * 34, d: 24 + hash(i, 6) * 40, h, tone: hash(i, 7), seed: hash(i, 8) });
        }
    }
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, facadeMaterial(camera), towers.length);
    const seeds = new Float32Array(towers.length), tones = new Float32Array(towers.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    towers.forEach((t, j) => {
        m.compose(new THREE.Vector3(t.x, ground, t.z), q, new THREE.Vector3(t.w, t.h, t.d));
        mesh.setMatrixAt(j, m); seeds[j] = t.seed; tones[j] = t.tone;
    });
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    geo.setAttribute('aTone', new THREE.InstancedBufferAttribute(tones, 1));
    mesh.frustumCulled = false; city.add(mesh);
    // Setbacks / crowns on the tallest towers: a smaller box on top.
    const tall = towers.filter(t => t.h > 210);
    const crown = new THREE.InstancedMesh(geo, facadeMaterial(camera, 0.5), tall.length);
    tall.forEach((t, j) => { m.compose(new THREE.Vector3(t.x, ground + t.h, t.z), q, new THREE.Vector3(t.w * 0.62, 18 + t.seed * 30, t.d * 0.62)); crown.setMatrixAt(j, m); });
    const cSeeds = new Float32Array(tall.length).map((_, j) => tall[j].seed), cTones = new Float32Array(tall.length).map((_, j) => tall[j].tone);
    crown.geometry = geo.clone();
    crown.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(cSeeds, 1));
    crown.geometry.setAttribute('aTone', new THREE.InstancedBufferAttribute(cTones, 1));
    crown.frustumCulled = false; city.add(crown);
    // Aircraft warning lights on the tallest roofs.
    const red = emissive(0xff2a1a, 6);
    const dot = new THREE.SphereGeometry(1.1, 8, 6);
    for (const t of tall.slice(0, 60)) add(city, dot, red, t.x, ground + t.h + 20 + t.seed * 30, t.z, false);
    landmarks(city, camera, ground);
    // Street grid far below and the river.
    const streets = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.ShaderMaterial({ vertexShader: STREET_VERT, fragmentShader: STREET_FRAG, uniforms: { uCam: { value: camera.position }, uHorizon: { value: DUSK.horizon.clone().multiplyScalar(0.45) } } }));
    streets.rotation.x = -Math.PI / 2; streets.position.y = ground; city.add(streets);
    const river = new THREE.Mesh(new THREE.PlaneGeometry(430, 5000), std(0x0b0f1c, 0.08, 0.9, { envMapIntensity: 1.4 }));
    river.rotation.x = -Math.PI / 2; river.position.set(-835, ground + 0.5, 0); city.add(river);
    root.add(noRay(city));
}

function landmarks(city: THREE.Group, camera: SkylineCamera, ground: number): void {
    const mat = facadeMaterial(camera, 0.55);
    const stack = (x: number, z: number, parts: Array<[number, number, number]>): number => {
        let y = ground;
        for (const [w, d, h] of parts) { const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0); add(city, g, mat, x, y, z, false); y += h; }
        return y;
    };
    // Art Deco stepped tower with a lit crown and mast (north-east, ~560 m away).
    const ex = 300, ez = -470;
    const top = stack(ex, ez, [[60, 44, 150], [44, 34, 70], [30, 24, 45], [20, 16, 30], [12, 10, 20]]);
    const crownLight = emissive(0xffd9a0, 4.5);
    for (let k = 0; k < 4; k++) { const g = new THREE.BoxGeometry(14 - k * 2.6, 4, 12 - k * 2.2); add(city, g, crownLight, ex, top - 22 + k * 6, ez, false); }
    const mast = new THREE.CylinderGeometry(0.6, 2.2, 62, 8); mast.translate(0, 31, 0);
    add(city, mast, std(0x9aa0a8, 0.4, 0.8), ex, top, ez, false);
    add(city, new THREE.SphereGeometry(1.6, 8, 6), emissive(0xff3322, 8), ex, top + 63, ez, false);
    // Tapered glass supertall (south, ~700 m away) with a spire.
    const tx = -260, tz = 900;
    const taper = new THREE.CylinderGeometry(16, 44, 420, 4, 1); taper.rotateY(Math.PI / 4); taper.translate(0, 210, 0);
    add(city, taper, mat, tx, ground, tz, false);
    const spire = new THREE.CylinderGeometry(0.4, 2.4, 110, 6); spire.translate(0, 55, 0);
    add(city, spire, emissive(0xdde8ff, 2.2), tx, ground + 420, tz, false);
}

function buildSky(root: THREE.Group): void {
    const sun = new THREE.Vector3(-0.92, -0.015, 0.38).normalize(); // just below the horizon: afterglow, no disc
    const sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 48, 24), new THREE.ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { uTop: { value: DUSK.top }, uMid: { value: DUSK.mid }, uHorizon: { value: DUSK.horizon }, uSun: { value: DUSK.sun }, uSunDir: { value: sun } }
    }));
    sky.name = 'omo-skyline-sky'; sky.renderOrder = -10; sky.frustumCulled = false;
    root.add(noRay(sky));
}

// ------------------------------------------------------------------------------------------- interior
export function buildSkylineShell(shell: WorldShell, blocks: readonly Footprint[], camera: SkylineCamera): THREE.Group {
    const root = new THREE.Group(); root.name = 'omo-world-shell';
    const W = shell.width, D = shell.depth, hw = W / 2, hd = D / 2, H = SKYLINE_CEILING;
    const free = (x: number, z: number): boolean => !blocks.some(f => inside(f, x, z, 0.1));
    // Floor: polished dark stone with a lighter inlay border.
    const floor = add(root, new THREE.BoxGeometry(W, 0.2, D), std(0x2a2a2e, 0.34, 0.05, { clearcoat: 0.5, clearcoatRoughness: 0.25 }), 0, -0.1, 0);
    floor.castShadow = false;
    const inlay = std(0x8a6b45, 0.3, 0.9);
    for (const [w, d, x, z] of [[W - 1.2, 0.05, 0, -hd + 0.6], [W - 1.2, 0.05, 0, hd - 0.6], [0.05, D - 1.2, -hw + 0.6, 0], [0.05, D - 1.2, hw - 0.6, 0]] as const)
        add(root, new THREE.BoxGeometry(w, 0.012, d), inlay, x, 0.006, z, false);
    // Building slab below the floor (seen when looking down through the glass) + our tower's facade.
    add(root, new THREE.BoxGeometry(W + 0.6, 0.9, D + 0.6), std(0x0d0e12, 0.6, 0.2), 0, -0.65, 0, false);
    const towerH = SKYLINE_ALTITUDE - 1.1;
    const tower = new THREE.BoxGeometry(W + 2, towerH, D + 2); tower.translate(0, -towerH / 2 - 1.1, 0);
    const facade = new THREE.Mesh(tower, facadeMaterial(camera, 0.4)); facade.name = 'omo-skyline-tower'; root.add(noRay(facade));
    // Ceiling (faces down only, so the overview sees in from above) with warm coves.
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), std(0x3a3833, 0.85, 0.0));
    ceiling.rotation.x = Math.PI / 2; ceiling.position.y = H; ceiling.receiveShadow = true; root.add(ceiling);
    const cove = emissive(0xffc98e, 3.0);
    const coveMat = new THREE.MeshBasicMaterial({ color: cove.color, side: THREE.BackSide });
    for (const [w, d, x, z] of [[W - 3, 0.12, 0, -hd + 1.5], [W - 3, 0.12, 0, hd - 1.5], [0.12, D - 3, -hw + 1.5, 0], [0.12, D - 3, hw - 1.5, 0]] as const) {
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(w, d), coveMat); strip.rotation.x = -Math.PI / 2; strip.position.set(x, H - 0.01, z); root.add(noRay(strip));
    }
    // Linear pendant lights over the middle.
    const pendant = emissive(0xffe2b8, 1.8);
    const bodyMat = std(0x141416, 0.4, 0.8);
    const rows = Math.max(1, Math.round(D / 6));
    for (let r = 0; r < rows; r++) {
        const z = -hd + (r + 0.5) * (D / rows);
        const len = Math.min(W - 6, 7);
        add(root, new THREE.BoxGeometry(len, 0.06, 0.12), bodyMat, 0, H - 0.9, z, false);
        add(root, new THREE.BoxGeometry(len - 0.1, 0.02, 0.08), pendant, 0, H - 0.94, z, false);
        for (const x of [-len / 2 + 0.3, len / 2 - 0.3]) add(root, new THREE.CylinderGeometry(0.006, 0.006, 0.9, 4), bodyMat, x, H - 0.45, z, false);
    }
    // Glass curtain wall: panes face inwards only (visible from inside; transparent from the overview).
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fb6c8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, envMapIntensity: 1.6, side: THREE.FrontSide, depthWrite: false });
    const bronze = std(0x6b5236, 0.35, 0.85);
    const sides: Array<{ len: number; at: (s: number) => [number, number]; rot: number }> = [
        { len: W, at: s => [s, -hd], rot: 0 }, { len: W, at: s => [s, hd], rot: Math.PI },
        { len: D, at: s => [-hw, s], rot: Math.PI / 2 }, { len: D, at: s => [hw, s], rot: -Math.PI / 2 }
    ];
    for (const side of sides) {
        const [cx, cz] = side.at(0);
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(side.len, H), glass);
        pane.position.set(cx, H / 2, cz); pane.rotation.y = side.rot; pane.renderOrder = 2; root.add(noRay(pane));
        const bays = Math.max(2, Math.round(side.len / 3));
        for (let b = 0; b <= bays; b++) {
            const s = -side.len / 2 + b * side.len / bays;
            const [x, z] = side.at(s);
            add(root, new THREE.BoxGeometry(0.035, H, 0.08), bronze, x, H / 2, z, false).rotation.y = side.rot;
        }
        const rail = new THREE.BoxGeometry(side.len, 0.08, 0.14);
        add(root, rail, bronze, cx, 0.04, cz, false).rotation.y = side.rot;
        add(root, rail, bronze, cx, H - 0.04, cz, false).rotation.y = side.rot;
        // Perimeter uplight strip just inside the glass.
        const ux = cx - Math.sign(cx) * 0.35, uz = cz - Math.sign(cz) * 0.35;
        const up = add(root, new THREE.BoxGeometry(side.len - 0.8, 0.02, 0.05), emissive(0xffb070, 2.0), ux, 0.012, uz, false); up.rotation.y = side.rot;
    }
    // Structural columns: dark steel, set in from the glass.
    const colMat = std(0x1c1d22, 0.32, 0.65);
    void colMat; // open glass corners: the view is the room's feature
    // A low lounge island: marble plinth + rug where it is free (front left).
    // Warm fill from the coves and pendants (the emissive strips alone light nothing).
    for (let r = 0; r < rows; r++) {
        const z = -hd + (r + 0.5) * (D / rows);
        for (const x of [-W / 4, W / 4]) { const p = new THREE.PointLight(0xffc690, 3.2, 14, 1.2); p.position.set(x, H - 0.3, z); root.add(p); }
    }
    buildSky(root);
    buildCity(root, camera);
    return root;
}

/**
 * sky:render — restyle a built desk/decor group for the penthouse: walnut desk tops, graphite steel, cognac leather
 * seats, brushed brass trim. Only MeshStandardMaterial colours/roughness change; geometry, the screen and the name
 * plate (MeshBasicMaterial) are untouched, so terminal text, raycasts and footprints stay exactly as before.
 */
export function restyleForSkyline(root: THREE.Object3D): void {
    const map = new Map<number, Partial<THREE.MeshStandardMaterialParameters>>([
        [0xd2c9b5, { color: 0x4a2f20, roughness: 0.38, metalness: 0.05 }],   // desk top -> walnut
        [0x374656, { color: 0x1e1f23, roughness: 0.3, metalness: 0.8 }],     // legs / chair base -> graphite steel
        [0x648697, { color: 0x2b2a2e, roughness: 0.7, metalness: 0.0 }],     // seat + back -> charcoal wool    // seat + back -> cognac leather
        [0x293645, { color: 0x15161a, roughness: 0.35, metalness: 0.6 }],
        [0x435664, { color: 0x8a6b45, roughness: 0.3, metalness: 0.9 }],     // monitor stem -> brass
        [0x17222e, { color: 0x0d0e11, roughness: 0.25, metalness: 0.5 }],    // monitor bezel
        [0x344353, { color: 0x1a1b1f, roughness: 0.4, metalness: 0.4 }],     // keyboard
        [0xc9a478, { color: 0xe9e4da, roughness: 0.2, metalness: 0.0 }],     // cup -> porcelain
        [0x2a3644, { color: 0x15161a, roughness: 0.4, metalness: 0.6 }]
    ]);
    root.traverse(node => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material as THREE.MeshStandardMaterial;
        if (!m || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
        const next = map.get(m.color.getHex());
        if (!next) return;
        const r = m.clone(); r.setValues(next); mesh.material = r; m.dispose();
    });
}

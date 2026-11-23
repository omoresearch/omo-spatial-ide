// Omo sky lab — first-person walk physics (ES module, three r180).
//
//   import { Walker } from './walk.js';
//   const w = new Walker(camera, renderer.domElement, { colliders: [mesh, group], eye: 1.65, spawn: { x, y, z, yaw } });
//   w.update(dt);           // every frame (fixed 120 Hz substeps inside, render interpolation)
//   w.setColliders([...]);  // rebuild static collision from real scene meshes (world-space triangles)
//   w.pose / w.setPose(p)   // { x, y, z, yaw, pitch }  — y is the FEET height (eye = y + eye height)
//
// Body: a capsule (radius 0.3, height 1.8) whose lowest `stepHeight` metres are carried by a ground probe
// (5 vertical rays) instead of the capsule. Anything lower than the step height (rugs, a single step) is stepped
// onto; anything taller hits the capsule and blocks/slides. Contacts that are too steep to stand on are flattened to
// horizontal while grounded, so edges of boxes and tables act like walls rather than ramps.
// Collision is exact capsule-vs-triangle (closest points segment/triangle) against a uniform grid of the scene's
// world-space triangles, so walls, furniture and glass all block. No external libraries.
import * as THREE from 'three';

const DEFAULTS = {
    radius: 0.3,
    height: 1.8,
    crouchHeight: 1.15,
    eye: 1.65,
    crouchEye: 1.05,
    stepHeight: 0.3,          // highest ledge that is stepped up automatically
    snapDown: 0.32,           // stay glued to the floor going down steps of this size
    walkableNormalY: 0.7,     // ~45 degrees
    walkSpeed: 3.2,           // m/s
    sprintSpeed: 5.6,
    crouchSpeed: 1.4,
    groundAccel: 9,           // 1/s: reach ~63% of target speed in 0.11 s, ~95% in 0.33 s
    airAccel: 0.9,            // slight air control (fraction of wish speed per second)
    friction: 10,             // 1/s when no input: stop in ~0.35 s
    gravity: 13.0,            // a touch above 9.81 so jumps do not feel floaty
    jumpSpeed: 4.6,           // apex ~0.81 m
    maxFallSpeed: 30,         // 0.25 m per 120 Hz step: less than the step band, so the probe can always see the floor
    coyoteTime: 0.1,
    jumpBuffer: 0.15,
    fixedHz: 120,
    maxSubsteps: 15,
    respawnY: -5,
    lookSensitivity: 0.0022,
    lookSmoothing: 0.035,     // seconds (time constant); 0 = raw
    maxPitch: THREE.MathUtils.degToRad(89),
    bobWalk: 0.026,
    bobSprint: 0.042,
    strideWalk: 0.72,         // metres per footstep
    strideSprint: 0.95,
    gridCell: 0.5,            // metres; measured 3x faster contact than 1.0 on a 200k-triangle mesh
    keyboard: true,
    pointerLock: true,
};

// ---------------------------------------------------------------------------------------------------------------
// Static triangle soup in a uniform grid
// ---------------------------------------------------------------------------------------------------------------
class TriangleGrid {
    constructor(cell) { this.cell = cell; this.clear(); }

    clear() {
        this.tris = new Float32Array(0);   // 9 floats per triangle
        this.norms = new Float32Array(0);  // 3 floats per triangle (unit face normal)
        this.bounds = new Float32Array(0);
        this.twoSided = new Uint8Array(0);
        this.count = 0;
        this.cells = new Map();
        this.large = [];
        this.stamp = new Uint32Array(0);
        this.stampId = 0;
    }

    build(objects) {
        this.clear();
        const pos = [], sided = [];
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), im = new THREE.Matrix4();
        const visit = (o) => {
            if (!o.isMesh || !o.geometry || o.userData.noCollide) return;
            const g = o.geometry, p = g.attributes.position;
            if (!p) return;
            o.updateWorldMatrix(true, false);
            const idx = g.index;
            const n = idx ? idx.count : p.count;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            const two = o.userData.twoSided ?? mats.some(m => m && m.side === THREE.DoubleSide);
            const emit = (m) => {
                for (let i = 0; i + 2 < n; i += 3) {
                    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
                    a.fromBufferAttribute(p, i0).applyMatrix4(m);
                    b.fromBufferAttribute(p, i1).applyMatrix4(m);
                    c.fromBufferAttribute(p, i2).applyMatrix4(m);
                    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
                    sided.push(two ? 1 : 0);
                }
            };
            if (o.isInstancedMesh) {   // instanced furniture: one copy of the triangles per instance
                for (let k = 0; k < o.count; k++) { o.getMatrixAt(k, im); emit(im.premultiply(o.matrixWorld)); }
            } else emit(o.matrixWorld);
        };
        for (const obj of objects || []) { if (obj) obj.traverse ? obj.traverse(visit) : visit(obj); }
        const tris = new Float32Array(pos), count = tris.length / 9;
        const norms = new Float32Array(count * 3);
        const keep = [];
        for (let t = 0; t < count; t++) {
            const o = t * 9;
            const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
            const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz);
            if (l < 1e-10) continue; // degenerate
            norms[t * 3] = nx / l; norms[t * 3 + 1] = ny / l; norms[t * 3 + 2] = nz / l;
            keep.push(t);
        }
        // compact (drop degenerate triangles); per triangle also a bounding sphere (cx,cy,cz,r) and a two-sided flag
        this.tris = new Float32Array(keep.length * 9);
        this.norms = new Float32Array(keep.length * 3);
        this.bounds = new Float32Array(keep.length * 4);
        this.twoSided = new Uint8Array(keep.length);
        keep.forEach((t, i) => {
            const o = t * 9;
            this.tris.set(tris.subarray(o, o + 9), i * 9); this.norms.set(norms.subarray(t * 3, t * 3 + 3), i * 3);
            const cx = (tris[o] + tris[o + 3] + tris[o + 6]) / 3, cy = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3, cz = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
            let r2 = 0;
            for (let k = 0; k < 9; k += 3) r2 = Math.max(r2, (tris[o + k] - cx) ** 2 + (tris[o + k + 1] - cy) ** 2 + (tris[o + k + 2] - cz) ** 2);
            this.bounds[i * 4] = cx; this.bounds[i * 4 + 1] = cy; this.bounds[i * 4 + 2] = cz; this.bounds[i * 4 + 3] = Math.sqrt(r2);
            this.twoSided[i] = sided[t];
        });
        this.count = keep.length;
        this.stamp = new Uint32Array(this.count);
        const s = this.cell, T = this.tris;
        for (let t = 0; t < this.count; t++) {
            const o = t * 9;
            const x0 = Math.floor(Math.min(T[o], T[o + 3], T[o + 6]) / s), x1 = Math.floor(Math.max(T[o], T[o + 3], T[o + 6]) / s);
            const y0 = Math.floor(Math.min(T[o + 1], T[o + 4], T[o + 7]) / s), y1 = Math.floor(Math.max(T[o + 1], T[o + 4], T[o + 7]) / s);
            const z0 = Math.floor(Math.min(T[o + 2], T[o + 5], T[o + 8]) / s), z1 = Math.floor(Math.max(T[o + 2], T[o + 5], T[o + 8]) / s);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) { this.large.push(t); continue; }
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
                const k = key(x, y, z);
                let list = this.cells.get(k);
                if (!list) this.cells.set(k, list = []);
                list.push(t);
            }
        }
        return this.count;
    }

    // Calls fn(triIndex) once for every triangle whose cells overlap the box.
    query(minX, minY, minZ, maxX, maxY, maxZ, fn) {
        if (!this.count) return;
        if (++this.stampId === 0xffffffff) { this.stamp.fill(0); this.stampId = 1; }
        const id = this.stampId, st = this.stamp, s = this.cell;
        for (const t of this.large) { st[t] = id; fn(t); }
        const x0 = Math.floor(minX / s), x1 = Math.floor(maxX / s), y0 = Math.floor(minY / s), y1 = Math.floor(maxY / s);
        const z0 = Math.floor(minZ / s), z1 = Math.floor(maxZ / s);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
            const list = this.cells.get(key(x, y, z));
            if (!list) continue;
            for (let i = 0; i < list.length; i++) { const t = list[i]; if (st[t] !== id) { st[t] = id; fn(t); } }
        }
    }
}
function key(x, y, z) { return ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096); }

// ---------------------------------------------------------------------------------------------------------------
// Geometry helpers (scalar, allocation-free)
// ---------------------------------------------------------------------------------------------------------------
const CP = new Float64Array(3);   // closestPtTri result
const SS = new Float64Array(6);   // segSeg result: p on seg1, q on seg2
const ST = new Float64Array(6);   // segTri result: point on segment, point on triangle

// Ericson, Real-Time Collision Detection 5.1.5
function closestPtTri(px, py, pz, T, o) {
    const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { CP[0] = ax; CP[1] = ay; CP[2] = az; return; }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { CP[0] = bx; CP[1] = by; CP[2] = bz; return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); CP[0] = ax + v * abx; CP[1] = ay + v * aby; CP[2] = az + v * abz; return; }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { CP[0] = cx; CP[1] = cy; CP[2] = cz; return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); CP[0] = ax + w * acx; CP[1] = ay + w * acy; CP[2] = az + w * acz; return; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        CP[0] = bx + w * (cx - bx); CP[1] = by + w * (cy - by); CP[2] = bz + w * (cz - bz); return;
    }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    CP[0] = ax + abx * v + acx * w; CP[1] = ay + aby * v + acy * w; CP[2] = az + abz * v + acz * w;
}

// Ericson 5.1.9 — closest points of segments p1q1 and p2q2
function segSeg(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
    const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z, d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
    const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
    let s, t;
    if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
    else if (a <= 1e-12) { s = 0; t = clamp01(f / e); }
    else {
        const c = d1x * rx + d1y * ry + d1z * rz;
        if (e <= 1e-12) { t = 0; s = clamp01(-c / a); }
        else {
            const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
            s = den !== 0 ? clamp01((b * f - c * e) / den) : 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
        }
    }
    SS[0] = p1x + d1x * s; SS[1] = p1y + d1y * s; SS[2] = p1z + d1z * s;
    SS[3] = p2x + d2x * t; SS[4] = p2y + d2y * t; SS[5] = p2z + d2z * t;
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Closest points between segment (p,q) and triangle t. Returns squared distance (0 when they intersect).
function segTri(px, py, pz, qx, qy, qz, T, N, t) {
    const o = t * 9, no = t * 3;
    const nx = N[no], ny = N[no + 1], nz = N[no + 2];
    const ax = T[o], ay = T[o + 1], az = T[o + 2];
    const dp = (px - ax) * nx + (py - ay) * ny + (pz - az) * nz, dq = (qx - ax) * nx + (qy - ay) * ny + (qz - az) * nz;
    if (dp * dq <= 0 && dp !== dq) {
        const s = dp / (dp - dq);
        const ix = px + (qx - px) * s, iy = py + (qy - py) * s, iz = pz + (qz - pz) * s;
        closestPtTri(ix, iy, iz, T, o);
        if ((CP[0] - ix) ** 2 + (CP[1] - iy) ** 2 + (CP[2] - iz) ** 2 < 1e-12) { ST[0] = ST[3] = ix; ST[1] = ST[4] = iy; ST[2] = ST[5] = iz; return 0; }
    }
    let best = Infinity;
    const take = (sx, sy, sz, tx, ty, tz) => {
        const d = (sx - tx) ** 2 + (sy - ty) ** 2 + (sz - tz) ** 2;
        if (d < best) { best = d; ST[0] = sx; ST[1] = sy; ST[2] = sz; ST[3] = tx; ST[4] = ty; ST[5] = tz; }
    };
    closestPtTri(px, py, pz, T, o); take(px, py, pz, CP[0], CP[1], CP[2]);
    closestPtTri(qx, qy, qz, T, o); take(qx, qy, qz, CP[0], CP[1], CP[2]);
    for (let e = 0; e < 3; e++) {
        const i = o + e * 3, j = o + ((e + 1) % 3) * 3;
        segSeg(px, py, pz, qx, qy, qz, T[i], T[i + 1], T[i + 2], T[j], T[j + 1], T[j + 2]);
        take(SS[0], SS[1], SS[2], SS[3], SS[4], SS[5]);
    }
    return best;
}

// Downward vertical ray against triangle (two-sided). Returns hit distance or -1; writes normal y (facing up) to RN.
const RN = new Float64Array(1);
let TWO = new Uint8Array(0);
function rayDownTri(ox, oy, oz, maxT, T, N, t) {
    const o = t * 9;
    // project onto XZ: barycentric test of (ox,oz) inside triangle
    const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
    const ny = N[t * 3 + 1];
    if (Math.abs(ny) < 1e-6) return -1; // vertical triangle, ray parallel
    if (ny < 0 && !TWO[t]) return -1;   // underside of a solid (e.g. lower half of a ball): not a floor
    const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    const u = ((bx - ox) * (cz - oz) - (cx - ox) * (bz - oz)) / d;
    const v = ((cx - ox) * (az - oz) - (ax - ox) * (cz - oz)) / d;
    const w = 1 - u - v;
    const eps = -1e-7;
    if (u < eps || v < eps || w < eps) return -1;
    const y = u * T[o + 1] + v * T[o + 4] + w * T[o + 7];
    const dist = oy - y;
    if (dist < 0 || dist > maxT) return -1;
    RN[0] = Math.abs(ny);
    return dist;
}

// ---------------------------------------------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------------------------------------------
const KEYMAP = {
    KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
    Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', ControlLeft: 'crouch', ControlRight: 'crouch', KeyC: 'crouch',
};

export class Walker {
    constructor(camera, domElement, opts = {}) {
        this.camera = camera;
        this.dom = domElement || null;
        this.opts = { ...DEFAULTS, ...opts };
        this.grid = new TriangleGrid(this.opts.gridCell);
        this.input = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, crouch: false };
        this.position = new THREE.Vector3();   // feet
        this.velocity = new THREE.Vector3();
        this.yaw = 0; this.pitch = 0; this.targetYaw = 0; this.targetPitch = 0;
        this.enabled = true;
        this.beforeStep = null;   // optional hook(walker, dt) called before every fixed step (scripted input)
        this.onStep = null;       // footstep callback(walker)
        this.onLand = null;       // callback(walker, impactSpeed)
        this.onJump = null;
        this.afterStep = null;    // optional hook(walker) after every fixed step (telemetry)
        this.stepCount = 0; this.jumpCount = 0; this.respawnCount = 0; this.simSteps = 0;
        const s = opts.spawn || {};
        this.spawn = { x: s.x || 0, y: s.y || 0, z: s.z || 0, yaw: s.yaw || 0, pitch: s.pitch || 0 };
        this._prev = { x: 0, y: 0, z: 0, bobY: 0, bobX: 0, vis: 0, eye: 0 };
        this._cur = { x: 0, y: 0, z: 0, bobY: 0, bobX: 0, vis: 0, eye: 0 };
        this._acc = 0;
        this._listeners = [];
        this.setColliders(opts.colliders || []);
        this.setPose(this.spawn);
        if (this.dom) this._bindDom();
    }

    get h() { return 1 / this.opts.fixedHz; }
    get pose() { return { x: this.position.x, y: this.position.y, z: this.position.z, yaw: this.yaw, pitch: this.pitch }; }
    set pose(p) { this.setPose(p); }
    get eyeHeight() { return this._cur.eye; }
    get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }
    // camera offset from (feet + eye height) caused by head bob and landing/step smoothing, at the last fixed step
    get bobOffset() { return this._cur.bobY + this._cur.vis; }

    setColliders(list) { this.colliders = list; this.triangleCount = this.grid.build(list); return this.triangleCount; }

    setPose(p) {
        const o = this.opts;
        if (p.x !== undefined) this.position.x = p.x;
        if (p.y !== undefined) this.position.y = p.y;
        if (p.z !== undefined) this.position.z = p.z;
        if (p.yaw !== undefined) this.yaw = this.targetYaw = p.yaw;
        if (p.pitch !== undefined) this.pitch = this.targetPitch = clampPitch(p.pitch, o.maxPitch);
        this.velocity.set(0, 0, 0);
        this.crouched = !!p.crouched;
        this.bodyHeight = this.crouched ? o.crouchHeight : o.height;
        this.grounded = false; this._coyote = 0; this._jumpBuf = 0; this._prevJump = false;
        this._bobPhase = 0; this._bobWeight = 0; this._visOffset = 0;
        this._groundProbe(true);
        const c = this._cur;
        c.x = this.position.x; c.y = this.position.y; c.z = this.position.z; c.bobX = c.bobY = c.vis = 0;
        c.eye = this.crouched ? o.crouchEye : o.eye;
        Object.assign(this._prev, c);
        this._acc = 0;
        this.syncCamera(1);
    }

    look(dx, dy) {
        const o = this.opts;
        this.targetYaw -= dx * o.lookSensitivity;
        this.targetPitch = clampPitch(this.targetPitch - dy * o.lookSensitivity, o.maxPitch);
    }

    // Per-frame entry point. Variable dt in, fixed 120 Hz physics inside, interpolated camera out.
    update(dt) {
        if (!this.enabled) return;
        dt = Math.min(Math.max(dt || 0, 0), 0.25);
        const o = this.opts;
        const a = o.lookSmoothing > 0 ? 1 - Math.exp(-dt / o.lookSmoothing) : 1;
        this.yaw += (this.targetYaw - this.yaw) * a;
        this.pitch += (this.targetPitch - this.pitch) * a;
        this._acc += dt;
        const h = this.h;
        let n = 0;
        while (this._acc >= h - 1e-9 && n < o.maxSubsteps) { this.stepFixed(); this._acc -= h; n++; }
        if (n === o.maxSubsteps) this._acc = 0; // spiral-of-death guard: drop the backlog
        this.syncCamera(Math.min(Math.max(this._acc / h, 0), 1));
    }

    // One fixed physics step. Public so deterministic replays can drive it directly.
    stepFixed() {
        const o = this.opts, h = this.h, P = this._prev, C = this._cur;
        Object.assign(P, C);
        if (this.beforeStep) this.beforeStep(this, h);
        const inp = this.input, v = this.velocity;

        // crouch / stand (stand only when there is head room)
        if (inp.crouch && !this.crouched) { this.crouched = true; this.bodyHeight = o.crouchHeight; }
        else if (!inp.crouch && this.crouched && this._canStand()) { this.crouched = false; this.bodyHeight = o.height; }

        // wish direction from yaw (camera looks down -Z at yaw 0)
        const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
        const mz = (inp.forward ? 1 : 0) - (inp.back ? 1 : 0), mx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
        let wx = -sy * mz + cy * mx, wz = -cy * mz - sy * mx;
        const wl = Math.hypot(wx, wz);
        if (wl > 0) { wx /= wl; wz /= wl; }
        const wishSpeed = wl === 0 ? 0 : this.crouched ? o.crouchSpeed : (inp.sprint && mz > 0) ? o.sprintSpeed : o.walkSpeed;

        if (this.grounded) {
            // exponential approach to the wish velocity: smooth start, smooth stop, and sliding along a wall runs
            // at the wall-parallel part of the wish (no Quake-style speed gain)
            const k = 1 - Math.exp(-(wl > 0 ? o.groundAccel : o.friction) * h);
            v.x += (wx * wishSpeed - v.x) * k; v.z += (wz * wishSpeed - v.z) * k;
            if (wl === 0 && Math.hypot(v.x, v.z) < 0.02) { v.x = 0; v.z = 0; }
        } else if (wl > 0) {
            accelerate(v, wx, wz, wishSpeed, o.airAccel, h);
        }

        // jump: edge-triggered with buffer + coyote time
        if (inp.jump && !this._prevJump) this._jumpBuf = o.jumpBuffer;
        this._prevJump = inp.jump;
        if (this._jumpBuf > 0 && (this.grounded || this._coyote > 0) && !this.crouched) {
            v.y = o.jumpSpeed; this.grounded = false; this._coyote = 0; this._jumpBuf = 0; this._jumping = true;
            this.jumpCount++; if (this.onJump) this.onJump(this);
        }
        this._jumpBuf = Math.max(0, this._jumpBuf - h);

        if (!this.grounded) v.y = Math.max(v.y - o.gravity * h, -o.maxFallSpeed);
        else v.y = 0;

        // move in sub-pieces no longer than 40% of the radius (no tunnelling through thin glass/floor planes)
        const wasGrounded = this.grounded, fallSpeed = -v.y;
        const dx = v.x * h, dy = v.y * h, dz = v.z * h;
        const pieces = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (o.radius * 0.4)));
        this._walkableContact = false;
        for (let i = 0; i < pieces; i++) {
            this.position.x += dx / pieces; this.position.y += dy / pieces; this.position.z += dz / pieces;
            this._resolve(wasGrounded);
        }
        this._groundProbe(false, wasGrounded);
        if (this.grounded) { this._coyote = o.coyoteTime; this._jumping = false; }
        else this._coyote = Math.max(0, this._coyote - h);
        if (this.grounded && !wasGrounded) {
            this._visOffset -= Math.min(0.09, Math.max(0, fallSpeed - 1.5) * 0.012); // landing dip
            if (this.onLand) this.onLand(this, fallSpeed);
        }

        if (this.position.y < o.respawnY) { this.respawnCount++; const n = this.respawnCount, sc = this.stepCount; this.setPose(this.spawn); this.respawnCount = n; this.stepCount = sc; }

        // eye height, step smoothing, head bob (all inside the fixed step => frame-rate independent)
        const eyeT = this.crouched ? o.crouchEye : o.eye;
        C.eye += (eyeT - C.eye) * (1 - Math.exp(-h * 14));
        this._visOffset *= Math.exp(-h * 12);
        const sp = Math.hypot(v.x, v.z);
        const moving = this.grounded && sp > 0.4;
        const targetW = moving && !this.crouched ? Math.min(1, sp / o.walkSpeed) : 0;
        this._bobWeight += (targetW - this._bobWeight) * (1 - Math.exp(-h * 8));
        if (this.grounded && sp > 0.05) {
            const sprintK = THREE.MathUtils.clamp((sp - o.walkSpeed) / (o.sprintSpeed - o.walkSpeed), 0, 1);
            const stride = o.strideWalk + (o.strideSprint - o.strideWalk) * sprintK;
            const before = Math.floor(this._bobPhase / Math.PI);
            this._bobPhase += sp * h / stride * Math.PI;
            if (Math.floor(this._bobPhase / Math.PI) !== before) {
                this.stepCount++; if (this.onStep) this.onStep(this);
            }
        }
        const sprintK = THREE.MathUtils.clamp((sp - o.walkSpeed) / (o.sprintSpeed - o.walkSpeed), 0, 1);
        const amp = (o.bobWalk + (o.bobSprint - o.bobWalk) * sprintK) * this._bobWeight;
        const cph = Math.cos(this._bobPhase);
        C.bobY = -amp * cph * cph;                        // lowest at each footfall
        C.bobX = amp * 0.45 * Math.sin(this._bobPhase);   // sway alternates per step
        C.vis = this._visOffset;
        C.x = this.position.x; C.y = this.position.y; C.z = this.position.z;
        this.simSteps++;
        if (this.afterStep) this.afterStep(this);
    }

    syncCamera(alpha = 1) {
        const cam = this.camera; if (!cam) return;
        const P = this._prev, C = this._cur, l = (a, b) => a + (b - a) * alpha;
        const bobX = l(P.bobX, C.bobX), cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        cam.position.set(l(P.x, C.x) + cy * bobX, l(P.y, C.y) + l(P.eye, C.eye) + l(P.vis, C.vis) + l(P.bobY, C.bobY), l(P.z, C.z) - sy * bobX);
        cam.rotation.order = 'YXZ';
        cam.rotation.set(this.pitch, this.yaw, -bobX * 0.04);
        cam.updateMatrixWorld();
    }

    // --- collision ---------------------------------------------------------------------------------------------
    _segment(height) {
        const o = this.opts, p = this.position;
        const y0 = p.y + o.stepHeight + o.radius, y1 = Math.max(y0, p.y + height - o.radius);
        return [p.x, y0, p.z, p.x, y1, p.z];
    }

    _resolve(groundedMode) {
        const o = this.opts, r = o.radius, g = this.grid, T = g.tris, N = g.norms, v = this.velocity, p = this.position;
        for (let iter = 0; iter < 4; iter++) {
            let moved = false;
            const seg = this._segment(this.bodyHeight);
            const B = g.bounds;
            g.query(p.x - r - 0.05, seg[1] - r - 0.05, p.z - r - 0.05, p.x + r + 0.05, seg[4] + r + 0.05, p.z + r + 0.05, (t) => {
                const s = this._segment(this.bodyHeight);
                if (farFromSegment(s, B, t, r)) return;
                const d2 = segTri(s[0], s[1], s[2], s[3], s[4], s[5], T, N, t);
                if (d2 >= r * r) return;
                let nx, ny, nz, depth;
                const d = Math.sqrt(d2);
                if (d > 1e-6) {
                    nx = (ST[0] - ST[3]) / d; ny = (ST[1] - ST[4]) / d; nz = (ST[2] - ST[5]) / d; depth = r - d;
                } else {
                    // segment pierces the triangle: push out along the face normal, toward the capsule's middle
                    const no = t * 3; nx = N[no]; ny = N[no + 1]; nz = N[no + 2];
                    const mx = (s[0] + s[3]) / 2 - T[t * 9], my = (s[1] + s[4]) / 2 - T[t * 9 + 1], mz = (s[2] + s[5]) / 2 - T[t * 9 + 2];
                    let side = mx * nx + my * ny + mz * nz;
                    if (Math.abs(side) < 1e-9) side = ny !== 0 ? ny : 1;
                    if (side < 0) { nx = -nx; ny = -ny; nz = -nz; }
                    const dp = (s[0] - T[t * 9]) * nx + (s[1] - T[t * 9 + 1]) * ny + (s[2] - T[t * 9 + 2]) * nz;
                    const dq = (s[3] - T[t * 9]) * nx + (s[4] - T[t * 9 + 1]) * ny + (s[5] - T[t * 9 + 2]) * nz;
                    depth = r - Math.min(dp, dq);
                }
                if (ny >= o.walkableNormalY) this._walkableContact = true;
                else if (ny <= -0.5 && v.y > 0) v.y = 0; // head hit the ceiling
                // too steep to stand on: while on the ground treat it as a vertical wall (no climbing edges/tables)
                if (ny < o.walkableNormalY && ny > -0.5 && groundedMode) {
                    const hl = Math.hypot(nx, nz);
                    if (hl > 1e-4) { depth = depth / Math.max(hl, 0.25); nx /= hl; nz /= hl; ny = 0; }
                }
                p.x += nx * depth; p.y += ny * depth; p.z += nz * depth;
                const vn = v.x * nx + v.y * ny + v.z * nz;
                if (vn < 0) { v.x -= nx * vn; v.y -= ny * vn; v.z -= nz * vn; } // slide along the surface
                moved = true;
            });
            if (!moved) break;
        }
    }

    _overlaps(height) {
        const r = this.opts.radius - 0.01, g = this.grid, p = this.position, s = this._segment(height);
        let hit = false;
        g.query(p.x - r, s[1] - r, p.z - r, p.x + r, s[4] + r, p.z + r, (t) => {
            if (!hit && !farFromSegment(s, g.bounds, t, r) && segTri(s[0], s[1], s[2], s[3], s[4], s[5], g.tris, g.norms, t) < r * r) hit = true;
        });
        return hit;
    }
    _canStand() { return !this._overlaps(this.opts.height); }

    // Highest walkable surface under the feet (5 rays: centre + 4 at 2/3 radius), within the step band.
    _probe(maxDown) {
        const o = this.opts, g = this.grid, p = this.position, top = p.y + o.stepHeight + 0.02;
        const rr = o.radius * 0.66;
        let best = -Infinity;
        const offs = [[0, 0], [rr, 0], [-rr, 0], [0, rr], [0, -rr]];
        const len = o.stepHeight + 0.02 + maxDown;
        TWO = g.twoSided;
        g.query(p.x - rr, top - len, p.z - rr, p.x + rr, top, p.z + rr, (t) => {
            for (const [ox, oz] of offs) {
                const d = rayDownTri(p.x + ox, top, p.z + oz, len, g.tris, g.norms, t);
                if (d >= 0 && RN[0] >= o.walkableNormalY) { const y = top - d; if (y > best) best = y; }
            }
        });
        return best;
    }

    _groundProbe(initial, wasGrounded = false) {
        const o = this.opts, v = this.velocity, p = this.position;
        if (v.y > 0.01 && !initial) { this.grounded = false; return; }
        // when falling, also search the distance covered in this step so a fast fall can never skip the floor
        const extra = (wasGrounded ? o.snapDown : 0) + (initial ? 0.05 : 0) + Math.max(0, -v.y * this.h);
        const y = this._probe(extra);
        if (y > -Infinity && (y >= p.y - 1e-4 || wasGrounded || initial)) {
            const rise = y - p.y;
            if (rise > 0.03 && wasGrounded) this._visOffset -= rise; // smooth the camera over a step-up
            p.y = y; v.y = 0; this.grounded = true;
        } else if (this._walkableContact && v.y <= 0) {
            v.y = 0; this.grounded = true;
        } else {
            this.grounded = false;
        }
    }

    // --- input -------------------------------------------------------------------------------------------------
    _bindDom() {
        const o = this.opts, on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); this._listeners.push([t, ev, fn, opt]); };
        if (o.keyboard) {
            const set = (e, val) => {
                const k = KEYMAP[e.code]; if (!k) return;
                this.input[k] = val;
                if (document.pointerLockElement === this.dom || k === 'jump') e.preventDefault();
            };
            on(window, 'keydown', (e) => set(e, true));
            on(window, 'keyup', (e) => set(e, false));
            on(window, 'blur', () => { for (const k in this.input) this.input[k] = false; });
        }
        if (o.pointerLock) {
            on(this.dom, 'click', () => { if (document.pointerLockElement !== this.dom && this.dom.requestPointerLock) this.dom.requestPointerLock(); });
            on(document, 'mousemove', (e) => { if (document.pointerLockElement === this.dom) this.look(e.movementX || 0, e.movementY || 0); });
        }
    }

    dispose() { for (const [t, ev, fn, opt] of this._listeners) t.removeEventListener(ev, fn, opt); this._listeners = []; }
}

// Cheap reject: triangle bounding sphere vs the (vertical) capsule segment.
function farFromSegment(s, B, t, r) {
    const b = t * 4, cy = B[b + 1];
    const y = cy < s[1] ? s[1] : cy > s[4] ? s[4] : cy;
    const R = r + B[b + 3];
    return (B[b] - s[0]) ** 2 + (cy - y) ** 2 + (B[b + 2] - s[2]) ** 2 > R * R;
}

function accelerate(v, wx, wz, wishSpeed, accel, h) {
    if (wishSpeed <= 0) return;
    const cur = v.x * wx + v.z * wz, add = wishSpeed - cur;
    if (add <= 0) return;
    const a = Math.min(accel * h * wishSpeed, add);
    v.x += a * wx; v.z += a * wz;
}
function clampPitch(p, m) { return Math.max(-m, Math.min(m, p)); }

export { TriangleGrid };

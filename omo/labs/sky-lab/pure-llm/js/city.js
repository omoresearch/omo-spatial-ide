// Procedural Manhattan seen from ~300 m: instanced buildings with setbacks, landmarks, rooftop props,
// a street-light ground shader with moving traffic, rivers, park, and a dusk sky dome with clouds.
import * as THREE from 'three';
import { NOISE, SKY, HAZE } from './shaders.js';

export const FLOOR_ALT = 300;        // our floor height above street
const GRID_ROT = THREE.MathUtils.degToRad(29);
export const SUN_DIR = new THREE.Vector3(-0.80, -0.035, 0.60).normalize();

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export const sharedUniforms = {
  uSunDir: { value: SUN_DIR },
  uTime: { value: 0 },
};

// grid-local (gx = across avenues, gz = along avenues) -> world xz
const cr = Math.cos(GRID_ROT), sr = Math.sin(GRID_ROT);
function toWorld(gx, gz) { return [gx * cr - gz * sr, gx * sr + gz * cr]; }

function region(gx, gz) {
  // returns {kind, median, sigma, cap}
  if (gx < -2050 && gx > -3300) return { kind: 'water' };
  if (gx > 1750 && gx < 2350) return { kind: 'water' };
  if (Math.abs(gx) < 420 && gz < -700 && gz > -4700) return { kind: 'park' };
  if (gz < -7600 && gx > -2050 && gx < 1750) return { kind: 'water' }; // Harlem river-ish cut
  const r = Math.hypot(gx, gz);
  if (gx <= -3300) { // New Jersey
    const jc = Math.hypot(gx + 3700, gz - 5600);
    if (jc < 700) return { kind: 'city', median: 70, sigma: 0.7, cap: 260, glass: 0.7 };
    return { kind: 'city', median: 14, sigma: 0.5, cap: 60, glass: 0.1, sparse: 0.35 };
  }
  if (gx >= 2350) { // Brooklyn / Queens
    const db = Math.hypot(gx - 2900, gz - 5600), lic = Math.hypot(gx - 2700, gz + 700);
    if (db < 700) return { kind: 'city', median: 60, sigma: 0.7, cap: 220, glass: 0.5 };
    if (lic < 600) return { kind: 'city', median: 55, sigma: 0.7, cap: 210, glass: 0.6 };
    return { kind: 'city', median: 14, sigma: 0.45, cap: 50, glass: 0.1, sparse: 0.25 };
  }
  // Manhattan
  const mid = Math.hypot(gx * 0.9, gz * 0.7);
  const dt = Math.hypot(gx + 150, gz - 6600);
  if (dt < 1100) return { kind: 'city', median: 95, sigma: 0.75, cap: 320, glass: 0.75 };
  if (mid < 1800) return { kind: 'city', median: 72 - mid * 0.015, sigma: 0.65, cap: 290, glass: 0.55 };
  if (gz > 2800 && gz < 5400) return { kind: 'city', median: 24, sigma: 0.5, cap: 90, glass: 0.15 }; // village
  if (r > 9000) return { kind: 'none' };
  return { kind: 'city', median: 38, sigma: 0.55, cap: 160, glass: 0.3 };
}

// ---------------------------------------------------------------- building shader
const BUILDING_VS = /* glsl */`
attribute vec4 aData;   // id, litFrac, style, baseY (bottom of building, world)
attribute vec3 aColor;
varying vec3 vWorld; varying vec3 vN; varying vec2 vFace; varying vec4 vData; varying vec3 vColor; varying float vRoof; varying vec2 vRoofUV; varying float vFaceW;
void main(){
  vec4 wp = modelMatrix * instanceMatrix * vec4(position,1.);
  vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vec3 lm = position * sc;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  float u = abs(normal.x) > .5 ? lm.z*sign(normal.x) : -lm.x*sign(normal.z);
  float fw = abs(normal.x) > .5 ? sc.z : sc.x;
  vFace = vec2(u + fw*.5, wp.y - aData.w);
  vFaceW = fw;
  vRoof = normal.y;
  vRoofUV = lm.xz + sc.xz*.5;
  vWorld = wp.xyz; vData = aData; vColor = aColor;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const BUILDING_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying vec2 vFace; varying vec4 vData; varying vec3 vColor; varying float vRoof; varying vec2 vRoofUV; varying float vFaceW;
${NOISE}
${SKY}
${HAZE}
vec3 litColor(float h){
  vec3 warm = vec3(1.0,0.60,0.28), neutral = vec3(1.0,0.82,0.60), cool = vec3(0.70,0.82,1.0);
  return h < .55 ? mix(warm, neutral, h/.55) : mix(neutral, cool, (h-.55)/.45);
}
void main(){
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  float id = vData.x, litFrac = vData.y, style = vData.z;
  float alt = vWorld.y + ${FLOOR_ALT.toFixed(1)};
  // ambient: sky dome + warm city bounce from below
  vec3 skyAmb = vec3(0.020,0.028,0.055);
  vec3 west = normalize(vec3(uSunDir.x,0.,uSunDir.z));
  vec3 glow = vec3(0.36,0.17,0.08) * max(dot(n, west),0.) * (n.y > .5 ? 0.15 : 1.);
  vec3 bounce = vec3(0.06,0.035,0.018) * exp(-alt/90.);
  vec3 col;
  if (vRoof > .5){
    vec2 r = vRoofUV;
    float g = fbm3(vWorld.xz*0.15+id);
    vec3 alb = vColor*0.55*(0.75+0.5*g);
    col = alb*(skyAmb*2.2 + glow*0.3);
    // parapet edge highlight & occasional roof light
    float lights = step(0.985, hash12(floor(vWorld.xz/6.)+id*3.1));
    col += vec3(1.,0.7,0.4)*lights*1.2*step(0.75,hash11(id*5.3));
  } else {
    // facade grid
    float fh = style < .5 ? 3.9 : (style < 1.5 ? 3.4 : (style < 2.5 ? 3.3 : 4.2));
    float cw = style < .5 ? 1.55 : (style < 1.5 ? 2.3 : (style < 2.5 ? 1.9 : 3.0));
    float wx = style < .5 ? 0.92 : (style < 1.5 ? 0.55 : (style < 2.5 ? 0.45 : 0.82));
    float wy = style < .5 ? 0.72 : (style < 1.5 ? 0.55 : (style < 2.5 ? 0.58 : 0.80));
    float nCol = max(floor(vFaceW/cw), 1.); cw = vFaceW/nCol;
    vec2 cell = vec2(vFace.x/cw, (vFace.y - 4.5)/fh);
    vec2 fwC = fwidth(cell);
    vec2 ci = floor(cell); vec2 f = fract(cell) - .5;
    float cov = boxCov(f.x, wx*.5, fwC.x) * boxCov(f.y, wy*.5, fwC.y);
    cov *= step(0., cell.y);           // lobby band
    // lit state: clustered in office suites
    float hR = hash12(vec2(floor(ci.x/3.), ci.y) + id*17.13);
    float hC = hash12(ci + id*7.77);
    float lit = step(hR, litFrac) * step(0.22, hC) + step(0.97, hC);
    lit = clamp(lit, 0., 1.);
    float tint = hash12(vec2(id, floor(ci.y/2.)));
    float inten = (1.2 + 2.6*hash12(ci*1.7+id)) * (0.65+0.35*smoothstep(-.5,.5,f.y));
    float blinds = step(0.7, hash12(ci+id*3.3+5.)); inten *= mix(1., 0.35+0.65*step(f.y, 0.1), blinds);
    vec3 lc = litColor(tint) * inten;
    // glass reflection
    vec3 R = reflect(-V, n);
    float F = 0.04 + 0.96*pow(1.-max(dot(n,V),0.),5.);
    vec3 refl = skyColor(R) * mix(0.08, 1., F) * (style < .5 ? 1.0 : 0.6);
    vec3 dark = vec3(0.004,0.005,0.008);
    vec3 win = mix(dark + refl, lc + refl*0.25, lit);
    vec3 wallAlb = vColor * (0.85+0.3*fbm3(vFace*vec2(0.2,0.05)+id));
    vec3 wall = wallAlb * (skyAmb + glow*0.5 + bounce);
    if (style < .5) wall = mix(wall, refl*0.7 + wall*.3, 0.6); // glass spandrel
    vec3 detail = mix(wall, win, cov);
    // far-field average
    float wa = wx*wy;
    vec3 avgWin = mix(dark + refl, vec3(1.0,0.72,0.45)*2.4 + refl*0.25, litFrac*0.85);
    vec3 avg = mix(wall, avgWin, wa);
    float k = smoothstep(0.9, 2.6, max(fwC.x, fwC.y));
    col = mix(detail, avg, k);
    // crown band lighting on some towers
    float crown = vData.y > 1.5 ? 1. : 0.;
    col += crown * vec3(1.0,0.86,0.62) * 2.5 * smoothstep(8.,0.,abs(vWorld.y - (vData.w + 0.)));
    // light spill near street
    col += vec3(0.55,0.32,0.14) * exp(-alt/14.) * 0.6;
  }
  col = applyHaze(col, vWorld);
  gl_FragColor = vec4(col, 1.);
}`;

// ---------------------------------------------------------------- simple props shader (tanks, hvac, spires)
const PROP_VS = /* glsl */`
attribute vec3 aColor; attribute float aEmit;
varying vec3 vWorld; varying vec3 vN; varying vec3 vColor; varying float vEmit;
void main(){ vec4 wp = modelMatrix*instanceMatrix*vec4(position,1.); vWorld=wp.xyz;
  vN = normalize(mat3(modelMatrix)*mat3(instanceMatrix)*normal); vColor=aColor; vEmit=aEmit;
  gl_Position=projectionMatrix*viewMatrix*wp; }`;
const PROP_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vN; varying vec3 vColor; varying float vEmit;
${NOISE}
${SKY}
${HAZE}
void main(){ vec3 n=normalize(vN); vec3 west=normalize(vec3(uSunDir.x,0.,uSunDir.z));
  vec3 c = vColor*(vec3(0.03,0.038,0.07)*(0.6+0.4*n.y) + vec3(0.30,0.14,0.07)*max(dot(n,west),0.));
  c += vColor*vEmit;
  gl_FragColor=vec4(applyHaze(c,vWorld),1.); }`;

// ---------------------------------------------------------------- ground (streets, traffic, water, park)
const GROUND_FS = /* glsl */`
varying vec3 vWorld;
uniform vec2 uRot;
${NOISE}
${SKY}
${HAZE}
float dotRow(float along, float across, float spacing, float sigma, float fw){
  float a = mod(along, spacing) - spacing*.5;
  float se = sqrt(sigma*sigma + fw*fw*.3);
  float g = exp(-(a*a + across*across)/(2.*se*se)) * (sigma*sigma)/(se*se);
  float lineMean = exp(-across*across/(2.*se*se)) * (sigma/se) * sigma*2.5066/spacing;
  return mix(g, lineMean, smoothstep(spacing*.2, spacing*.6, fw));
}
float carRow(float along, float across, float spacing, float sigma, float fw, float seed){
  float cell = floor(along/spacing);
  float present = step(0.45, hash12(vec2(cell, seed)));
  float d = dotRow(along, across, spacing, sigma, fw);
  float far = smoothstep(spacing*.2, spacing*.6, fw);
  return d * mix(present, 0.55, far);
}
float waterMask(vec2 g){
  float w = 0.;
  w = max(w, step(-3300., g.x)*step(g.x, -2050.));
  w = max(w, step(1750., g.x)*step(g.x, 2350.));
  w = max(w, step(g.y, -7600.)*step(-2050., g.x)*step(g.x,1750.)*step(g.y,-7400.));
  // harbour south
  w = max(w, step(7600., g.y + 400.*sin(g.x*0.0006)));
  return w;
}
void main(){
  vec3 wp = vWorld;
  vec2 g = vec2(wp.x*uRot.x + wp.z*uRot.y, -wp.x*uRot.y + wp.z*uRot.x);
  vec2 fwG = fwidth(g); float fw = max(fwG.x, fwG.y);
  float time = uTime;
  vec3 col = vec3(0.0);
  float water = waterMask(g);
  float r = length(g);
  if (water > .5){
    vec3 V = normalize(cameraPosition - wp);
    vec2 q = wp.xz*0.02 + vec2(time*0.05, time*0.03);
    vec3 n = normalize(vec3((fbm3(q)-.5)*0.12, 1., (fbm3(q+9.)-.5)*0.12));
    vec3 R = reflect(-V, n);
    float F = 0.02 + 0.98*pow(1.-max(dot(n,V),0.),5.);
    col = vec3(0.004,0.007,0.010) + skyColor(R)*F*0.9;
    // shimmering light reflections near shores
    float sh = smoothstep(0.75,1.,fbm3(vec2(wp.x*0.05, wp.z*0.4)+time*0.2));
    col += vec3(1.,0.6,0.3)*sh*0.15;
  } else {
    // Manhattan-like grid: avenues every 260 m (30 m wide), streets every 80 m (18 m wide)
    float outer = smoothstep(9000., 12000., r);
    float avSp = 260., stSp = mix(80., 110., outer);
    float ax = mod(g.x + avSp*.5, avSp) - avSp*.5;
    float sz = mod(g.y + stSp*.5, stSp) - stSp*.5;
    float avW = 15., stW = 9.;
    float onAv = boxCov(ax, avW, fwG.x);
    float onSt = boxCov(sz, stW, fwG.y);
    float road = max(onAv, onSt);
    vec3 block = vec3(0.010,0.010,0.011)*(0.6+0.8*fbm3(g*0.05));
    vec3 asphalt = vec3(0.016,0.014,0.013);
    col = mix(block, asphalt, road);
    // warm road wash from street lights
    float wash = exp(-ax*ax/(2.*18.*18.))*0.9 + exp(-sz*sz/(2.*10.*10.))*0.5;
    col += vec3(0.20,0.11,0.045) * wash * 0.6;
    // street lights along both curbs
    float L = 0.;
    L += dotRow(g.y, abs(ax) - 13., 32., 1.2, fw) * 1.0;
    L += dotRow(g.x, abs(sz) - 7.5, 36., 1.0, fw) * 0.8;
    col += vec3(1.0,0.62,0.28) * L * 7.0;
    // traffic on avenues: alternating one-way avenues
    float avIdx = floor((g.x + avSp*.5)/avSp);
    float dir = mod(avIdx, 2.) < 1. ? 1. : -1.;
    float head = 0., tail = 0.;
    for (int i=0;i<4;i++){
      float lane = -7.5 + float(i)*5.;
      float sp = 9. + 3.*hash11(avIdx*3.1+float(i));
      float along = g.y - dir*time*sp + hash11(avIdx+float(i)*7.)*200.;
      float c = carRow(along, ax - lane, 22., 0.9, fw, avIdx*13.+float(i));
      head += c * step(0., dir*float(i-2)+0.5);
      tail += c * (1. - step(0., dir*float(i-2)+0.5));
    }
    // cross-town streets: lighter traffic
    float stIdx = floor((g.y + stSp*.5)/stSp);
    float sdir = mod(stIdx,2.) < 1. ? 1. : -1.;
    float alongS = g.x - sdir*time*7. + hash11(stIdx)*300.;
    float cs = carRow(alongS, sz, 40., 0.8, fw, stIdx*7.1);
    col += vec3(1.0,0.90,0.72)*head*5.0 + vec3(1.0,0.06,0.03)*tail*3.5 + vec3(1.0,0.5,0.3)*cs*2.0;
    // storefront glow on avenue sidewalks
    col += vec3(0.9,0.55,0.25) * boxCov(abs(ax)-17.5, 2.5, fwG.x) * 0.35 * (0.5+fbm3(vec2(g.y*0.05, avIdx)));
    // park
    float park = step(abs(g.x), 420.) * step(-4700., g.y) * step(g.y, -700.);
    if (park > .5){
      float trees = fbm(g*0.04);
      col = vec3(0.006,0.010,0.006)*(0.5+trees);
      vec2 pp = g + vec2(fbm3(g*0.004)*120., 0.);
      float paths = dotRow(pp.y, mod(pp.x+70., 140.)-70., 25., 0.8, fw) * 0.8;
      col += vec3(1.0,0.75,0.45) * paths * 4.;
      // reservoir
      float res = 1.-smoothstep(260., 270., length((g - vec2(0.,-3200.))*vec2(1.,0.55)));
      if (res > 0.){ vec3 V = normalize(cameraPosition - wp); float F=0.02+0.98*pow(1.-max(V.y,0.),5.);
        col = mix(col, vec3(0.003,0.005,0.008) + skyColor(reflect(-V, vec3(0.,1.,0.)))*F, res); }
      // park drives with traffic glow
      col += vec3(1.,0.85,0.7)*boxCov(abs(g.x)-380., 6., fwG.x)*0.6;
    }
    // highways along the rivers + shore lights
    float hwW = boxCov(g.x + 2030., 10., fwG.x) + boxCov(g.x - 1730., 10., fwG.x);
    float hwCars = carRow(g.y + time*24., g.x + 2026., 9., 0.8, fw, 1.) + carRow(g.y - time*24., g.x + 2034., 9., 0.8, fw, 2.)
                 + carRow(g.y + time*22., g.x - 1726., 9., 0.8, fw, 3.) + carRow(g.y - time*22., g.x - 1734., 9., 0.8, fw, 4.);
    col += vec3(0.05,0.03,0.02)*hwW + vec3(1.,0.8,0.6)*hwCars*4.;
    col *= 1. - outer*0.4;
  }
  // bridges (elevated light rows drawn on water)
  float br = 0.;
  br += dotRow(g.x, g.y + 450., 18., 1.0, fw) * step(1700., g.x) * step(g.x, 2400.);
  br += dotRow(g.x, g.y - 5950., 18., 1.0, fw) * step(1700., g.x) * step(g.x, 2400.);
  br += dotRow(g.x, g.y - 6450., 18., 1.0, fw) * step(1700., g.x) * step(g.x, 2400.);
  col += vec3(1.0,0.85,0.6) * br * 6.;
  col = applyHaze(col, wp);
  gl_FragColor = vec4(col, 1.);
}`;

const SKY_FS = /* glsl */`
varying vec3 vDir;
${NOISE}
${SKY}
void main(){
  vec3 d = normalize(vDir);
  vec3 col = skyColor(d);
  if (d.y > 0.){
    // high cirrus lit from below by the set sun
    vec2 uv = d.xz/(d.y+0.08)*1.3 + vec2(uTime*0.004, 0.);
    float c = fbm(uv*vec2(1.0,3.0) + vec2(fbm(uv*0.7)*1.5, 0.));
    float cov = smoothstep(0.50, 0.85, c) * smoothstep(0.0, 0.06, d.y) * (1.-smoothstep(0.35,0.75,d.y));
    float mu = dot(d, uSunDir)*.5+.5;
    vec3 lit = mix(vec3(0.08,0.06,0.12), vec3(1.25,0.50,0.30), pow(mu, 3.0));
    lit = mix(lit, vec3(0.95,0.32,0.30), smoothstep(0.08,0.3,d.y)*pow(mu,2.)*0.6);
    col = mix(col, lit, cov*0.85);
    // a few early stars high up
    vec2 sp = d.xz/(d.y+0.3)*240.; vec2 si = floor(sp); float st = hash12(si);
    float star = step(0.9965, st) * smoothstep(0.4, 0.0, length(fract(sp)-.5)) * smoothstep(0.35,0.7,d.y) * (1.-cov);
    col += vec3(0.8,0.85,1.)*star*0.6;
  }
  gl_FragColor = vec4(col, 1.);
}`;

export function buildCity() {
  const group = new THREE.Group();
  const rand = rng(1337);
  const R = rand;
  const lognorm = (median, sigma) => { const u = 1 - R(), v = R(); const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); return median * Math.exp(sigma * z); };

  const tiers = []; // {x,z,w,d,h,base,rot,id,lit,style,color,crown}
  const props = []; // {geo:'tank'|'box'|'cone', x,y,z,sx,sy,sz,color,emit}
  const roofTops = [];
  let bid = 1;

  const palettes = {
    glass: [[0.10, 0.13, 0.16], [0.09, 0.12, 0.12], [0.14, 0.15, 0.17], [0.08, 0.10, 0.14]],
    brick: [[0.32, 0.17, 0.12], [0.36, 0.22, 0.15], [0.26, 0.15, 0.11], [0.42, 0.30, 0.22]],
    stone: [[0.52, 0.47, 0.40], [0.46, 0.42, 0.37], [0.58, 0.54, 0.47], [0.40, 0.38, 0.36]],
  };
  const pick = a => a[Math.floor(R() * a.length)];

  function addBuilding(gx, gz, w, d, h, opts = {}) {
    const id = bid++;
    const glassP = opts.glass ?? 0.4;
    const style = opts.style ?? (R() < glassP ? 0 : (h > 60 ? (R() < 0.5 ? 1 : 2) : (R() < 0.6 ? 1 : 2)));
    const color = opts.color ?? (style === 0 ? pick(palettes.glass) : style === 1 ? pick(palettes.brick) : pick(palettes.stone));
    const lit = opts.lit ?? (0.25 + R() * 0.5);
    const [x, z] = toWorld(gx, gz);
    const baseY = -FLOOR_ALT;
    // setback logic
    let segs;
    if (opts.tiers) segs = opts.tiers;
    else if (h > 70 && R() < 0.75) {
      const n = h > 180 ? 3 : 2; segs = []; let cw = w, cd = d, y0 = 0;
      for (let i = 0; i < n; i++) {
        const top = i === n - 1 ? h : y0 + (h - y0) * (0.35 + R() * 0.35);
        segs.push({ w: cw, d: cd, y0, y1: top, ox: 0, oz: 0 });
        y0 = top; cw *= 0.72 + R() * 0.15; cd *= 0.72 + R() * 0.15;
      }
    } else segs = [{ w, d, y0: 0, y1: h, ox: 0, oz: 0 }];
    for (const s of segs) {
      const [ox, oz] = toWorld(s.ox || 0, s.oz || 0);
      tiers.push({ x: x + ox, z: z + oz, w: s.w, d: s.d, y0: baseY + s.y0, y1: baseY + s.y1, id, lit: s.crown ? 2.0 + lit : lit, style: s.style ?? style, color: s.color ?? color, base: s.crown ? baseY + s.y1 : baseY });
    }
    const topSeg = segs[segs.length - 1];
    roofTops.push({ x, z, w: topSeg.w, d: topSeg.d, y: baseY + topSeg.y1, h, style, id });
    return id;
  }

  // ---------- landmarks (grid-local coords; our tower at 0,0)
  const ESB = [{ w: 130, d: 60, y0: 0, y1: 25 }, { w: 95, d: 50, y0: 25, y1: 85 }, { w: 60, d: 40, y0: 85, y1: 250 }, { w: 44, d: 30, y0: 250, y1: 300 }, { w: 30, d: 22, y0: 300, y1: 320, crown: true }, { w: 18, d: 18, y0: 320, y1: 345, crown: true }, { w: 8, d: 8, y0: 345, y1: 365, crown: true }];
  addBuilding(260, 2250, 130, 60, 365, { tiers: ESB, style: 2, color: [0.55, 0.51, 0.45], lit: 0.55 });
  props.push({ geo: 'cone', g: [260, 2250], y: -FLOOR_ALT + 365, sx: 3, sy: 70, sz: 3, color: [0.6, 0.6, 0.6], emit: 3 });
  // Chrysler-like stepped crown
  const CHR = [{ w: 60, d: 60, y0: 0, y1: 60 }, { w: 45, d: 45, y0: 60, y1: 230 }];
  for (let i = 0; i < 6; i++) CHR.push({ w: 32 - i * 5, d: 32 - i * 5, y0: 230 + i * 8, y1: 238 + i * 8, crown: true, style: 0, color: [0.5, 0.5, 0.52] });
  addBuilding(820, 1250, 60, 60, 278, { tiers: CHR, style: 2, color: [0.45, 0.43, 0.40], lit: 0.6 });
  props.push({ geo: 'cone', g: [820, 1250], y: -FLOOR_ALT + 278, sx: 2.5, sy: 40, sz: 2.5, color: [0.8, 0.8, 0.85], emit: 2.5 });
  // Billionaires' row slender towers south of park
  addBuilding(560, -470, 30, 30, 426, { style: 3, color: [0.62, 0.60, 0.56], lit: 0.35 });
  addBuilding(-320, -560, 45, 38, 472, { style: 0, color: [0.12, 0.14, 0.17], lit: 0.3, tiers: [{ w: 45, d: 38, y0: 0, y1: 472 }, { w: 30, d: 30, y0: 472, y1: 480, crown: true }] });
  addBuilding(110, -620, 24, 50, 435, { style: 2, color: [0.50, 0.42, 0.36], lit: 0.3, tiers: [{ w: 24, d: 50, y0: 0, y1: 380 }, { w: 24, d: 38, y0: 380, y1: 410 }, { w: 24, d: 26, y0: 410, y1: 435 }] });
  addBuilding(-80, -540, 30, 30, 306, { style: 0, color: [0.11, 0.13, 0.14], lit: 0.4 });
  // Hudson-yards cluster
  addBuilding(-1550, 900, 70, 55, 395, { style: 0, color: [0.12, 0.15, 0.18], lit: 0.55, tiers: [{ w: 70, d: 55, y0: 0, y1: 380 }, { w: 60, d: 20, y0: 380, y1: 395, crown: true }] });
  addBuilding(-1680, 1040, 60, 50, 330, { style: 0, color: [0.10, 0.13, 0.14], lit: 0.5 });
  addBuilding(-1420, 1100, 55, 45, 300, { style: 0, color: [0.13, 0.14, 0.16], lit: 0.5 });
  // downtown supertall (tapered, approximated by stacked tiers)
  const WTC = []; for (let i = 0; i < 10; i++) { const s = 62 - i * 3.6; WTC.push({ w: s, d: s, y0: i * 41.7, y1: (i + 1) * 41.7, style: 0, color: [0.12, 0.14, 0.17] }); }
  addBuilding(-120, 6500, 62, 62, 417, { tiers: WTC, style: 0, lit: 0.6 });
  props.push({ geo: 'cone', g: [-120, 6500], y: -FLOOR_ALT + 417, sx: 2.2, sy: 120, sz: 2.2, color: [0.9, 0.9, 1.0], emit: 2.0 });
  // a few more downtown towers
  [[180, 6200, 290], [-380, 6150, 260], [260, 6850, 300], [-60, 7050, 240], [420, 6550, 230]].forEach(([a, b, h]) => addBuilding(a, b, 45 + R() * 15, 40 + R() * 15, h, { glass: 0.8 }));

  // ---------- general fabric
  const avSp = 260, stSp = 80, avW = 30, stW = 18;
  const occupied = (gx, gz, w, d) => {
    // keep landmark footprints clear
    const L = [[260, 2250, 140], [820, 1250, 70], [560, -470, 40], [-320, -560, 55], [110, -620, 60], [-80, -540, 40], [-1550, 900, 90], [-1680, 1040, 70], [-1420, 1100, 70], [-120, 6500, 80], [180, 6200, 60], [-380, 6150, 60], [260, 6850, 60], [-60, 7050, 60], [420, 6550, 60]];
    for (const [a, b, r] of L) if (Math.abs(gx - a) < r + w / 2 && Math.abs(gz - b) < r + d / 2) return true;
    return false;
  };
  for (let bx = -9100; bx < 9100; bx += avSp) {
    for (let bz = -10000; bz < 10000; bz += stSp) {
      const cx = bx + avSp / 2, cz = bz + stSp / 2; // block centre (avenues at multiples of avSp)
      const reg = region(cx, cz);
      if (reg.kind !== 'city') continue;
      const dist = Math.hypot(cx, cz);
      if (dist > 9000 && R() < 0.5) continue;
      const blockW = avSp - avW, blockD = stSp - stW;
      let x0 = cx - blockW / 2;
      while (x0 < cx + blockW / 2 - 8) {
        let lw = Math.min(14 + R() * 42, cx + blockW / 2 - x0);
        if (lw < 8) break;
        const split = R() < 0.55;
        const rows = split ? [[cz - blockD / 4, blockD / 2], [cz + blockD / 4, blockD / 2]] : [[cz, blockD]];
        for (const [lz, ld] of rows) {
          if (reg.sparse && R() < reg.sparse) continue;
          const gx = x0 + lw / 2;
          const near = Math.hypot(gx, lz);
          if (near < 70) continue;                         // our own tower plot
          if (occupied(gx, lz, lw, ld)) continue;
          let h = Math.min(lognorm(reg.median, reg.sigma), reg.cap);
          if (near < 450) h = Math.min(h, 120 + near * 0.25);
          h = Math.max(h, 8);
          addBuilding(gx, lz, lw - 1.5, ld - 1.5, h, { glass: reg.glass * (h > 100 ? 1.3 : 0.6) });
        }
        x0 += lw;
      }
    }
  }
  // our own tower plot neighbours: low-rise podium around base
  // ---------- rooftop props
  for (const rt of roofTops) {
    const d = Math.hypot(rt.x, rt.z);
    if (d > 3200) continue;
    const nTank = rt.style !== 0 && rt.h < 140 && R() < 0.6 ? 1 + (R() < 0.3 ? 1 : 0) : 0;
    for (let i = 0; i < nTank; i++) {
      const ox = (R() - 0.5) * rt.w * 0.5, oz = (R() - 0.5) * rt.d * 0.5;
      const [wx, wz] = toWorld(0, 0); void wx; void wz;
      props.push({ geo: 'tank', wx: rt.x + ox, wz: rt.z + oz, y: rt.y, sx: 2.6, sy: 4.0, sz: 2.6, color: [0.30, 0.20, 0.13], emit: 0 });
      props.push({ geo: 'cone', wx: rt.x + ox, wz: rt.z + oz, y: rt.y + 7.2, sx: 2.7, sy: 1.6, sz: 2.7, color: [0.22, 0.16, 0.11], emit: 0 });
      props.push({ geo: 'box', wx: rt.x + ox, wz: rt.z + oz, y: rt.y, sx: 4.6, sy: 3.2, sz: 4.6, color: [0.12, 0.10, 0.09], emit: 0, frame: true });
    }
    const nBox = Math.floor(R() * 4);
    for (let i = 0; i < nBox; i++) {
      const sx = 2 + R() * Math.min(10, rt.w * 0.3), sz = 2 + R() * Math.min(8, rt.d * 0.3);
      props.push({ geo: 'box', wx: rt.x + (R() - 0.5) * (rt.w - sx), wz: rt.z + (R() - 0.5) * (rt.d - sz), y: rt.y, sx, sy: 1.5 + R() * 3, sz, color: [0.35, 0.35, 0.36], emit: 0 });
    }
    if (rt.h > 200) props.push({ geo: 'box', wx: rt.x, wz: rt.z, y: rt.y, sx: 1.2, sy: 12 + R() * 20, sz: 1.2, color: [0.3, 0.3, 0.3], emit: 0, beacon: true });
  }

  // ---------- buildings instanced mesh
  const boxGeo = new THREE.BoxGeometry(1, 1, 1); boxGeo.translate(0, 0.5, 0);
  const n = tiers.length;
  const aData = new Float32Array(n * 4), aColor = new Float32Array(n * 3);
  const mat = new THREE.ShaderMaterial({ uniforms: sharedUniforms, vertexShader: BUILDING_VS, fragmentShader: BUILDING_FS });
  const mesh = new THREE.InstancedMesh(boxGeo, mat, n);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -GRID_ROT), v = new THREE.Vector3(), s = new THREE.Vector3();
  tiers.forEach((t, i) => {
    m4.compose(v.set(t.x, t.y0, t.z), q, s.set(t.w, t.y1 - t.y0, t.d));
    mesh.setMatrixAt(i, m4);
    aData.set([t.id, t.lit, t.style, t.base], i * 4);
    aColor.set(t.color, i * 3);
  });
  boxGeo.setAttribute('aData', new THREE.InstancedBufferAttribute(aData, 4));
  boxGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
  mesh.frustumCulled = false;
  group.add(mesh);

  // ---------- props
  const geos = { tank: new THREE.CylinderGeometry(0.5, 0.5, 1, 14), cone: new THREE.ConeGeometry(0.5, 1, 14), box: new THREE.BoxGeometry(1, 1, 1) };
  geos.tank.translate(0, 0.5, 0); geos.cone.translate(0, 0.5, 0); geos.box.translate(0, 0.5, 0);
  const pmat = new THREE.ShaderMaterial({ uniforms: sharedUniforms, vertexShader: PROP_VS, fragmentShader: PROP_FS });
  const beacons = [];
  for (const kind of ['tank', 'cone', 'box']) {
    const list = props.filter(p => p.geo === kind);
    const g = geos[kind].clone();
    const im = new THREE.InstancedMesh(g, pmat, list.length);
    const col = new Float32Array(list.length * 3), em = new Float32Array(list.length);
    list.forEach((p, i) => {
      let x = p.wx, z = p.wz; if (p.g) [x, z] = toWorld(p.g[0], p.g[1]);
      let y = p.y; if (p.geo === 'tank') y += 3.2;
      m4.compose(v.set(x, y, z), q, s.set(p.sx, p.sy, p.sz)); im.setMatrixAt(i, m4);
      col.set(p.color, i * 3); em[i] = p.emit;
      if (p.beacon) beacons.push([x, y + p.sy + 0.5, z]);
    });
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
    g.setAttribute('aEmit', new THREE.InstancedBufferAttribute(em, 1));
    im.frustumCulled = false; group.add(im);
  }
  // aircraft-warning beacons (red, blink with time)
  for (const l of [[260, 2250, 435], [-120, 6500, 537], [560, -470, 426], [-320, -560, 480], [110, -620, 435], [-1550, 900, 395], [820, 1250, 318]]) {
    const [x, z] = toWorld(l[0], l[1]); beacons.push([x, -FLOOR_ALT + l[2] + 1, z]);
  }
  const bGeo = new THREE.BufferGeometry(); bGeo.setAttribute('position', new THREE.Float32BufferAttribute(beacons.flat(), 3));
  const bMat = new THREE.ShaderMaterial({
    uniforms: sharedUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying float vPh; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); vPh=fract(sin(dot(position.xz,vec2(12.9,78.2)))*437.); gl_PointSize=clamp(1400./-mv.z,2.,6.); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform float uTime; varying float vPh; void main(){ float d=length(gl_PointCoord-.5); float b=step(.5,fract(uTime*0.6+vPh)); gl_FragColor=vec4(vec3(1.,0.05,0.02)*smoothstep(.5,.0,d)*(0.4+b*6.),1.); }`,
  });
  group.add(new THREE.Points(bGeo, bMat));

  // ---------- ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(70000, 70000).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: { ...sharedUniforms, uRot: { value: new THREE.Vector2(cr, -sr) } },
    vertexShader: `varying vec3 vWorld; void main(){ vec4 wp=modelMatrix*vec4(position,1.); vWorld=wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: GROUND_FS,
  }));
  ground.position.y = -FLOOR_ALT;
  group.add(ground);

  // ---------- sky dome
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.ShaderMaterial({
    uniforms: sharedUniforms, side: THREE.BackSide, depthWrite: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir=position; vec4 p=projectionMatrix*viewMatrix*vec4(position*30000.+cameraPosition,1.); gl_Position=p.xyww; }`,
    fragmentShader: SKY_FS,
  }));
  sky.frustumCulled = false; sky.renderOrder = -10;
  group.add(sky);

  return { group, stats: { tiers: tiers.length, props: props.length }, buildingMaterial: mat, toWorld };
}

// Our own tower shaft below the penthouse floor (rendered in the interior pass so it is never near-clipped).
export function buildOwnTower(minX, maxX, minZ, maxZ, cityMat) {
  const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0);
  g.setAttribute('aData', new THREE.InstancedBufferAttribute(new Float32Array([9999, 0.45, 0, -FLOOR_ALT]), 4));
  g.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array([0.10, 0.12, 0.14]), 3));
  const m = new THREE.InstancedMesh(g, cityMat, 1);
  m.setMatrixAt(0, new THREE.Matrix4().compose(new THREE.Vector3((minX + maxX) / 2, -FLOOR_ALT, (minZ + maxZ) / 2), new THREE.Quaternion(), new THREE.Vector3(maxX - minX, FLOOR_ALT - 0.45, maxZ - minZ)));
  m.frustumCulled = false;
  return m;
}

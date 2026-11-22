// Proximity-voice math, ported from Kaviru's omo/extension/src/browser/voice-spatial.ts.
// Positions are room metres (three.js: x right, y up, z toward the lifts); a pose with yaw 0 faces -z.
// Loudness by distance is a GAIN (proximityVolume); the HRTF PannerNode only places the voice (direction + facing cone).
// Brief (21 Nov): full within ~2.5 m, fades to near silent by ~12 m, 0 beyond 15 m.
export const EAR_HEIGHT = 1.6;
export const PROXIMITY = { near: 2.5, quiet: 12, cut: 15, quietGain: 0.04 };
export const VOICE_CONE = { inner: 180, outer: 330, outerGain: 0.55 };
export const MIN_SOURCE_DISTANCE = 0.3;

/** 1 inside `near`; ease-out (quadratic) down to quietGain at `quiet`; linear to 0 at `cut`; 0 beyond. */
export function proximityVolume(distance) {
  if (!Number.isFinite(distance)) return 0;
  const { near, quiet, cut, quietGain } = PROXIMITY;
  if (distance <= near) return 1;
  if (distance >= cut) return 0;
  let v;
  if (distance <= quiet) { const t = (distance - near) / (quiet - near); v = quietGain + (1 - quietGain) * (1 - t) * (1 - t); }
  else v = quietGain * (1 - (distance - quiet) / (cut - quiet));
  return Math.round(v * 1000) / 1000;
}

export function facing(yaw) {
  const x = -Math.sin(yaw), z = -Math.cos(yaw);
  return { x: Math.abs(x) < 1e-12 ? 0 : x, y: 0, z: Math.abs(z) < 1e-12 ? 0 : z };
}
export function earPosition(p) { return { x: p.x, y: EAR_HEIGHT, z: p.z }; }
/** Where to put a source for the panner: its own position, or (too close) MIN_SOURCE_DISTANCE away on the same bearing. */
export function sourcePosition(listener, source) {
  const dx = source.x - listener.x, dz = source.z - listener.z, d = Math.hypot(dx, dz);
  if (d >= MIN_SOURCE_DISTANCE) return earPosition(source);
  const dir = d > 1e-6 ? { x: dx / d, z: dz / d } : (() => { const f = facing(listener.yaw); return { x: f.x, z: f.z }; })();
  return { x: listener.x + dir.x * MIN_SOURCE_DISTANCE, y: EAR_HEIGHT, z: listener.z + dir.z * MIN_SOURCE_DISTANCE };
}
/** Azimuth of a source: 0 ahead, +pi/2 right, -pi/2 left, +-pi behind. */
export function relativeAzimuth(listener, source) {
  const f = facing(listener.yaw), dx = source.x - listener.x, dz = source.z - listener.z;
  const right = { x: -f.z, z: f.x };
  return Math.atan2(dx * right.x + dz * right.z, dx * f.x + dz * f.z);
}
export function horizontalDistance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

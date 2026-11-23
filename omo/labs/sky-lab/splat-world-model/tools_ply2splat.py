# Convert a 3DGS .ply (SH deg 1) to antimatter15 .splat (32 B/splat, DC colour only), dropping near-invisible splats.
# usage: python3 tools_ply2splat.py in.ply out.splat
import numpy as np, sys
f = open(sys.argv[1], 'rb'); h = b''
while not h.endswith(b'end_header\n'): h += f.read(1)
names = [l.split()[-1].decode() for l in h.split(b'\n') if l.startswith(b'property')]
n = int([l for l in h.split(b'\n') if l.startswith(b'element vertex')][0].split()[-1])
a = np.fromfile(f, dtype=np.float32, count=n * len(names)).reshape(n, len(names)); d = {k: a[:, i] for i, k in enumerate(names)}
op = 1 / (1 + np.exp(-d['opacity']))
keep = op > 0.04
pos = np.stack([d['x'], d['y'], d['z']], 1)[keep].astype(np.float32)
sc = np.exp(np.stack([d['scale_0'], d['scale_1'], d['scale_2']], 1))[keep].astype(np.float32)
col = np.clip(0.5 + 0.28209479 * np.stack([d['f_dc_0'], d['f_dc_1'], d['f_dc_2']], 1)[keep], 0, 1)
rgba = np.concatenate([col, op[keep, None]], 1); rgba = np.clip(rgba * 255 + 0.5, 0, 255).astype(np.uint8)
q = np.stack([d['rot_0'], d['rot_1'], d['rot_2'], d['rot_3']], 1)[keep]; q /= np.linalg.norm(q, axis=1, keepdims=True)
qb = np.clip(q * 128 + 128, 0, 255).astype(np.uint8)
order = np.argsort(-(sc.prod(1) * op[keep]))  # big/opaque first (as antimatter15 does)
out = np.zeros(len(pos), dtype=[('p', '<f4', 3), ('s', '<f4', 3), ('c', 'u1', 4), ('r', 'u1', 4)])
out['p'] = pos[order]; out['s'] = sc[order]; out['c'] = rgba[order]; out['r'] = qb[order]
out.tofile(sys.argv[2])
g = pos[:, 2]; print(sys.argv[1], 'kept', len(pos), 'of', n, 'ground~', float(np.percentile(g, 8)), 'zmax', float(np.percentile(g, 99.9)))

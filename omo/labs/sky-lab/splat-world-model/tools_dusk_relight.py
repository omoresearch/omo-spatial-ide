# Bake a dusk grade into a .splat (32 B/splat) WITHOUT touching the source file.
# - cool/dark base grade, warm rim on tall parts (low sun from the west)
# - ~3.5% of small facade splats become lit windows (warm/cool), ~1% street-level splats become sodium lights
# usage: python3 tools_dusk_relight.py in.splat out.splat grade seed
import numpy as np, sys
a = np.fromfile(sys.argv[1], dtype=[('p','<f4',3),('s','<f4',3),('c','u1',4),('r','u1',4)])
grade = float(sys.argv[3]); rng = np.random.default_rng(int(sys.argv[4]))
p = a['p']; c = a['c'][:, :3].astype(np.float32) / 255
g = np.percentile(p[:, 2], 5); h = p[:, 2] - g
base = c * np.array([0.42, 0.45, 0.66]) * grade
rim = np.clip((h - 60) / 300, 0, 1)[:, None] * np.clip(-p[:, 0:1] / 600 + 0.5, 0, 1) * np.array([0.35, 0.16, 0.06]) * grade
col = base + rim * c
smax = a['s'].max(1)
win = (h > 6) & (smax < 1.4) & (rng.random(len(p)) < 0.035)
warm = rng.random(len(p)) < 0.72
lum = 0.7 + 0.3 * rng.random(len(p))
col[win & warm] = (np.array([1.0, 0.78, 0.48]) * lum[win & warm, None])
col[win & ~warm] = (np.array([0.78, 0.86, 1.0]) * lum[win & ~warm, None])
st = (h < 4) & (smax < 1.0) & (rng.random(len(p)) < 0.012)
col[st] = np.array([1.0, 0.62, 0.28])
a['c'][:, :3] = np.clip(col * 255 + 0.5, 0, 255).astype(np.uint8)
a['c'][win | st, 3] = np.maximum(a['c'][win | st, 3], 200)
a.tofile(sys.argv[2]); print(sys.argv[2], 'windows', int(win.sum()), 'street', int(st.sum()), 'of', len(p))

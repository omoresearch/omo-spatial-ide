# Removes the flat grey horizon strip (a ground/haze seam baked into the city panorama, seen as a horizontal band across the glass).
# Each column is linearly re-interpolated across the strip rows (buildings are vertical, so their edges survive).
# Run: blender -b -P fix_city.py -- assets/city.exr gen/city_clean.exr
import bpy, sys, numpy as np
a = sys.argv[sys.argv.index('--') + 1:]
im = bpy.data.images.load(a[0]); im.colorspace_settings.name = 'Linear Rec.709'; w, h = im.size
px = np.empty(w * h * 4, np.float32); im.pixels.foreach_get(px); px = px.reshape(h, w, 4)[::-1]   # row 0 = top
lum = px[..., :3].mean(2).mean(1)
mid = h // 2; win = lum[mid - 60: mid + 60]
d = np.diff(win); y0 = mid - 60 + int(np.argmin(d)) + 1          # sharp drop = strip top
y1 = y0 + 4 + int(np.argmax(np.diff(lum[y0 + 4: y0 + 60]))) + 1    # sharp rise = strip bottom
print('STRIP rows', y0, y1, 'lum', lum[y0 - 2], lum[(y0 + y1) // 2], lum[y1 + 1])
a0, a1 = y0 - 2, y1 + 2
t = ((np.arange(a0, a1 + 1) - a0) / (a1 - a0))[:, None, None]
px[a0:a1 + 1] = px[a0][None] * (1 - t) + px[a1][None] * t
im2 = bpy.data.images.new('clean', w, h, float_buffer=True, alpha=True); im2.pixels.foreach_set(px[::-1].ravel())
sc = bpy.context.scene; s = sc.render.image_settings; s.file_format = 'OPEN_EXR'; s.color_depth = '16'; s.exr_codec = 'DWAA'; s.color_mode = 'RGB'
im2.save_render(a[1], scene=sc); print('CITY CLEAN', a[1])

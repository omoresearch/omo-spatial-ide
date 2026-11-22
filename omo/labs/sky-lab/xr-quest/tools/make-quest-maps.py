# Blender (float-safe) downscale of the baked maps into xr-quest/quest/ for the ?quest=1 profile.
# Run: blender -b --python tools/make-quest-maps.py
# ImageMagick here is a non-HDRI build and would clip lightmap values above 1.0, so EXRs go through Blender.
import bpy, os
LANE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, DST = os.path.join(LANE, 'baked'), os.path.join(LANE, 'quest')
os.makedirs(DST, exist_ok=True)
sc = bpy.context.scene
for name in ['lm_floor.exr', 'lm_arch.exr', 'lm_furn.exr', 'probe.exr']:
    im = bpy.data.images.load(os.path.join(SRC, name))
    w, h = im.size[:]; mx0 = max(im.pixels[:])
    im.scale(w // 2, h // 2)
    s = sc.render.image_settings
    s.file_format = 'OPEN_EXR'; s.color_depth = '16'; s.exr_codec = 'DWAA'; s.color_mode = 'RGB'
    out = os.path.join(DST, name)
    im.save_render(out, scene=sc)
    chk = bpy.data.images.load(out)
    print('QUEST', name, f'{w}x{h} -> {chk.size[0]}x{chk.size[1]}', 'max', round(mx0, 3), '->', round(max(chk.pixels[:]), 3))

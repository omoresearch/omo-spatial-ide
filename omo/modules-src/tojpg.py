# Convert the linear city panorama EXR to an sRGB JPEG backdrop. Usage: blender -b -P tojpg.py -- in.exr out.jpg [exposure]
import bpy, sys
a = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
im = bpy.data.images.load(a[0])
sc.view_settings.view_transform = 'Standard'; sc.view_settings.exposure = float(a[2]) if len(a) > 2 else 0.0
s = sc.render.image_settings; s.file_format = 'JPEG'; s.quality = 90; s.color_mode = 'RGB'
im.save_render(a[1], scene=sc); print('JPG', a[1], im.size[:])

# Preview still of a module from its door (Cycles, the full lit scene; not the baked maps).
# Run: blender -b work/<id>/scene.blend -P preview.py -- out.png [samples] [view=door|corner]
import bpy, sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import gpu_setup
a = sys.argv[sys.argv.index('--') + 1:]
out = a[0]; S = int(a[1]) if len(a) > 1 else 128; view = a[2] if len(a) > 2 else 'door'
sc = bpy.context.scene; gpu_setup(sc, S)
sc.cycles.max_bounces = 8; sc.cycles.diffuse_bounces = 5; sc.cycles.glossy_bounces = 3; sc.cycles.sample_clamp_indirect = 8.0
sc.cycles.use_denoising = True
cam = bpy.data.cameras.new('cam'); cam.lens = float(os.environ.get("LENS", "19")); cam.sensor_width = 36; cam.clip_start = 0.05; cam.clip_end = 20000
co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
if view == 'door':
    co.location = (4.0, 0.25, 1.62); co.rotation_euler = (math.radians(84), 0, 0)
else:
    co.location = (7.3, 0.6, 1.7); co.rotation_euler = (math.radians(82), 0, math.radians(38))
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1440, 900, 100
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = 'None'; sc.view_settings.exposure = float(os.environ.get('EXPO', '0'))
sc.render.image_settings.file_format = 'PNG'; sc.render.filepath = out
bpy.ops.render.render(write_still=True); print('PREVIEW', out)

# Fast city-only preview: blender -b --factory-startup -P blender/cityprev.py -- outdir [samples] [pct]
import bpy, sys, os, math, time
sys.path.insert(0, os.path.dirname(__file__))
from common import gpu_setup
import city
a = sys.argv[sys.argv.index('--') + 1:]
out = a[0]; S = int(a[1]) if len(a) > 1 else 32; pct = int(a[2]) if len(a) > 2 else 50
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
coll = bpy.data.collections.new('City'); sc.collection.children.link(coll)
t0 = time.time()
n, f = city.build(sc, coll, 230.0, (-24.0, 18.0, -30.0, 12.0))
print('CITY', n, 'buildings', f, 'faces', round(time.time() - t0, 1), 's', flush=True)
gpu_setup(sc, S); sc.cycles.use_denoising = True
sc.view_settings.view_transform = 'AgX'
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1600, 900, pct
cam = bpy.data.cameras.new('cam'); cam.sensor_fit = 'VERTICAL'; cam.angle_y = math.radians(50); cam.clip_end = 20000
co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
for name, (x, y, yaw, pitch) in {'north': (9, 11.5, 0, -14), 'down': (9.5, 11.5, 5, -38), 'east': (17.5, 6, 90, -12), 'ne': (17, 11, 40, -8)}.items():
    co.rotation_euler = (math.radians(90 + pitch), 0, math.radians(-yaw)); co.location = (x, y, 1.65)
    sc.render.filepath = os.path.join(out, name + '.png'); bpy.ops.render.render(write_still=True)
    print('SHOT', name, round(time.time() - t0, 1), flush=True)

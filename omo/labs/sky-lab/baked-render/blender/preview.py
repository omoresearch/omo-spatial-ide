# Quick Cycles preview from eye height: blender -b blender/scene.blend -P blender/preview.py -- out.png x y yawdeg pitchdeg samples
import bpy, sys, math, os
sys.path.insert(0, os.path.dirname(__file__))
from common import gpu_setup
a = sys.argv[sys.argv.index('--') + 1:]
out, x, y, yaw, pitch = a[0], float(a[1]), float(a[2]), float(a[3]), float(a[4])
samples = int(a[5]) if len(a) > 5 else 64
sc = bpy.context.scene
gpu_setup(sc, samples)
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 1600, 900
sc.render.resolution_percentage = int(a[6]) if len(a) > 6 else 50
cam = bpy.data.cameras.new('cam'); cam.sensor_fit = 'VERTICAL'; cam.angle_y = math.radians(55)
co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
# yaw: 0 = looking +y (north), 90 = looking +x (east)
co.rotation_euler = (math.radians(90 + pitch), 0, math.radians(-yaw))
co.location = (x, y, 1.65)
sc.render.filepath = out
sc.render.image_settings.file_format = 'PNG'
sc.view_settings.exposure = float(os.environ.get('EXPO', '0'))
bpy.ops.render.render(write_still=True)

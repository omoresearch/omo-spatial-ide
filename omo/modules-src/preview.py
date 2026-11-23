# Preview still of a module from its door (Cycles, the full lit scene; not the baked maps).
# Run: blender -b work/<id>/scene.blend -P preview.py -- out.png [samples] [view=door|corner] [yaw_deg]
# r5: optional small yaw (+ = turn left); AgX medium-high-contrast look; a short-range AO pass multiplied in
# (the runtime multiplies the baked AO maps the same way) for contact shadows; GPU first, CPU fallback if the
# GPU render fails (e.g. CUDA out of memory while other jobs hold VRAM).
import bpy, sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import gpu_setup
a = sys.argv[sys.argv.index('--') + 1:]
out = a[0]; S = int(a[1]) if len(a) > 1 else 128; view = a[2] if len(a) > 2 else 'door'
MOD = os.path.basename(os.path.dirname(os.path.abspath(bpy.data.filepath)))
# r5d: 'auto' (default) = per-module yaw: the lounge turns 6 deg left to centre its conversation group
YAW = float(a[3]) if len(a) > 3 and a[3] != 'auto' else {'lounge': 6.0}.get(MOD, 0.0)
sc = bpy.context.scene; gpu_setup(sc, S)
sc.cycles.max_bounces = 8; sc.cycles.diffuse_bounces = 5; sc.cycles.glossy_bounces = 3; sc.cycles.sample_clamp_indirect = 8.0
sc.cycles.use_denoising = True
cam = bpy.data.cameras.new('cam'); cam.lens = float(os.environ.get("LENS", "19")); cam.sensor_width = 36; cam.clip_start = 0.05; cam.clip_end = 20000
co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
if view == 'door':
    CH = float(os.environ.get('CAM_H', {'lounge': '1.78', 'library': '1.70'}.get(MOD, '1.55')))   # r5e: a little higher over chair backs
    co.location = (4.0 + 0.6 * math.sin(math.radians(YAW)), 0.25, CH); co.rotation_euler = (math.radians(85 - (CH - 1.55) * 12), 0, math.radians(YAW))
else:
    co.location = (7.3, 0.6, 1.7); co.rotation_euler = (math.radians(82), 0, math.radians(38))
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1440, 900, 100
sc.view_settings.view_transform = 'AgX'; sc.view_settings.look = os.environ.get('LOOK', 'AgX - Medium High Contrast')
sc.view_settings.exposure = float(os.environ.get('EXPO', '0.1'))
AO = float(os.environ.get('AO_MIX', '0.55'))
if AO > 0:
    vl = sc.view_layers[0]; vl.use_pass_ambient_occlusion = True
    if sc.world: sc.world.light_settings.distance = float(os.environ.get('AO_DIST', '0.4'))
    sc.use_nodes = True; nt = sc.node_tree; nt.nodes.clear()
    rl = nt.nodes.new('CompositorNodeRLayers'); dn = nt.nodes.new('CompositorNodeDenoise')
    mx = nt.nodes.new('CompositorNodeMixRGB'); mx.blend_type = 'MULTIPLY'; mx.inputs[0].default_value = AO
    cp = nt.nodes.new('CompositorNodeComposite')
    nt.links.new(rl.outputs['AO'], dn.inputs['Image']); nt.links.new(rl.outputs['Image'], mx.inputs[1]); nt.links.new(dn.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], cp.inputs[0]); sc.render.use_compositing = True
sc.render.image_settings.file_format = 'PNG'; sc.render.filepath = out
if os.path.exists(out): os.remove(out)
try:
    bpy.ops.render.render(write_still=True)
except Exception as e:
    print('GPU RENDER ERROR', e)
if not os.path.exists(out):
    print('GPU render produced no image: falling back to CPU'); sc.cycles.device = 'CPU'
    bpy.ops.render.render(write_still=True)
print('PREVIEW', out, 'ok' if os.path.exists(out) else 'MISSING')

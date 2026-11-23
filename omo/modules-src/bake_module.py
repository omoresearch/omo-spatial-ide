# Module bake (the penthouse bake.py path, cut down for a module): join the Room collection per group, lightmap UVs,
# Cycles DIFFUSE (direct+indirect) lightmaps, AO on the same UVs, an HDR reflection probe from the room centre, and the
# room GLB (joined groups + anchor/seat empties). No city panorama: modules reuse the kit city.
# Skips lightmaps for EMIT (self-lit), SHEER (alpha curtains) and EXT (outer walls: runtime-lit); the preview glass
# lives in its own collection and is never exported (the runtime draws the panes).
# Run: BAKED_OUT=<dir> blender -b work/<id>/scene.blend -P bake_module.py -- [samples=128] [lm=2048] [ao_samples=64]
import bpy, os, sys, math, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import gpu_setup
a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
S = int(a[0]) if a else 128; LM = int(a[1]) if len(a) > 1 else 2048; AOS = int(a[2]) if len(a) > 2 else 64
OUT = os.environ['BAKED_OUT']; os.makedirs(OUT, exist_ok=True)
sc = bpy.context.scene; gpu_setup(sc, S)
if os.environ.get('BAKE_CPU'): sc.cycles.device = 'CPU'
sc.cycles.max_bounces = 8; sc.cycles.diffuse_bounces = 5; sc.cycles.glossy_bounces = 3; sc.cycles.sample_clamp_indirect = 8.0
t0 = time.time()
def log(*x): print(f'[{time.time() - t0:6.1f}s]', *x, flush=True)
def exr(depth='16'):
    s = sc.render.image_settings; s.file_format = 'OPEN_EXR'; s.color_depth = depth; s.exr_codec = 'DWAA' if depth == '16' else 'ZIP'; s.color_mode = 'RGB'
def only(objs, act):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = act
def bake(**kw):
    try: bpy.ops.object.bake(**kw)
    except RuntimeError as e:
        if sc.cycles.device == 'CPU': raise
        log('GPU bake failed (', str(e)[:120], ') -> CPU'); sc.cycles.device = 'CPU'; bpy.ops.object.bake(**kw)

room = [o for o in bpy.data.collections['Room'].objects if o.type == 'MESH']
groups = {}
for o in room:
    g = o.get('grp', 'FURN'); g = 'ARCH' if g in ('WALLS', 'CEIL') else g
    groups.setdefault(g, []).append(o)
log('groups', {k: len(v) for k, v in groups.items()})
SKIP_LM = {'EMIT', 'SHEER', 'EXT'}
J = {}
for g, objs in groups.items():
    only(objs, objs[0]); bpy.ops.object.join(); ob = bpy.context.view_layer.objects.active; ob.name = 'LM_' + g
    if g not in SKIP_LM:
        if 'LM' not in ob.data.uv_layers: ob.data.uv_layers.new(name='LM')
        ob.data.uv_layers['LM'].active = True
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.uv.pack_islands(rotate=True, margin=0.002); bpy.ops.object.mode_set(mode='OBJECT')
        ob.data.uv_layers['UVMap'].active_render = True
    J[g] = ob; log('joined', g, len(ob.data.polygons), 'faces')
SIZES = {'FLOOR': LM // 2, 'ARCH': LM, 'FURN': LM}
sc.render.bake.margin = 8; sc.render.bake.margin_type = 'EXTEND'

def bake_group(g, kind, n, float_buf):
    ob = J[g]; im = bpy.data.images.new(f'{kind}_{g}', n, n, float_buffer=float_buf, alpha=False); nodes = []
    for sl in ob.material_slots:
        m = sl.material; nd = m.node_tree.nodes.new('ShaderNodeTexImage'); nd.image = im; m.node_tree.nodes.active = nd; nodes.append((m, nd))
    only([ob], ob)
    if kind == 'lm': bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, uv_layer='LM', margin=8)
    else: bake(type='AO', uv_layer='LM', margin=8)
    for m, nd in nodes: m.node_tree.nodes.remove(nd)
    return im

if 'lm' in os.environ.get('STEPS', 'lm,ao,probe,glb'):
    os.makedirs(os.path.join(OUT, 'raw'), exist_ok=True)
    for g in ('FLOOR', 'ARCH', 'FURN'):
        if g not in J: continue
        n = SIZES[g]; log('baking lm', g, n, 'px', S, 'spp'); im = bake_group(g, 'lm', n, True)
        exr('16'); p = os.path.join(OUT, 'raw', f'lm_{g.lower()}.exr'); im.save_render(p, scene=sc)
        px = np.array(im.pixels[:]).reshape(n, n, 4)[..., :3]; log('saved', p, 'mean', px.mean(axis=(0, 1)).round(3), 'p99', np.percentile(px, 99).round(2))
if 'ao' in os.environ.get('STEPS', 'lm,ao,probe,glb'):
    sc.cycles.samples = AOS; sc.world.light_settings.distance = 0.6
    for g in ('FLOOR', 'ARCH', 'FURN'):
        if g not in J: continue
        n = SIZES[g]; im = bake_group(g, 'ao', n, False)
        im.filepath_raw = os.path.join(OUT, f'ao_{g.lower()}.png'); im.file_format = 'PNG'; im.save()
        log('AO', g, n, 'mean', round(float(np.array(im.pixels[:]).reshape(n, n, 4)[..., 0].mean()), 3))
    sc.cycles.samples = S
if 'probe' in os.environ.get('STEPS', 'lm,ao,probe,glb'):
    cam = bpy.data.cameras.new('pano'); cam.type = 'PANO'
    try: cam.panorama_type = 'EQUIRECTANGULAR'
    except Exception: cam.cycles.panorama_type = 'EQUIRECTANGULAR'
    cam.clip_start = 0.05; cam.clip_end = 20000
    co = bpy.data.objects.new('pano', cam); sc.collection.objects.link(co); co.rotation_euler = (math.pi / 2, 0, 0); co.location = (4.0, 3.0, 1.4); sc.camera = co
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1024, 512, 100
    sc.cycles.samples = max(32, S // 2); sc.cycles.use_denoising = True; sc.use_nodes = False
    sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'
    exr('16'); sc.render.filepath = os.path.join(OUT, 'probe.exr')
    try: bpy.ops.render.render(write_still=True)
    except Exception as e: log('probe GPU error', e); sc.cycles.device = 'CPU'; bpy.ops.render.render(write_still=True)
    log('probe done')
if 'glb' in os.environ.get('STEPS', 'lm,ao,probe,glb'):
    only(list(J.values()), list(J.values())[0])
    for o in bpy.data.objects:
        if o.type == 'EMPTY' and (o.name.endswith('_anchor') or o.name.startswith('seat_')): o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'room.glb'), export_format='GLB', use_selection=True, export_extras=True,
                              export_texcoords=True, export_normals=True, export_materials='EXPORT', export_image_format='JPEG',
                              export_image_quality=88, export_yup=True, export_lights=False, export_cameras=False, export_apply=True)
    log('glb done')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, '..', 'baked_' + os.path.basename(OUT.rstrip('/')) + '.blend'))
log('ALL DONE')

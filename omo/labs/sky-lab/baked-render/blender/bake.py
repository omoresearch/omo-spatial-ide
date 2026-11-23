# Offline bake: Cycles (OptiX, GPU) lightmaps for the static room, HDR reflection probe,
# city panorama (colour + depth) for a parallax-correct backdrop, and a GLB of the room.
# Run: blender -b blender/scene.blend -P blender/bake.py -- [samples] [lm_size]
import bpy, os, sys, math, struct, zlib, time
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import gpu_setup

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SAMPLES = int(argv[0]) if argv else 512
LM = int(argv[1]) if len(argv) > 1 else 4096
STEPS = argv[2].split(',') if len(argv) > 2 else ['lm', 'probe', 'pano', 'glb']
LANE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.environ.get('BAKED_OUT') or os.path.join(LANE, 'baked', 'next'); os.makedirs(OUT, exist_ok=True)
sc = bpy.context.scene
gpu_setup(sc, SAMPLES)
sc.cycles.max_bounces = 8; sc.cycles.diffuse_bounces = 5; sc.cycles.glossy_bounces = 3
sc.cycles.sample_clamp_indirect = 8.0
EXPOSURE = float(os.environ.get('EXPO', '0.0'))
PANO_C = (9.0, 6.0, 1.65)
t0 = time.time()

def log(*a):
    print(f'[{time.time() - t0:6.1f}s]', *a, flush=True)

def png_rgb(path, arr):
    """arr: HxWx3 uint8, row 0 = top."""
    h, w, _ = arr.shape
    raw = b''.join(b'\x00' + arr[y].tobytes() for y in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))

def exr_settings(depth='16'):
    s = sc.render.image_settings
    s.file_format = 'OPEN_EXR'; s.color_depth = depth; s.exr_codec = 'DWAA' if depth == '16' else 'ZIP'
    s.color_mode = 'RGB'

room = [o for o in bpy.data.collections['Room'].objects if o.type == 'MESH']
groups = {}
for o in room:
    g = o.get('grp', 'FURN')
    g = 'ARCH' if g in ('WALLS', 'CEIL') else g
    groups.setdefault(g, []).append(o)
log('groups', {k: len(v) for k, v in groups.items()})

# ------------------------------------------------------------------ join per group + lightmap UVs
def select_only(objs, active):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = active

JOINED = {}
for g, objs in groups.items():
    select_only(objs, objs[0])
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active; ob.name = 'LM_' + g
    for o in [ob]:
        if 'LM' not in ob.data.uv_layers:
            ob.data.uv_layers.new(name='LM')
    ob.data.uv_layers['LM'].active = True
    select_only([ob], ob)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    margin = 0.002 if g != 'LEAF' else 0.004
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')
    ob.data.uv_layers['UVMap'].active_render = True
    JOINED[g] = ob
    log('joined', g, len(ob.data.polygons), 'faces')

SIZES = {'FLOOR': LM // 2, 'ARCH': LM, 'FURN': LM, 'LEAF': LM // 4, 'EMIT': 256}

# ------------------------------------------------------------------ lightmaps
if 'lm' in STEPS:
    sc.render.bake.margin = 8; sc.render.bake.margin_type = 'EXTEND'
    sc.render.bake.use_pass_direct = True; sc.render.bake.use_pass_indirect = True; sc.render.bake.use_pass_color = False
    for g, ob in JOINED.items():
        if g == 'EMIT':
            continue
        n = SIZES[g]
        im = bpy.data.images.new('lm_' + g, n, n, float_buffer=True, alpha=False)
        nodes = []
        for slot in ob.material_slots:
            m = slot.material; nd = m.node_tree.nodes.new('ShaderNodeTexImage'); nd.image = im
            m.node_tree.nodes.active = nd; nodes.append((m, nd))
        select_only([ob], ob)
        log('baking', g, n, 'px')
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, uv_layer='LM', margin=8)
        exr_settings('16')
        p = os.path.join(OUT, f'lm_{g.lower()}.exr'); im.save_render(p, scene=sc)
        px = np.array(im.pixels[:]).reshape(n, n, 4)[..., :3]
        log('saved', p, 'mean', px.mean(axis=(0, 1)).round(3), 'p99', np.percentile(px, 99).round(2))
        for m, nd in nodes: m.node_tree.nodes.remove(nd)

# ------------------------------------------------------------------ cameras
def pano_cam(loc):
    cam = bpy.data.cameras.new('pano'); cam.type = 'PANO'
    try: cam.panorama_type = 'EQUIRECTANGULAR'
    except Exception: cam.cycles.panorama_type = 'EQUIRECTANGULAR'
    cam.clip_start = 0.05; cam.clip_end = 20000
    co = bpy.data.objects.new('pano', cam); sc.collection.objects.link(co)
    co.rotation_euler = (math.pi / 2, 0, 0); co.location = loc; sc.camera = co
    return co

# reflection probe: whole scene, HDR, linear
if 'probe' in STEPS:
    pano_cam((9.0, 6.0, 1.4))
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 2048, 1024, 100
    sc.cycles.samples = max(64, SAMPLES // 2); sc.cycles.use_denoising = True
    exr_settings('16'); sc.render.filepath = os.path.join(OUT, 'probe.exr')
    bpy.ops.render.render(write_still=True); log('probe done')

# city panorama: room + own tower hidden; colour via AgX (display-referred) + distance
if 'pano' in STEPS:
    HIDE = list(JOINED.values()) + [bpy.data.objects['OwnTower']] + [o for o in bpy.data.objects if o.type == 'LIGHT'] + list(bpy.data.collections['Props'].objects)
    for o in HIDE:
        o.hide_render = True
    pano_cam(PANO_C)
    W = int(os.environ.get('PANO_W', '8192'))
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = W, W // 2, 100
    sc.cycles.samples = max(64, SAMPLES // 4); sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'; sc.view_settings.exposure = 0
    vl = sc.view_layers[0]; vl.use_pass_z = True
    sc.use_nodes = True; nt = sc.node_tree; nt.nodes.clear()
    rl = nt.nodes.new('CompositorNodeRLayers'); comp = nt.nodes.new('CompositorNodeComposite')
    nt.links.new(rl.outputs['Image'], comp.inputs['Image'])
    fo = nt.nodes.new('CompositorNodeOutputFile'); fo.base_path = os.path.join(OUT, 'tmp_depth')
    fo.format.file_format = 'OPEN_EXR'; fo.format.color_depth = '32'; fo.format.exr_codec = 'ZIP'
    nt.links.new(rl.outputs['Depth'], fo.inputs[0])
    exr_settings('16'); sc.render.filepath = os.path.join(OUT, 'city.exr')
    bpy.ops.render.render(write_still=True); log('pano colour done')
    import glob
    dp = sorted(glob.glob(os.path.join(OUT, 'tmp_depth', '*.exr')))[-1]
    di = bpy.data.images.load(dp); di.colorspace_settings.name = 'Non-Color'
    dw, dh = di.size
    d = np.array(di.pixels[:], dtype=np.float32).reshape(dh, dw, 4)[::-1, :, 0]  # row 0 = top
    # downsample to 2048x1024 using min (keeps foreground edges)
    f = dw // 2048
    d = d[:dh // f * f, :dw // f * f].reshape(dh // f, f, dw // f, f).min(axis=(1, 3))
    d = np.clip(np.nan_to_num(d, nan=6000, posinf=6000), 1.0, 6000.0)
    v = np.round(np.log(d) / np.log(6000.0) * 65535).astype(np.uint32)
    rgb = np.zeros(d.shape + (3,), np.uint8); rgb[..., 0] = v >> 8; rgb[..., 1] = v & 255
    png_rgb(os.path.join(OUT, 'city_depth.png'), rgb)
    log('depth range', float(d.min()), float(np.median(d)), float(d.max()))
    for o in HIDE:
        o.hide_render = False

# ------------------------------------------------------------------ GLB of the room
if 'glb' in STEPS:
    select_only(list(JOINED.values()), list(JOINED.values())[0])
    for o in bpy.data.objects:   # marker empties (e.g. webwall_anchor) ride along in the GLB as plain nodes
        if o.type == 'EMPTY' and (o.name.endswith('_anchor') or o.name.startswith('seat_')): o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'room.glb'), export_format='GLB', use_selection=True, export_extras=True,
                              export_texcoords=True, export_normals=True, export_materials='EXPORT',
                              export_image_format='JPEG', export_image_quality=88, export_yup=True,
                              export_lights=False, export_cameras=False, export_apply=True)
    log('glb done')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(LANE, 'blender', 'baked.blend'))
log('ALL DONE')

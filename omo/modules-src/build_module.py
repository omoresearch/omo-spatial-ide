# Room modules: builds ONE hand-made medium room (8 x 6 m, 3.4 m ceiling) with the penthouse pipeline's materials,
# CC0 props and lighting style, and saves modules-src/work/<id>/scene.blend (+ props.json, module.json, plant GLBs).
# Run: blender -b --factory-startup -P build_module.py -- <library|lounge|studio> [out_dir]
#
# Blender space: x 0..W (left -> right seen from the door), y 0..D (front wall with the door at y=0 -> glass at y=D), z up.
# glTF/three space: (x, z_blender, -y). Room-local (the RoomEntity frame, centred, front = +z): (x - W/2, z, D/2 - y).
# Wall inner faces sit 0.1 m inside the footprint, so the runtime collision walls (0.2 m centred on the edge) match.
import bpy, bmesh, math, random, os, sys, json
from mathutils import Vector, Matrix
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import NB
from dress import rug_texture, canvas_texture, uv_fit, _blur, _save
from zones import _fabric

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
MID = argv[0] if argv else 'lounge'
assert MID in ('library', 'lounge', 'studio'), MID
OUT = os.path.abspath(argv[1]) if len(argv) > 1 else os.path.join(HERE, 'work', MID)
os.makedirs(OUT, exist_ok=True)
A = os.path.join(HERE, 'assets'); GEN = os.path.join(HERE, 'gen'); os.makedirs(GEN, exist_ok=True)
CC0 = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'omo-sky-lab', 'cc0-assets', 'assets', 'models'))
if not os.path.isdir(CC0): CC0 = os.path.expanduser('~/dev/omo-sky-lab/cc0-assets/assets/models')
SEED = {'library': 11, 'lounge': 23, 'studio': 37}[MID]
rnd = random.Random(SEED)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
ROOM = bpy.data.collections.new('Room'); scene.collection.children.link(ROOM)
PROPS = bpy.data.collections.new('Props'); scene.collection.children.link(PROPS)
MK = bpy.data.collections.new('Markers'); scene.collection.children.link(MK)

W, D, H = 8.0, 6.0, 3.4      # footprint + ceiling
T = 0.1                       # half wall thickness (inner skin ARCH, outer skin EXT)
DOOR_W, DOOR_H = 1.6, 2.3
DX0, DX1 = W / 2 - DOOR_W / 2, W / 2 + DOOR_W / 2
IX0, IX1, IY0, IY1 = T, W - T, T, D - T   # inner faces

# ---------------------------------------------------------------- materials (penthouse set, build.py)
MATS, TILE = {}, {}
def img(name, colorspace='sRGB'):
    p = name if os.path.isabs(name) else os.path.join(A, name)
    im = bpy.data.images.load(p, check_existing=True); im.colorspace_settings.name = colorspace; return im

def principled(name, color=(0.5, 0.5, 0.5), rough=0.5, metal=0.0, diff=None, roughmap=None, normal=None, tile=1.0, emit=None, emit_strength=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nb = NB(m.node_tree); bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1); bsdf.inputs['Roughness'].default_value = rough; bsdf.inputs['Metallic'].default_value = metal
    uv = nb.node('ShaderNodeUVMap', uv_map='UVMap') if (diff or roughmap or normal) else None
    if diff:
        t = nb.node('ShaderNodeTexImage'); t.image = img(diff); nb.link(uv.outputs[0], t.inputs[0]); nb.link(t.outputs[0], bsdf.inputs['Base Color'])
    if roughmap:
        t = nb.node('ShaderNodeTexImage'); t.image = img(roughmap, 'Non-Color'); nb.link(uv.outputs[0], t.inputs[0]); nb.link(t.outputs[0], bsdf.inputs['Roughness'])
    if normal:
        t = nb.node('ShaderNodeTexImage'); t.image = img(normal, 'Non-Color'); nb.link(uv.outputs[0], t.inputs[0])
        nm = nb.node('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = 0.25
        nb.link(t.outputs[0], nm.inputs['Color']); nb.link(nm.outputs[0], bsdf.inputs['Normal'])
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = (*emit, 1); bsdf.inputs['Emission Strength'].default_value = emit_strength
        bsdf.inputs['Base Color'].default_value = (0, 0, 0, 1)
    MATS[name] = m; TILE[name] = tile
    return m

principled('Parquet', diff='herringbone_parquet_diff_2k.jpg', roughmap='herringbone_parquet_rough_2k.jpg', normal='herringbone_parquet_nor_gl_2k.jpg', tile=2.0)
def _remap_rough(m, lo, hi):
    nt = m.node_tree; b = nt.nodes['Principled BSDF']; src = b.inputs['Roughness'].links[0].from_socket
    mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = lo; mr.inputs['To Max'].default_value = hi
    nt.links.new(src, mr.inputs['Value']); nt.links.new(mr.outputs['Result'], b.inputs['Roughness'])
_remap_rough(MATS['Parquet'], 0.48, 0.78)
principled('Walnut', diff='wood_table_001_diff_1k.jpg', roughmap='wood_table_001_rough_1k.jpg', tile=1.4)
principled('DarkWood', diff='dark_wood_diff_1k.jpg', rough=0.45, tile=1.2)
principled('Marble', diff='marble_01_diff_1k.jpg', roughmap='marble_01_rough_1k.jpg', tile=0.9)
principled('Ceiling', color=(0.72, 0.72, 0.70), rough=0.95)
principled('Plaster', color=(0.56, 0.54, 0.51), rough=0.9)
principled('PlasterExt', color=(0.62, 0.60, 0.56), rough=0.9)
def _trowel(m, base, amp=0.06, scale=1.6):
    m['flat'] = list(base)   # glTF export: the procedural mottle is Cycles-only; the GLB keeps the flat colour
    nt = m.node_tree; b = nt.nodes['Principled BSDF']; nb = NB(nt)
    tc = nb.node('ShaderNodeTexCoord'); nz = nb.node('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = 6; nz.inputs['Roughness'].default_value = 0.55
    nb.link(tc.outputs['Object'], nz.inputs['Vector'])
    lo = tuple(c * (1 - amp) for c in base); hi = tuple(c * (1 + amp) for c in base)
    ramp = nb.node('ShaderNodeValToRGB'); ramp.color_ramp.elements[0].color = (*lo, 1); ramp.color_ramp.elements[1].color = (*hi, 1)
    ramp.color_ramp.elements[0].position = 0.3; ramp.color_ramp.elements[1].position = 0.7
    nb.link(nz.outputs['Fac'], ramp.inputs['Fac']); nb.link(ramp.outputs['Color'], b.inputs['Base Color'])
    bp = nb.node('ShaderNodeBump'); bp.inputs['Strength'].default_value = 0.06; bp.inputs['Distance'].default_value = 0.02
    nz2 = nb.node('ShaderNodeTexNoise'); nz2.inputs['Scale'].default_value = 9.0; nz2.inputs['Detail'].default_value = 8
    nb.link(tc.outputs['Object'], nz2.inputs['Vector']); nb.link(nz2.outputs['Fac'], bp.inputs['Height']); nb.link(bp.outputs['Normal'], b.inputs['Normal'])
_trowel(MATS['Plaster'], (0.56, 0.54, 0.51)); _trowel(MATS['PlasterExt'], (0.62, 0.60, 0.56), 0.05, 1.0); _trowel(MATS['Ceiling'], (0.72, 0.72, 0.70), 0.03, 1.2)
principled('Oak', color=(0.30, 0.17, 0.08), rough=0.55)
principled('Bronze', color=(0.10, 0.085, 0.07), rough=0.35, metal=1.0)
principled('BlackMetal', color=(0.03, 0.03, 0.03), rough=0.35, metal=1.0)
principled('Brass', color=(0.62, 0.45, 0.20), rough=0.3, metal=1.0)
principled('Leather', color=(0.20, 0.07, 0.025), rough=0.45)
principled('LeatherTan', color=(0.38, 0.18, 0.07), rough=0.5)
principled('Plastic', color=(0.025, 0.025, 0.028), rough=0.45)
principled('Ceramic', color=(0.80, 0.78, 0.74), rough=0.15)
principled('Stone', color=(0.20, 0.19, 0.18), rough=0.7)
principled('StoneDark', color=(0.12, 0.115, 0.11), rough=0.7)
principled('Wax', color=(0.82, 0.76, 0.66), rough=0.6)
principled('BoardWhite', color=(0.80, 0.80, 0.78), rough=0.25)
for k, c in zip('ABCDE', ((0.45, 0.40, 0.32), (0.08, 0.12, 0.18), (0.35, 0.08, 0.05), (0.62, 0.58, 0.50), (0.12, 0.20, 0.16))):
    principled('Book' + k, color=c, rough=0.8)
principled('PotTerracotta', color=(0.42, 0.20, 0.11), rough=0.85)
principled('PotStone', color=(0.52, 0.50, 0.46), rough=0.75)
principled('PotBlack', color=(0.03, 0.03, 0.032), rough=0.5)
principled('Soil', color=(0.05, 0.035, 0.025), rough=1.0)
principled('EmitDown', emit=(1.0, 0.62, 0.34), emit_strength=6.0)
principled('EmitShade', emit=(1.0, 0.56, 0.27), emit_strength=5.0)
principled('EmitStrip', emit=(1.0, 0.74, 0.50), emit_strength=7.0)
principled('EmitCove', emit=(1.0, 0.55, 0.25), emit_strength=0.8)
principled('EmitCandle', emit=(1.0, 0.55, 0.20), emit_strength=30.0)
import numpy as _np
def _term_tex(name, seed):
    rs = _np.random.default_rng(seed); h, w = 360, 640; col = _np.ones((h, w, 3)) * _np.array((0.035, 0.045, 0.06))
    col[:22] = (0.09, 0.10, 0.13)
    y = 40
    while y < h - 20:
        x0 = 24 + 18 * rs.integers(0, 3); ln = rs.integers(60, 420); c = [(0.55, 0.75, 0.55), (0.75, 0.72, 0.62), (0.45, 0.62, 0.85), (0.85, 0.55, 0.35)][rs.integers(0, 4)]
        col[y:y + 7, x0:x0 + ln] = c; y += 16 + 8 * rs.integers(0, 2)
    return os.path.join(GEN, _save(GEN, name, col))
for _k in range(3):
    _m = principled(f'EmitScreen{_k}', emit=(1, 1, 1), emit_strength=1.4)
    _nt = _m.node_tree; _b = _nt.nodes['Principled BSDF']; _uv = _nt.nodes.new('ShaderNodeUVMap'); _uv.uv_map = 'UVMap'
    _t = _nt.nodes.new('ShaderNodeTexImage'); _t.image = img(_term_tex(f'gen_term_{_k}', 50 + _k)); _nt.links.new(_uv.outputs[0], _t.inputs[0]); _nt.links.new(_t.outputs[0], _b.inputs['Emission Color'])
principled('VelvetTeal', diff=_fabric(GEN, 'gen_velvet_teal', (0.07, 0.27, 0.28), 31), rough=0.82, tile=0.9)
principled('VelvetMustard', diff=_fabric(GEN, 'gen_velvet_mustard', (0.56, 0.36, 0.08), 32), rough=0.85, tile=0.9)
principled('VelvetRust', diff=_fabric(GEN, 'gen_velvet_rust', (0.46, 0.15, 0.07), 33), rough=0.85, tile=0.9)
principled('VelvetPlum', diff=_fabric(GEN, 'gen_velvet_plum', (0.25, 0.08, 0.20), 34), rough=0.85, tile=0.9)
principled('Boucle', diff=_fabric(GEN, 'gen_boucle_oat', (0.66, 0.60, 0.50), 35, weave=0.14, mott=0.2), rough=1.0, tile=0.6)
principled('Linen', diff=_fabric(GEN, 'gen_linen_rust', (0.50, 0.20, 0.09), 38, weave=0.18, mott=0.15), rough=1.0, tile=0.5)
G = lambda n: os.path.join(GEN, n)
principled('RugPit', diff=G(rug_texture(GEN, 'gen_rug_pit', (0.58, 0.50, 0.40), (0.30, 0.16, 0.10), (0.72, 0.60, 0.42), 36, bw=0.06)), rough=1.0)
principled('RugNook', diff=G(rug_texture(GEN, 'gen_rug_nook', (0.28, 0.12, 0.20), (0.18, 0.08, 0.13), (0.70, 0.52, 0.30), 37, bw=0.08)), rough=1.0)
principled('RugCharcoal', diff=G(rug_texture(GEN, 'gen_rug_charcoal', (0.36, 0.31, 0.25), (0.22, 0.17, 0.13), (0.62, 0.52, 0.36), 2, bw=0.04)), rough=1.0)
principled('RugSlate', diff=G(rug_texture(GEN, 'gen_rug_slate', (0.46, 0.40, 0.33), (0.30, 0.20, 0.14), (0.72, 0.62, 0.44), 3, bw=0.05)), rough=1.0)
principled('CanvasB', diff=G(canvas_texture(GEN, 'gen_canvas_b', (0.80, 0.76, 0.66),
           [(0.10, 0.58, 0.12, 0.88, (0.06, 0.10, 0.20), 0.04), (0.64, 0.90, 0.40, 0.88, (0.74, 0.52, 0.16), 0.04)], 5, w=1024, h=700)), rough=0.85)
principled('CanvasW', diff=G(canvas_texture(GEN, 'gen_canvas_w', (0.74, 0.66, 0.54),
           [(0.12, 0.52, 0.10, 0.62, (0.56, 0.20, 0.08), 0.05), (0.40, 0.90, 0.48, 0.90, (0.10, 0.20, 0.22), 0.05), (0.20, 0.70, 0.70, 0.86, (0.82, 0.62, 0.24), 0.03)], 7, w=700, h=1024)), rough=0.85)
principled('CanvasE', diff=G(canvas_texture(GEN, 'gen_canvas_e', (0.20, 0.17, 0.15),
           [(0.08, 0.92, 0.55, 0.92, (0.62, 0.30, 0.12), 0.06), (0.30, 0.70, 0.12, 0.45, (0.80, 0.70, 0.52), 0.04)], 9, w=760, h=1024)), rough=0.85)

# ---------------------------------------------------------------- mesh helpers (build.py)
OBJS = []
def boxmap(bm, tile):
    uvl = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        n = f.normal; ax = max(range(3), key=lambda i: abs(n[i]))
        for l in f.loops:
            p = l.vert.co
            u, v = (p.y, p.z) if ax == 0 else (p.x, p.z) if ax == 1 else (p.x, p.y)
            l[uvl].uv = (u / tile, v / tile)

def finish(bm, name, mat, group):
    boxmap(bm, TILE.get(mat, 1.0))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); me.materials.append(MATS[mat])
    for p in me.polygons: p.use_smooth = False
    ob = bpy.data.objects.new(name, me); ROOM.objects.link(ob); ob['grp'] = group; OBJS.append(ob)
    return ob

def box(name, c, s, mat, group='FURN', bevel=0.0, seg=2):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * s[0] + c[0], v.co.y * s[1] + c[1], v.co.z * s[2] + c[2]))
    if bevel > 0: bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=seg, profile=0.5, affect='EDGES')
    bm.normal_update(); return finish(bm, name, mat, group)

def rbox(name, c, s, ang, mat, group='FURN', bevel=0.0, seg=2):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * s[0], v.co.y * s[1], v.co.z * s[2]))
    if bevel > 0: bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=seg, profile=0.5, affect='EDGES')
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(ang, 3, 'Z'))
    for v in bm.verts: v.co += Vector(c)
    bm.normal_update(); return finish(bm, name, mat, group)

def cyl(name, c, r, h, mat, group='FURN', seg=32, r2=None, caps=True):
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=caps, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)
    for v in bm.verts: v.co += Vector(c)
    bm.normal_update(); return finish(bm, name, mat, group)

def quad(name, pts, mat, group):
    bm = bmesh.new(); vs = [bm.verts.new(p) for p in pts]; bm.faces.new(vs); bm.normal_update(); return finish(bm, name, mat, group)

def face_rot(d):
    """Blender z-rotation so the object's local -Y points along world d (= three.js local +Z, glTF front)."""
    return math.atan2(d[0], -d[1])

REALTIME = []
def cc0(aid, loc, rotz=0.0, scale=1.0, baked=True):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(CC0, aid, aid + '.gltf'))
    new = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new('cc0_' + aid, None); scene.collection.objects.link(root)
    root.location = loc; root.rotation_euler = (0, 0, rotz); root.scale = (scale,) * 3
    for o in new:
        if o.parent is None: o.parent = root
    bpy.context.view_layer.update()
    for o in new:
        if o.type == 'MESH':
            mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
            for c in list(o.users_collection): c.objects.unlink(o)
            (ROOM if baked else PROPS).objects.link(o); o['grp'] = 'FURN'
    for o in new:
        if o.type != 'MESH': bpy.data.objects.remove(o)
    bpy.data.objects.remove(root)
    if not baked: REALTIME.append({'id': aid, 'pos': [loc[0], loc[2], -loc[1]], 'rotY': rotz, 'scale': scale})

EXPORTED = set()
def potted(key, aid, keep, loc, rotz, scale, pot):
    """A single CC0 plant variant in a real pot: drawn live in three.js (plant_<key>.glb), a shadow caster in the bake."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(CC0, aid, aid + '.gltf'))
    new = [o for o in bpy.data.objects if o not in before]; bpy.context.view_layer.update()
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes: mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
    for o in new:
        if o.type != 'MESH': bpy.data.objects.remove(o)
    kept = []
    for o in meshes:
        if keep and not any(o.name.startswith(p) for p in keep): bpy.data.objects.remove(o)
        else: kept.append(o)
    pts = [o.matrix_world @ v.co for o in kept for v in o.data.vertices]
    zmin = min(p.z for p in pts); low = [p for p in pts if p.z < zmin + 0.1]
    cx = sum(p.x for p in low) / len(low); cy = sum(p.y for p in low) / len(low)
    objs = list(kept)
    if pot:
        r, h, pm = pot['r'], pot['h'], pot['mat']; sink = pot.get('sink', 0.03); tp = pot.get('taper', 0.86)
        for o in kept: o.location += Vector((-cx, -cy, h - sink - zmin))
        for nm, rr, hh, zc, mat, r1 in (('Pot', r, h, h / 2, pm, r * tp), ('Soil', r * 0.9, 0.02, h - 0.035, 'Soil', r * 0.9)):
            bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=40, radius1=r1, radius2=rr, depth=hh)
            for v in bm.verts: v.co += Vector((0, 0, zc))
            bm.normal_update(); me = bpy.data.meshes.new(key + nm); bm.to_mesh(me); bm.free()
            for p_ in me.polygons: p_.use_smooth = True
            me.materials.append(MATS[mat]); po = bpy.data.objects.new(key + nm, me); scene.collection.objects.link(po); objs.append(po)
    else:
        for o in kept: o.location += Vector((-cx, -cy, -zmin))
    for o in objs:
        for c in list(o.users_collection): c.objects.unlink(o)
        PROPS.objects.link(o); o['grp'] = 'FURN'
    bpy.context.view_layer.update()
    path = os.path.join(OUT, 'plant_' + key + '.glb')
    if key not in EXPORTED:
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs: o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
                                  export_lights=False, export_cameras=False, export_extras=False, export_image_format='JPEG', export_image_quality=85)
        EXPORTED.add(key)
    Tm = Matrix.Translation(loc) @ Matrix.Rotation(rotz, 4, 'Z') @ Matrix.Scale(scale, 4)
    for o in objs: o.matrix_world = Tm @ o.matrix_world
    REALTIME.append({'id': key, 'url': 'plant_' + key + '.glb', 'pos': [loc[0], loc[2], -loc[1]], 'rotY': rotz, 'scale': scale})

_PILED = set()
def _pile(m):
    if m.name in _PILED: return
    _PILED.add(m.name); nt = m.node_tree; b = nt.nodes['Principled BSDF']; nb = NB(nt)
    nz = nb.node('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 260; nz.inputs['Detail'].default_value = 2
    bp = nb.node('ShaderNodeBump'); bp.inputs['Strength'].default_value = 0.35; bp.inputs['Distance'].default_value = 0.004
    nb.link(nz.outputs['Fac'], bp.inputs['Height']); nb.link(bp.outputs['Normal'], b.inputs['Normal']); b.inputs['Sheen Weight'].default_value = 0.4
def rug(name, cx, cy, w, d, mat, ang=0.0):
    _pile(MATS[mat])
    ob = rbox(name, (cx, cy, 0.007), (w, d, 0.014), ang, mat, bevel=0.004, seg=1)
    if ang == 0.0: uv_fit(ob, cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2)
    else:
        me = ob.data; uvl = me.uv_layers['UVMap']; ca, sa = math.cos(-ang), math.sin(-ang)
        for p in me.polygons:
            for li in p.loop_indices:
                co = me.vertices[me.loops[li].vertex_index].co; lx = (co.x - cx) * ca - (co.y - cy) * sa; ly = (co.x - cx) * sa + (co.y - cy) * ca
                uvl.data[li].uv = (lx / w + 0.5, ly / d + 0.5)
    return ob

LAMPS = []
def light(name, kind, loc, energy, color, soft=0.08, **kw):
    ld = bpy.data.lights.new(name, kind); ld.energy = energy; ld.color = color; ld.shadow_soft_size = soft
    if kind == 'SPOT': ld.spot_size = math.radians(kw.get('cone', 100)); ld.spot_blend = kw.get('blend', 0.7)
    if kind == 'AREA': ld.shape = 'RECTANGLE'; ld.size = kw.get('sx', 1.0); ld.size_y = kw.get('sy', 0.05)
    lo = bpy.data.objects.new(name, ld); lo.location = loc; ROOM.objects.link(lo)
    if 'rot' in kw: lo.rotation_euler = kw['rot']
    if kind == 'AREA': lo.visible_camera = False; lo.visible_glossy = False
    return lo

def empty(name, loc, rotz, props=None):
    e = bpy.data.objects.new(name, None); e.empty_display_type = 'ARROWS'; e.empty_display_size = 0.3
    e.location = loc; e.rotation_euler = (0, 0, rotz)
    for k, v in (props or {}).items(): e[k] = v
    MK.objects.link(e); return e

WARM = (1.0, 0.50, 0.18)
def table_lamp(k, x, y, z, energy=40):
    cyl(f'TLampBase{k}', (x, y, z + 0.16), 0.07, 0.32, 'Ceramic', seg=32, r2=0.05)
    cyl(f'TLampShade{k}', (x, y, z + 0.42), 0.17, 0.22, 'EmitShade', 'EMIT', seg=48, r2=0.15, caps=False)
    cyl(f'TLampTop{k}', (x, y, z + 0.528), 0.148, 0.004, 'BlackMetal', seg=48)
    light(f'TableLamp{k}', 'SPOT', (x, y, z + 0.36), energy * 3.0, WARM, soft=0.05, cone=150, blend=0.6)
    light(f'TableLampUp{k}', 'POINT', (x, y, z + 0.44), energy * 0.35, (1.0, 0.52, 0.20), soft=0.08)

def floor_lamp(k, x, y, h=1.58, energy=70):
    cyl(f'LampBase{k}', (x, y, 0.02), 0.17, 0.04, 'Marble', seg=48)
    cyl(f'LampPole{k}', (x, y, h / 2), 0.011, h, 'BlackMetal', seg=12)
    cyl(f'LampShade{k}', (x, y, h + 0.02), 0.21, 0.32, 'EmitShade', 'EMIT', seg=48, r2=0.19, caps=False)
    cyl(f'LampCap{k}', (x, y, h + 0.178), 0.19, 0.006, 'BlackMetal', seg=48)
    light(f'FloorLamp{k}', 'SPOT', (x, y, h - 0.06), energy * 2.2, WARM, soft=0.06, cone=140, blend=0.6)
    light(f'FloorLampUp{k}', 'POINT', (x, y, h + 0.02), energy * 0.3, (1.0, 0.52, 0.20), soft=0.1)

def downlight(x, y, power=6.0, cone=70):
    cyl(f'DLtrim_{x:.2f}_{y:.2f}', (x, y, H - 0.004), 0.055, 0.008, 'EmitDown', 'EMIT', seg=24)
    lo = light(f'DL_{x:.2f}_{y:.2f}', 'SPOT', (x, y, H - 0.01), power, (1.0, 0.50, 0.20), soft=0.04, cone=cone, blend=0.6)

def pendant(k, x, y, z=1.75, r=0.30, energy=90):
    cyl(f'Pend{k}', (x, y, z), r, 0.22, 'EmitShade', 'EMIT', seg=48, r2=r * 0.93, caps=False)
    cyl(f'PendTop{k}', (x, y, z + 0.108), r * 0.93, 0.004, 'BlackMetal', seg=48)
    cyl(f'PendCap{k}', (x, y, z + 0.115), r * 0.96, 0.01, 'BlackMetal', seg=48)
    box(f'PendWire{k}', (x, y, (H + z + 0.12) / 2), (0.006, 0.006, H - z - 0.12), 'BlackMetal')
    light(f'PendLight{k}', 'SPOT', (x, y, z - 0.08), energy, WARM, soft=0.05, cone=120, blend=0.5)

def canvas_on_wall(name, wall, c, w, h, z, mat, frame='Oak'):
    """A framed canvas on a side wall ('left' x=IX0 / 'right' x=IX1) at y=c, or the front wall ('front') at x=c."""
    if wall == 'left':
        ob = box(name, (IX0 + 0.025, c, z), (0.04, w, h), mat, bevel=0.004, seg=1); uv_fit(ob, c + w / 2, c - w / 2, z - h / 2, z + h / 2, axes=(1, 2))
        box(name + 'Frame', (IX0 + 0.014, c, z), (0.028, w + 0.05, h + 0.05), frame)
    elif wall == 'right':
        ob = box(name, (IX1 - 0.025, c, z), (0.04, w, h), mat, bevel=0.004, seg=1); uv_fit(ob, c - w / 2, c + w / 2, z - h / 2, z + h / 2, axes=(1, 2))
        box(name + 'Frame', (IX1 - 0.014, c, z), (0.028, w + 0.05, h + 0.05), frame)

def shelf_run(name, x0, y0, y1, height=2.6, depth=0.36, side='left', fill=0.82):
    """Steel posts + oak shelves along a side wall, filled with books, stacks and objects (zones.py)."""
    sx = 1 if side == 'left' else -1
    xc = x0 + sx * depth / 2
    n = max(1, int(round((y1 - y0) / 1.1)))
    posts = [y0 + (y1 - y0) * i / n for i in range(n + 1)]
    for y in posts: box(f'{name}Post{y:.2f}', (xc, y, height / 2), (depth + 0.02, 0.03, height), 'BlackMetal')
    zs = [0.06 + i * (height - 0.12) / 5 for i in range(6)]
    for k, z in enumerate(zs):
        box(f'{name}Shelf{k}', (xc, (y0 + y1) / 2, z), (depth, y1 - y0, 0.03), 'Oak', bevel=0.003)
        if k == len(zs) - 1: break
        for i in range(n):
            a0, a1 = posts[i] + 0.03, posts[i + 1] - 0.03
            y = a0 + rnd.uniform(0.0, 0.12)
            while y < a1 - 0.05:
                r_ = rnd.random()
                if r_ > fill:
                    if rnd.random() < 0.5:
                        cyl(f'{name}Vase{k}_{y:.2f}', (xc, y + 0.08, z + 0.015 + 0.10), rnd.uniform(0.05, 0.07), 0.20, rnd.choice(['Ceramic', 'Stone', 'Bronze', 'PotTerracotta']), seg=24, r2=0.04)
                    y += 0.28; continue
                for _ in range(rnd.randint(6, 16)):
                    t = rnd.uniform(0.022, 0.045); hh = rnd.uniform(0.20, min(0.34, (height - 0.12) / 5 - 0.06)); dd = rnd.uniform(0.17, 0.25)
                    if y + t > a1: break
                    lean = rnd.random() < 0.04
                    bx = x0 + sx * (0.04 + dd / 2)
                    if lean: rbox(f'{name}Book{k}_{y:.3f}', (bx, y + t / 2 + 0.03, z + 0.015 + hh / 2 - 0.01), (dd, t, hh), 0.0, rnd.choice(['BookA', 'BookB', 'BookC', 'BookD', 'BookE', 'Leather']), bevel=0.002, seg=1)
                    else: box(f'{name}Book{k}_{y:.3f}', (bx, y + t / 2, z + 0.015 + hh / 2), (dd, t, hh), rnd.choice(['BookA', 'BookB', 'BookC', 'BookD', 'BookE', 'Leather']), bevel=0.002, seg=1)
                    y += t + 0.002
                if rnd.random() < 0.3 and y < a1 - 0.28:
                    zz = z + 0.015
                    for _ in range(rnd.randint(2, 4)):
                        hh = rnd.uniform(0.03, 0.05)
                        box(f'{name}Stack{k}_{y:.3f}_{zz:.3f}', (x0 + sx * 0.15, y + 0.13, zz + hh / 2), (0.22, 0.24, hh), rnd.choice(['BookA', 'BookD', 'BookB', 'BookC']), bevel=0.002, seg=1)
                        zz += hh
                    y += 0.28
    return xc

SEATS = []
def seat(x, y, z, d, kind, zone): SEATS.append((x, y, z, d, kind, zone))

class Frame:
    def __init__(self, cx, cy, d):
        self.c = Vector((cx, cy)); n = math.hypot(*d); self.d = (d[0] / n, d[1] / n); self.ang = math.atan2(-self.d[0], self.d[1])
    def p(self, lx, ly, z=0.0):
        ca, sa = math.cos(self.ang), math.sin(self.ang)
        return (self.c.x + lx * ca - ly * sa, self.c.y + lx * sa + ly * ca, z)

def sofa(name, cx, cy, d, seats, mat, pillow_mats, zone, seat_w=0.9, depth=1.0):
    F = Frame(cx, cy, d); arm = 0.22; Wd = seats * seat_w + 2 * arm; Dd = depth; a = F.ang
    rbox(name + 'Plinth', F.p(0, 0, 0.04), (Wd - 0.12, Dd - 0.12, 0.08), a, 'DarkWood')
    rbox(name + 'Throw', F.p(Wd / 2 - arm / 2, 0.05, 0.605), (arm + 0.06, Dd * 0.7, 0.03), a, 'Boucle', bevel=0.012, seg=2)
    rbox(name + 'ThrowFall', F.p(Wd / 2 + 0.02, 0.05, 0.36), (0.03, Dd * 0.7, 0.48), a, 'Boucle', bevel=0.012, seg=2)
    rbox(name + 'Base', F.p(0, 0, 0.19), (Wd, Dd, 0.22), a, mat, bevel=0.03, seg=2)
    rbox(name + 'Back', F.p(0, -Dd / 2 + 0.11, 0.52), (Wd, 0.22, 0.48), a, mat, bevel=0.05, seg=3)
    for s_ in (-1, 1): rbox(f'{name}Arm{s_}', F.p(s_ * (Wd / 2 - arm / 2), 0.0, 0.36), (arm, Dd, 0.48), a, mat, bevel=0.06, seg=3)
    for i in range(seats):
        lx = -Wd / 2 + arm + seat_w * (i + 0.5)
        rbox(f'{name}Seat{i}', F.p(lx, 0.09, 0.385), (seat_w - 0.025, Dd - 0.27, 0.15), a, mat, bevel=0.055, seg=3)
        rbox(f'{name}BackC{i}', F.p(lx, -Dd / 2 + 0.31, 0.64), (seat_w - 0.04, 0.19, 0.40), a, mat, bevel=0.075, seg=3)
        sx_, sy_, _ = F.p(lx, 0.10); seat(sx_, sy_, 0.46, F.d, 'sofa', zone)
    for j, pm in enumerate(pillow_mats):
        sxn = -1 if j == 0 else 1
        rbox(f'{name}Pillow{j}', F.p(sxn * (Wd / 2 - arm - 0.26), -Dd / 2 + 0.45, 0.63), (0.42, 0.13, 0.40), a + sxn * 0.18, pm, bevel=0.06, seg=3)
    return F

# ================================================================ SHELL (shared by every module)
# Floor + ceiling
quad('Floor', [(0, 0, 0), (W, 0, 0), (W, D, 0), (0, D, 0)], 'Parquet', 'FLOOR')
quad('Ceiling', [(IX0, IY0, H), (IX0, IY1, H), (IX1, IY1, H), (IX1, IY0, H)], 'Ceiling', 'CEIL')
# Inner skins (ARCH) and outer skins (EXT: drawn with runtime light, not baked).
def wall_pair(name, c_in, s_in, c_out, s_out):
    box(name + 'In', c_in, s_in, 'Plaster', 'WALLS'); box(name + 'Out', c_out, s_out, 'PlasterExt', 'EXT')
wall_pair('WallL', (T / 2, D / 2, H / 2), (T, D - 2 * T, H), (-T / 2, D / 2, H / 2), (T, D + 2 * T, H))
wall_pair('WallR', (W - T / 2, D / 2, H / 2), (T, D - 2 * T, H), (W + T / 2, D / 2, H / 2), (T, D + 2 * T, H))
for k, (xa, xb) in enumerate(((0, DX0), (DX1, W))):
    wall_pair(f'WallF{k}', ((xa + xb) / 2 + (T / 2 if k == 0 else -T / 2), T / 2, H / 2), (xb - xa - T, T, H), ((xa + xb) / 2, -T / 2, H / 2), (xb - xa, T, H))
wall_pair('Lintel', (W / 2, T / 2, (DOOR_H + H) / 2), (DOOR_W, T, H - DOOR_H), (W / 2, -T / 2, (DOOR_H + H) / 2), (DOOR_W, T, H - DOOR_H))
# Roof slab + bronze fascia band (outside), a stone plinth round the base (outside)
box('Roof', (W / 2, D / 2, H + 0.12), (W + 2 * T + 0.08, D + 2 * T + 0.08, 0.24), 'PlasterExt', 'EXT')
box('Fascia', (W / 2, D / 2, H + 0.27), (W + 2 * T + 0.12, D + 2 * T + 0.12, 0.06), 'Bronze', 'EXT')
for nm, c, s in (('PlinthL', (-T - 0.012, D / 2, 0.14), (0.024, D + 2 * T + 0.05, 0.28)), ('PlinthR', (W + T + 0.012, D / 2, 0.14), (0.024, D + 2 * T + 0.05, 0.28)),
                 ('PlinthF0', (DX0 / 2, -T - 0.012, 0.14), (DX0 + 2 * T, 0.024, 0.28)), ('PlinthF1', ((DX1 + W) / 2, -T - 0.012, 0.14), (W - DX1 + 2 * T, 0.024, 0.28))):
    box(nm, c, s, 'StoneDark', 'EXT')
# Door: bronze casing on both faces + reveal linings + a brass threshold
J = 0.10
for s_ in (-1, 1):
    x = W / 2 + s_ * (DOOR_W / 2 + J / 2 - 0.02)
    box(f'Jamb{s_}', (x, 0.0, DOOR_H / 2 + 0.03), (J, 2 * T + 0.05, DOOR_H + 0.06), 'Bronze', 'WALLS')
box('DoorHead', (W / 2, 0.0, DOOR_H + 0.05), (DOOR_W + 2 * J, 2 * T + 0.05, 0.10), 'Bronze', 'WALLS')
box('Threshold', (W / 2, 0.0, 0.006), (DOOR_W - 0.04, 2 * T + 0.04, 0.012), 'Brass', 'FLOOR')
# Skirting + soffit band with a warm cove on the three solid walls
SK = 0.12
box('SkirtL', (IX0 + 0.01, D / 2, SK / 2), (0.02, IY1 - IY0, SK), 'Walnut', 'WALLS')
box('SkirtR', (IX1 - 0.01, D / 2, SK / 2), (0.02, IY1 - IY0, SK), 'Walnut', 'WALLS')
box('SkirtF0', ((IX0 + DX0 - J) / 2, IY0 + 0.01, SK / 2), (DX0 - J - IX0, 0.02, SK), 'Walnut', 'WALLS')
box('SkirtF1', ((DX1 + J + IX1) / 2, IY0 + 0.01, SK / 2), (IX1 - DX1 - J, 0.02, SK), 'Walnut', 'WALLS')
SOF = 0.45
box('SoffitL', (IX0 + SOF / 2, D / 2, H - 0.13), (SOF, IY1 - IY0, 0.26), 'Ceiling', 'CEIL')
box('SoffitR', (IX1 - SOF / 2, D / 2, H - 0.13), (SOF, IY1 - IY0, 0.26), 'Ceiling', 'CEIL')
box('SoffitF', (W / 2, IY0 + SOF / 2, H - 0.13), (IX1 - IX0 - 2 * SOF, SOF, 0.26), 'Ceiling', 'CEIL')
box('CoveL', (IX0 + SOF + 0.02, D / 2, H - 0.25), (0.02, IY1 - IY0 - 0.2, 0.02), 'EmitCove', 'EMIT')
box('CoveR', (IX1 - SOF - 0.02, D / 2, H - 0.25), (0.02, IY1 - IY0 - 0.2, 0.02), 'EmitCove', 'EMIT')
box('CoveF', (W / 2, IY0 + SOF + 0.02, H - 0.25), (IX1 - IX0 - 2 * SOF - 0.2, 0.02, 0.02), 'EmitCove', 'EMIT')
for nm, loc, sx, rot in (('CoveLightL', (IX0 + SOF + 0.06, D / 2, H - 0.24), IY1 - IY0 - 0.3, (0, math.radians(-120), 0)),
                         ('CoveLightR', (IX1 - SOF - 0.06, D / 2, H - 0.24), IY1 - IY0 - 0.3, (0, math.radians(120), 0))):
    lo = light(nm, 'AREA', loc, 22, (1.0, 0.55, 0.25), sx=0.04, sy=sx, rot=rot)
# Back wall: floor-to-ceiling glass (runtime panes), bronze mullions, sill, head
NM = 6
for i in range(NM + 1):
    x = IX0 + (IX1 - IX0) * i / NM
    box(f'Mull{i}', (x, D - T / 2, H / 2), (0.06, T + 0.04, H), 'Bronze', 'WALLS')
box('Sill', (W / 2, D - T / 2, 0.03), (IX1 - IX0, T + 0.06, 0.06), 'Bronze', 'WALLS')
box('Head', (W / 2, D - T / 2, H - 0.05), (IX1 - IX0, T + 0.06, 0.10), 'Bronze', 'WALLS')
box('CornerL', (0, D, H / 2), (2 * T + 0.02, 2 * T + 0.02, H), 'Bronze', 'EXT')
box('CornerR', (W, D, H / 2), (2 * T + 0.02, 2 * T + 0.02, H), 'Bronze', 'EXT')
GLASS = bpy.data.collections.new('Glass'); scene.collection.children.link(GLASS)
gm = bpy.data.materials.new('PreviewGlass'); gm.use_nodes = True; gb = gm.node_tree.nodes['Principled BSDF']
gb.inputs['Base Color'].default_value = (0.9, 0.92, 0.95, 1); gb.inputs['Roughness'].default_value = 0.02; gb.inputs['Transmission Weight'].default_value = 1.0; gb.inputs['IOR'].default_value = 1.45
_gbm = bmesh.new(); [_gbm.verts.new(p) for p in ((IX0, D - T / 2, 0.06), (IX1, D - T / 2, 0.06), (IX1, D - T / 2, H - 0.1), (IX0, D - T / 2, H - 0.1))]; _gbm.faces.new(_gbm.verts)
_gme = bpy.data.meshes.new('PreviewGlass'); _gbm.to_mesh(_gme); _gbm.free(); _gme.materials.append(gm)
_go = bpy.data.objects.new('PreviewGlass', _gme); GLASS.objects.link(_go); _go.visible_shadow = False; _go.visible_diffuse = False; _go.visible_volume_scatter = False
# Cool dusk fill through the glass (the shadows get a blue cast; warm pools read against it)
light('SkyFill', 'AREA', (W / 2, D + 0.8, 1.9), 85, (0.42, 0.52, 1.0), sx=IX1 - IX0, sy=2.8, rot=(math.radians(90), 0, 0))
light('CeilBounce', 'AREA', (W / 2, D / 2, 0.9), 48, (1.0, 0.70, 0.45), sx=W - 1.5, sy=D - 1.5, rot=(math.radians(180), 0, 0))
# Faint warm bounce from the doorway (the plaza outside is lit)
light('DoorSpill', 'AREA', (W / 2, -0.6, 1.2), 18, (1.0, 0.78, 0.55), sx=1.4, sy=2.0, rot=(math.radians(-90), 0, 0))

# ================================================================ module layouts
DESKS = []; SCREEN_Y = 1.65
STX = None
if MID == 'library':
    # Left wall: a full bookshelf run. Back-left: reading nook. Centre-right: round table + 2 chairs under a pendant.
    shelf_run('ShelfL', IX0, 0.55, 5.35, height=2.62, side='left')
    box('ShelfLTop', (IX0 + 0.18, 2.95, 2.64), (0.38, 4.84, 0.04), 'Oak', bevel=0.004)
    box('LadderRail', (IX0 + 0.48, 2.95, 2.30), (0.02, 4.7, 0.02), 'Brass')
    for k, (yl, ang) in enumerate(((1.7, 0.0),)):
        for s_ in (-1, 1): rbox(f'Ladder{k}{s_}', (IX0 + 0.62, yl + s_ * 0.22, 1.16), (0.04, 0.04, 2.36), ang, 'Oak')
        for r in range(7): box(f'Rung{k}{r}', (IX0 + 0.62, yl, 0.25 + r * 0.31), (0.03, 0.44, 0.025), 'Oak')
    # reading nook (back-left, by the glass)
    rug('RugNookRug', 1.75, 4.65, 2.3, 1.9, 'RugNook')
    nd = (0.75, -0.66)
    cc0('mid_century_lounge_chair', (1.35, 4.95, 0), face_rot(nd)); seat(1.35 + nd[0] * 0.12, 4.95 + nd[1] * 0.12, 0.46, nd, 'chair', 'nook')
    cc0('Ottoman_01', (1.35 + nd[0] * 0.95, 4.95 + nd[1] * 0.95, 0), face_rot(nd), 0.85)
    floor_lamp(0, 0.78, 5.45, energy=80)
    cc0('side_table_01', (2.25, 5.35, 0), 0.3)
    cyl('NookMug', (2.18, 5.32, 0.57), 0.04, 0.09, 'Ceramic', seg=24)
    box('NookBook', (2.32, 5.40, 0.565), (0.22, 0.16, 0.03), 'BookC', bevel=0.002, seg=1)
    rbox('Throw', (1.30, 5.05, 0.47), (0.55, 0.45, 0.03), 0.4, 'Linen', bevel=0.012, seg=2)
    # round table + 2 chairs on a rug
    RX, RY = 5.05, 3.35
    rug('RugTable', RX, RY, 2.6, 2.4, 'RugSlate')
    cyl('TableTop', (RX, RY, 0.745), 0.58, 0.04, 'Walnut', seg=64)
    cyl('TableStem', (RX, RY, 0.37), 0.05, 0.70, 'BlackMetal', seg=24)
    cyl('TableFoot', (RX, RY, 0.015), 0.30, 0.03, 'BlackMetal', seg=48)
    for i, a_deg in enumerate((200, 20)):
        a_ = math.radians(a_deg); cx_, cy_ = RX + 0.78 * math.cos(a_), RY + 0.78 * math.sin(a_)
        d = (RX - cx_, RY - cy_); n = math.hypot(*d); d = (d[0] / n, d[1] / n)
        cc0('dining_chair_02', (cx_, cy_, 0), face_rot(d) + math.radians(rnd.uniform(-6, 6))); seat(cx_ + d[0] * 0.03, cy_ + d[1] * 0.03, 0.45, d, 'chair', 'table')
    for j, (dx, dy, h, m) in enumerate(((-0.18, 0.10, 0.035, 'BookB'), (-0.16, 0.12, 0.03, 'BookD'), (-0.19, 0.09, 0.028, 'BookC'))):
        box(f'TableBook{j}', (RX + dx, RY + dy, 0.765 + 0.032 * j + h / 2), (0.24 - 0.02 * j, 0.17, h), m, bevel=0.002, seg=1)
    box('OpenBook', (RX + 0.18, RY - 0.12, 0.772), (0.34, 0.24, 0.012), 'BookD', bevel=0.003)
    cyl('TableCup', (RX + 0.25, RY + 0.22, 0.81), 0.04, 0.09, 'Ceramic', seg=24)
    cyl('TableCandle', (RX - 0.05, RY + 0.32, 0.765 + 0.08), 0.025, 0.16, 'Wax', seg=16)
    cyl('TableFlame', (RX - 0.05, RY + 0.32, 0.765 + 0.16 + 0.016), 0.007, 0.028, 'EmitCandle', 'EMIT', seg=8, r2=0.001)
    pendant(0, RX, RY, 1.78, 0.30, 95)
    # right wall: low walnut console + two canvases (the screen slot covers this wall when a live screen mounts)
    box('Console', (IX1 - 0.22, 3.0, 0.36), (0.40, 2.4, 0.70), 'Walnut', bevel=0.006)
    box('ConsoleKick', (IX1 - 0.22, 3.0, 0.02), (0.34, 2.3, 0.04), 'BlackMetal')
    for q in range(3): box(f'ConsoleSlot{q}', (IX1 - 0.425, 3.0 - 0.78 + 0.78 * q, 0.38), (0.01, 0.72, 0.56), 'DarkWood', bevel=0.003)
    table_lamp(0, IX1 - 0.22, 2.05, 0.71, energy=32)
    cc0('ceramic_vase_01', (IX1 - 0.24, 3.75, 0.71), 0.0, 0.85)
    cc0('book_encyclopedia_set_01', (IX1 - 0.25, 3.15, 0.71), math.pi / 2, 0.9)
    canvas_on_wall('CanvasA', 'right', 3.0, 1.30, 0.95, 1.75, 'CanvasB')
    # plants (potted)
    potted('money_tree', 'pachira_aquatica_01', ['pachira_aquatica_01_bark_d', 'pachira_aquatica_01_leaves_d'], (7.35, 5.35, 0), 0.6, 1.1, {'r': 0.27, 'h': 0.52, 'mat': 'PotTerracotta'})
    potted('calathea_b', 'calathea_orbifolia_01', ['calathea_orbifolia_01_b'], (7.45, 0.65, 0), 0.4, 1.7, {'r': 0.17, 'h': 0.50, 'mat': 'PotBlack', 'taper': 0.75})
    potted('calathea_c', 'calathea_orbifolia_01', ['calathea_orbifolia_01_c'], (2.85, 5.45, 0), 1.0, 1.5, {'r': 0.18, 'h': 0.42, 'mat': 'PotStone'})
    cc0('potted_plant_04', (IX1 - 0.25, 4.0, 0.71), 0.3, 1.0, baked=False)
    for (x, y) in ((2.2, 1.6), (2.2, 4.2), (5.9, 1.4), (6.3, 4.6)): downlight(x, y, 5.0, 60)
    downlight(IX1 - 0.6, 3.0, 9.0, 40)   # picture accent
elif MID == 'lounge':
    # Sofa on the left wall facing two armchairs across a coffee table, on a big rug; sideboard + lamps on the right wall.
    rug('RugLounge', 2.45, 3.45, 3.3, 3.2, 'RugPit')
    sofa('Sofa', 0.68, 3.45, (1, 0), 3, 'VelvetTeal', ['VelvetMustard', 'VelvetRust'], 'lounge')
    canvas_on_wall('CanvasSofa', 'left', 3.45, 1.55, 1.05, 1.72, 'CanvasW')
    CTX, CTY = 2.25, 3.45
    cc0('coffee_table_round_01', (CTX, CTY, 0), 0.0, 0.85)
    ctop = 0.49 * 0.85
    box('CoffeeTray', (CTX + 0.05, CTY - 0.18, ctop + 0.01), (0.32, 0.50, 0.02), 'Bronze', bevel=0.004)
    for i, (dx, dy, hh) in enumerate(((-0.02, -0.33, 0.14), (0.08, -0.20, 0.10), (-0.01, -0.07, 0.07))):
        cyl(f'Candle{i}', (CTX + 0.05 + dx, CTY + dy, ctop + 0.02 + hh / 2), 0.035, hh, 'Wax', seg=20)
        cyl(f'Flame{i}', (CTX + 0.05 + dx, CTY + dy, ctop + 0.02 + hh + 0.018), 0.008, 0.03, 'EmitCandle', 'EMIT', seg=8, r2=0.001)
        light(f'CandleLight{i}', 'POINT', (CTX + 0.05 + dx, CTY + dy, ctop + 0.02 + hh + 0.05), 2.5, (1.0, 0.50, 0.18), soft=0.02)
    for j, (h, m) in enumerate(((0.035, 'BookC'), (0.03, 'BookD'), (0.025, 'BookB'))):
        box(f'CoffeeBook{j}', (CTX - 0.15, CTY + 0.30, ctop + 0.005 + 0.033 * j + h / 2), (0.22 - 0.02 * j, 0.30 - 0.03 * j, h), m, bevel=0.002, seg=1)
    cyl('CoffeeBowl', (CTX + 0.22, CTY + 0.25, ctop + 0.04), 0.11, 0.07, 'Ceramic', seg=32, r2=0.06)
    for k, (y, ang) in enumerate(((2.75, 0.45), (4.35, -0.35))):
        d = (-math.cos(ang), math.sin(ang))
        cc0('modern_arm_chair_01', (3.6, y, 0), face_rot(d)); seat(3.75 + d[0] * 0.05, y + d[1] * 0.05, 0.53, d, 'chair', 'lounge')
    cc0('side_table_01', (3.85, 3.55, 0), 0.0)
    table_lamp(1, 3.85, 3.55, 0.55, energy=34)
    floor_lamp(0, 0.55, 1.55, energy=85)
    # sideboard on the right wall (media wall: the screen slot sits above it)
    SBX = IX1 - 0.24
    box('Sideboard', (SBX, 3.0, 0.38), (0.44, 2.6, 0.68), 'Walnut', bevel=0.006)
    box('SideboardKick', (SBX, 3.0, 0.02), (0.38, 2.5, 0.04), 'BlackMetal')
    for q in range(3): box(f'SideboardSlot{q}', (SBX - 0.225, 3.0 - 0.84 + 0.84 * q, 0.40), (0.01, 0.78, 0.56), 'DarkWood', bevel=0.003)
    table_lamp(2, SBX, 1.95, 0.72, energy=32)
    table_lamp(3, SBX, 4.05, 0.72, energy=32)
    cc0('brass_vase_01', (SBX, 2.65, 0.72), 0.0, 0.55)
    for q, m_ in enumerate(('BookB', 'BookA', 'BookC')): box(f'SideBook{q}', (SBX, 3.35, 0.72 + 0.02 + 0.04 * q), (0.26, 0.20, 0.04), m_, bevel=0.002, seg=1)
    canvas_on_wall('CanvasSide', 'right', 3.0, 1.10, 0.80, 1.85, 'CanvasE')
    # a window seat by the glass (back-right): lounge chair + side table
    nd = (-0.55, -0.83)
    cc0('mid_century_lounge_chair', (6.1, 5.0, 0), face_rot(nd)); seat(6.1 + nd[0] * 0.12, 5.0 + nd[1] * 0.12, 0.46, nd, 'chair', 'window')
    cc0('side_table_01', (5.15, 5.35, 0), 0.4)
    rug('RugWindow', 6.0, 4.85, 2.0, 1.6, 'RugCharcoal', 0.12)
    potted('money_tree', 'pachira_aquatica_01', ['pachira_aquatica_01_bark_d', 'pachira_aquatica_01_leaves_d'], (0.75, 5.3, 0), 1.2, 1.1, {'r': 0.27, 'h': 0.52, 'mat': 'PotTerracotta'})
    potted('money_tree_shrub', 'pachira_aquatica_01', ['pachira_aquatica_01_bark_c', 'pachira_aquatica_01_leaves_c'], (7.35, 5.35, 0), 0.4, 1.1, {'r': 0.30, 'h': 0.48, 'mat': 'PotStone'})
    potted('calathea_b', 'calathea_orbifolia_01', ['calathea_orbifolia_01_b'], (7.45, 0.62, 0), 2.0, 1.7, {'r': 0.17, 'h': 0.50, 'mat': 'PotBlack', 'taper': 0.75})
    potted('calathea_c', 'calathea_orbifolia_01', ['calathea_orbifolia_01_c'], (1.55, 5.45, 0), 1.0, 1.5, {'r': 0.18, 'h': 0.42, 'mat': 'PotTerracotta'})
    for (x, y) in ((2.3, 1.7), (2.3, 4.4), (5.6, 1.6), (5.6, 4.3)): downlight(x, y, 4.0, 60)
    downlight(IX0 + 0.6, 3.05, 9.0, 40)
    downlight(IX1 - 0.6, 3.0, 7.0, 40)
elif MID == 'studio':
    # Three walnut desks in a row facing the door (monitors to the room, the glass behind); shelving on the left wall,
    # a plant cluster in the back-left corner, a credenza under the right wall screen slot.
    rug('RugStudio', 4.15, 4.35, 6.2, 2.5, 'RugCharcoal')
    STX, STY = (2.35, 4.15, 5.95), 4.55
    def desk(k, cx, cy):
        top = 0.75; w, d = 1.45, 0.72
        box(f'DeskTop{k}', (cx, cy, top - 0.015), (w, d, 0.03), 'Walnut', bevel=0.004)
        for sx in (-1, 1):
            x = cx + sx * (w / 2 - 0.06)
            for sy in (-1, 1): box(f'DeskPost{k}{sx}{sy}', (x, cy + sy * (d / 2 - 0.05), (top - 0.03) / 2), (0.025, 0.025, top - 0.03), 'BlackMetal')
            box(f'DeskSled{k}{sx}', (x, cy, 0.0125), (0.025, d - 0.06, 0.025), 'BlackMetal')
            box(f'DeskRail{k}{sx}', (x, cy, top - 0.045), (0.025, d - 0.06, 0.025), 'BlackMetal')
        box(f'DeskBeam{k}', (cx, cy + d / 2 - 0.08, top - 0.06), (w - 0.14, 0.03, 0.05), 'BlackMetal')
        # monitor faces the door (-y); the screen is painted 'off' at runtime and the live terminal mounts over it
        mx, my, mz = cx, cy + 0.12, top + 0.42
        box(f'MonBezel{k}', (mx, my, mz), (0.72, 0.03, 0.43), 'Plastic', bevel=0.006)
        so = quad(f'Screen{k}', [(mx - 0.345, my - 0.016, mz - 0.2), (mx + 0.345, my - 0.016, mz - 0.2), (mx + 0.345, my - 0.016, mz + 0.2), (mx - 0.345, my - 0.016, mz + 0.2)], f'EmitScreen{k}', 'EMIT')
        uv_fit(so, mx - 0.345, mx + 0.345, mz - 0.2, mz + 0.2, axes=(0, 2))
        # cables, papers, a book stack: a lived-in desk
        box(f'Paper{k}', (cx + 0.12, cy - 0.02, top + 0.002), (0.21, 0.297, 0.002), 'Wax'); 
        for q in range(2): box(f'DeskBook{k}{q}', (cx + 0.58, cy + 0.2, top + 0.015 + 0.03 * q), (0.17, 0.24, 0.028), ['BookB', 'BookD', 'BookC', 'BookE'][(k + q) % 4], bevel=0.002, seg=1)
        box(f'Cable{k}', (mx + 0.02, my + 0.06, top / 2 + 0.1), (0.008, 0.008, top + 0.2), 'Plastic')
        box(f'MonNeck{k}', (mx, my + 0.05, top + 0.15), (0.05, 0.03, 0.3), 'BlackMetal')
        box(f'MonBase{k}', (mx, my + 0.02, top + 0.006), (0.25, 0.18, 0.012), 'BlackMetal', bevel=0.003)
        box(f'Keyb{k}', (cx - 0.05, cy - 0.17, top + 0.01), (0.44, 0.14, 0.02), 'Plastic', bevel=0.004)
        box(f'Mouse{k}', (cx + 0.28, cy - 0.17, top + 0.012), (0.06, 0.1, 0.025), 'Plastic', bevel=0.01)
        cyl(f'Mug{k}', (cx - 0.52, cy - 0.12, top + 0.05), 0.04, 0.1, 'Ceramic', seg=24)
        box(f'Notebook{k}', (cx + 0.5, cy - 0.04, top + 0.008), (0.21, 0.29, 0.016), ['BookA', 'BookB', 'BookC'][k], bevel=0.002)
        cc0('desk_lamp_arm_01', (cx - 0.60, cy + 0.2, top), math.radians(200))
        cc0('dining_chair_02', (cx + 0.03, cy - 0.70, 0), math.radians((k - 1) * 5))
        seat(cx + 0.03, cy - 0.70, 0.45, (0, 1), 'desk', 'studio')
        DESKS.append({'x': cx, 'y': cy, 'screen': {'x': mx, 'y': my - 0.017, 'z': mz}})
    for k, cx in enumerate(STX): desk(k, cx, STY)
    # linear pendant over the desks + oak slat ceiling
    box('PendantBar', (4.15, STY - 0.25, 2.48), (5.0, 0.07, 0.045), 'BlackMetal')
    box('PendantDiffuser', (4.15, STY - 0.25, 2.456), (4.9, 0.045, 0.005), 'EmitStrip', 'EMIT')
    for x in (1.9, 6.4): box(f'PendantWire{x}', (x, STY - 0.25, (H + 2.5) / 2), (0.008, 0.008, H - 2.5), 'BlackMetal')
    light('PendantLight', 'AREA', (4.15, STY - 0.25, 2.44), 34, (1.0, 0.60, 0.30), sx=4.9, sy=0.05)
    x = 1.55
    while x < 6.8:
        box(f'CeilSlat{x:.2f}', (x, 4.45, H - 0.045), (0.045, 2.3, 0.07), 'Oak', 'CEIL'); x += 0.11
    box('CeilSlatBack', (4.15, 4.45, H - 0.005), (5.3, 2.3, 0.01), 'StoneDark', 'CEIL')
    # left wall: open shelving (books, binders, objects)
    shelf_run('ShelfL', IX0, 0.75, 3.55, height=2.3, side='left', fill=0.66)
    cc0('potted_plant_04', (IX0 + 0.2, 1.4, 2.32), 0.3, 1.0, baked=False)
    # right wall: low credenza (the screen slot hangs above it) + a pinned whiteboard to the side
    box('Credenza', (IX1 - 0.24, 3.0, 0.31), (0.44, 2.8, 0.56), 'Oak', bevel=0.006)
    box('CredenzaTop', (IX1 - 0.24, 3.0, 0.60), (0.46, 2.84, 0.03), 'Walnut', bevel=0.004)
    box('CredenzaKick', (IX1 - 0.24, 3.0, 0.02), (0.38, 2.7, 0.04), 'BlackMetal')
    cc0('ceramic_vase_01', (IX1 - 0.24, 1.9, 0.615), 0.0, 0.8)
    cc0('book_encyclopedia_set_01', (IX1 - 0.25, 3.6, 0.615), math.pi / 2, 0.9)
    table_lamp(0, IX1 - 0.24, 4.15, 0.615, energy=30)
    canvas_on_wall('CanvasStudio', 'right', 3.0, 1.2, 0.85, 1.70, 'CanvasB')
    # plant cluster (back-left corner, odd number, varied heights) + one by the front-right
    potted('money_tree', 'pachira_aquatica_01', ['pachira_aquatica_01_bark_d', 'pachira_aquatica_01_leaves_d'], (0.72, 5.3, 0), 0.6, 1.15, {'r': 0.27, 'h': 0.52, 'mat': 'PotTerracotta'})
    potted('calathea_b', 'calathea_orbifolia_01', ['calathea_orbifolia_01_b'], (0.62, 4.45, 0), 0.4, 1.6, {'r': 0.17, 'h': 0.50, 'mat': 'PotBlack', 'taper': 0.75})
    potted('calathea_c', 'calathea_orbifolia_01', ['calathea_orbifolia_01_c'], (1.45, 5.5, 0), 1.0, 1.4, {'r': 0.18, 'h': 0.40, 'mat': 'PotStone'})
    potted('money_tree_shrub', 'pachira_aquatica_01', ['pachira_aquatica_01_bark_c', 'pachira_aquatica_01_leaves_c'], (7.4, 5.35, 0), 0.4, 1.05, {'r': 0.30, 'h': 0.48, 'mat': 'PotStone'})
    potted('calathea_b', 'calathea_orbifolia_01', ['calathea_orbifolia_01_b'], (7.45, 0.62, 0), 2.0, 1.6, {'r': 0.17, 'h': 0.50, 'mat': 'PotBlack', 'taper': 0.75})
    # a lounge chair + floor lamp by the shelves (a reading spot)
    nd = (0.8, 0.6)
    cc0('modern_arm_chair_01', (1.15, 1.25, 0), face_rot(nd)); seat(1.15 + nd[0] * 0.05, 1.25 + nd[1] * 0.05, 0.53, nd, 'chair', 'studio')
    floor_lamp(0, 0.6, 2.1, energy=60)
    for (x, y) in ((2.4, 1.8), (5.9, 1.8)): downlight(x, y, 4.0, 60)
    downlight(IX1 - 0.6, 3.0, 7.0, 40)

# ================================================================ desk-lamp emitters (CC0 desk lamps, build.py)
for m in bpy.data.materials:
    if m.name.startswith('desk_lamp_arm_01_light') and m.node_tree:
        b = m.node_tree.nodes.get('Principled BSDF')
        if b: b.inputs['Emission Color'].default_value = (1.0, 0.56, 0.26, 1); b.inputs['Emission Strength'].default_value = 8.0
k = 0
for o in list(ROOM.objects):
    if o.type != 'MESH' or not o.material_slots: continue
    idx = [i for i, sl in enumerate(o.material_slots) if sl.material and sl.material.name.startswith('desk_lamp_arm_01_light')]
    if not idx: continue
    pts = [o.matrix_world @ o.data.vertices[v].co for p in o.data.polygons if p.material_index in idx for v in p.vertices]
    if not pts: continue
    c = sum(pts, Vector()) / len(pts)
    light(f'DeskLamp{k}', 'SPOT', (c.x, c.y, c.z - 0.10), 30, (1.0, 0.46, 0.15), soft=0.02, cone=90, blend=0.75); k += 1

# ================================================================ world: the penthouse city panorama (blue hour) through the glass
wd = bpy.data.worlds.new('City'); scene.world = wd; wd.use_nodes = True; nt = wd.node_tree; nt.nodes.clear()
tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Rotation'].default_value = (0, 0, math.radians(float(os.environ.get('CITY_ROT', '200'))))
et = nt.nodes.new('ShaderNodeTexEnvironment'); et.image = bpy.data.images.load(os.path.join(A, 'city.exr')); et.image.colorspace_settings.name = 'Linear Rec.709'
bg = nt.nodes.new('ShaderNodeBackground'); bg.inputs['Strength'].default_value = float(os.environ.get('CITY_GAIN', '1.0'))
out = nt.nodes.new('ShaderNodeOutputWorld')
nt.links.new(tc.outputs['Generated'], mp.inputs['Vector']); nt.links.new(mp.outputs[0], et.inputs[0]); nt.links.new(et.outputs[0], bg.inputs[0]); nt.links.new(bg.outputs[0], out.inputs[0])

# ================================================================ anchors (markers) + module.json (room-local three.js frame)
def L(x, y, z=0.0): return {'x': round(x - W / 2, 3), 'y': round(z, 3), 'z': round(D / 2 - y, 3)}
def yaw(d): return round(math.atan2(d[0], -d[1]), 4)   # three rotation.y for a facing direction d (Blender xy)
anchors = {'door': {'side': 'front', 'x': 0.0, 'width': DOOR_W, 'height': DOOR_H},
           'sign': {**L(W / 2, -T - 0.035, 2.86), 'rotY': 0.0, 'width': 3.0, 'height': 0.62},
           'boards': [], 'screens': [], 'desks': [], 'seats': []}
for bx in (0.95, 2.35, 5.65, 7.05):
    anchors['boards'].append({**L(bx, IY0 + 0.03, 1.55), 'rotY': math.pi, 'width': 1.2, 'height': 0.85})
anchors['screens'].append({**L(IX1 - 0.03, 3.0, SCREEN_Y), 'rotY': round(-math.pi / 2, 4), 'width': 3.6, 'height': 2.0, 'wall': 'right'})
for i, dk in enumerate(DESKS):
    s = dk['screen']
    anchors['desks'].append({**L(dk['x'], dk['y']), 'rotY': 0.0, 'monitor': {'y': round(s['z'], 3), 'z': round(-(s['y'] - dk['y']), 3), 'width': 0.69, 'height': 0.40}})
for i, (x, y, z, d, kind, zone) in enumerate(SEATS):
    anchors['seats'].append({**L(x, y, z), 'rotY': yaw(d), 'kind': kind, 'zone': zone})
    empty(f'seat_{i + 1}', (x, y, z), face_rot(d), {'kind': kind, 'zone': zone, 'seat_h': round(z, 3)})
empty('sign_anchor', (W / 2, -T - 0.035, 2.86), 0.0)
empty('screen_anchor', (IX1 - 0.03, 3.0, SCREEN_Y), face_rot((-1, 0)))
for i, b in enumerate(anchors['boards']): empty(f'board_anchor_{i + 1}', (b['x'] + W / 2, D / 2 - b['z'], b['y']), math.pi)

# collision blocks (room-local rectangles) from the furniture footprint on the floor (everything FURN taller than 0.3 m)
BLOCKS = {
    'library': [(IX0 + 0.2, 2.95, 0.22, 2.42), (5.05, 3.35, 0.95, 0.95), (1.6, 4.8, 0.75, 0.7), (IX1 - 0.22, 3.0, 0.22, 1.2), (7.35, 5.35, 0.3, 0.3), (7.45, 0.65, 0.2, 0.2)],
    'lounge': [(0.68, 3.45, 0.5, 1.6), (2.25, 3.45, 0.56, 0.56), (3.6, 2.75, 0.45, 0.45), (3.6, 4.35, 0.45, 0.45), (IX1 - 0.24, 3.0, 0.22, 1.3), (6.0, 5.0, 0.6, 0.55), (0.75, 5.3, 0.35, 0.35), (7.35, 5.35, 0.32, 0.32)],
    'studio': [(4.15, 4.55, 2.6, 0.42), (IX0 + 0.2, 2.15, 0.22, 1.42), (IX1 - 0.24, 3.0, 0.22, 1.42), (0.9, 5.0, 0.55, 0.6), (1.15, 1.25, 0.45, 0.45), (7.4, 5.35, 0.32, 0.32)],
}[MID]
blocks = [{**{k: v for k, v in L(x, y).items() if k != 'y'}, 'hx': hx, 'hz': hz} for (x, y, hx, hz) in BLOCKS]
LABEL = {'library': 'Library', 'lounge': 'Lounge', 'studio': 'Studio'}[MID]
WORDS = {'library': ['library', 'book', 'books', 'reading', 'lighthouse', 'novel', 'writing', 'stories', 'poetry', 'archive'],
         'lounge': ['lounge', 'chats', 'chat', 'living', 'sofa', 'social', 'friends', 'cafe', 'messages', 'other'],
         'studio': ['studio', 'desk', 'desks', 'office', 'work', 'code', 'build']}[MID]
module = {'id': MID, 'label': LABEL, 'version': 1, 'footprint': {'width': W, 'depth': D, 'ceiling': H},
          'frame': 'room-local metres, three.js axes: x right, y up, z toward the door (front wall at z = +depth/2); rotY = three rotation.y; GLB origin = room front-left corner -> offset (-width/2, +depth/2)',
          'offset': {'x': -W / 2, 'z': D / 2}, 'glass': ['back'], 'words': WORDS, 'anchors': anchors, 'blocks': blocks}
json.dump(module, open(os.path.join(OUT, 'module.json'), 'w'), indent=1)
json.dump(REALTIME, open(os.path.join(OUT, 'props.json'), 'w'), indent=1)
json.dump([], open(os.path.join(OUT, 'lamps.json'), 'w'))

scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'; scene.view_settings.look = 'None'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'scene.blend'))
print('BUILD OK', MID, 'objects', len(OBJS), 'seats', len(SEATS), 'props', len(REALTIME), 'desks', len(DESKS))

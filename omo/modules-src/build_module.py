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
import numpy as np
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

# r2 floor: the penthouse herringbone at saturation x0.6 and a smaller repeat (boards ~7 x 40 cm, like the penthouse parquet)
principled('Parquet', diff='parquet_desat_2k.jpg', roughmap='herringbone_parquet_rough_2k.jpg', normal='herringbone_parquet_nor_gl_2k.jpg', tile=1.5)
def _remap_rough(m, lo, hi):
    nt = m.node_tree; b = nt.nodes['Principled BSDF']; src = b.inputs['Roughness'].links[0].from_socket
    mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = lo; mr.inputs['To Max'].default_value = hi
    nt.links.new(src, mr.inputs['Value']); nt.links.new(mr.outputs['Result'], b.inputs['Roughness'])
_remap_rough(MATS['Parquet'], 0.55, 0.85)
# r2: ONE wood per room = dark walnut veneer (desks, tables, shelves, skirting, slats, frames); everything else black metal / stone
principled('Walnut', diff='walnut_dark_1k.jpg', roughmap='walnut_veneer_rough_1k.jpg', tile=1.2)
_remap_rough(MATS['Walnut'], 0.38, 0.6)
MATS['DarkWood'] = MATS['Walnut']; TILE['DarkWood'] = TILE['Walnut']
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
MATS['Oak'] = MATS['Walnut']; TILE['Oak'] = TILE['Walnut']
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
# r2: a curated, low-saturation book palette (cloth/leather spines)
BOOKS = []
for k, c in zip('ABCDEFGH', ((0.62, 0.56, 0.46), (0.07, 0.10, 0.16), (0.30, 0.08, 0.05), (0.70, 0.66, 0.58), (0.10, 0.16, 0.12),
                              (0.05, 0.05, 0.05), (0.46, 0.30, 0.12), (0.34, 0.30, 0.26))):
    principled('Book' + k, color=c, rough=0.8); BOOKS.append('Book' + k)
BOOK_W = [3, 2, 2, 3, 1, 1, 1, 2]
# r2: ONE planter for every plant: matte warm-grey stone
principled('PotStone', color=(0.46, 0.44, 0.41), rough=0.8)
MATS['PotTerracotta'] = MATS['PotBlack'] = MATS['PotStone']
def POT(r, h): return {'r': r, 'h': h, 'mat': 'PotStone', 'taper': 0.82}
principled('Soil', color=(0.05, 0.035, 0.025), rough=1.0)
principled('EmitDown', emit=(1.0, 0.62, 0.34), emit_strength=6.0)
principled('EmitShade', emit=(1.0, 0.62, 0.36), emit_strength=2.2)
principled('EmitStrip', emit=(1.0, 0.74, 0.50), emit_strength=7.0)
principled('EmitCove', emit=(1.0, 0.62, 0.34), emit_strength=2.0)
principled('EmitShelf', emit=(1.0, 0.66, 0.40), emit_strength=3.0)
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
principled('FabricCharcoal', diff=_fabric(GEN, 'gen_fabric_charcoal', (0.075, 0.075, 0.08), 41, weave=0.12, mott=0.1), rough=0.95, tile=0.5)
principled('Linen', diff=_fabric(GEN, 'gen_linen_rust', (0.50, 0.20, 0.09), 38, weave=0.18, mott=0.15), rough=1.0, tile=0.5)
G = lambda n: os.path.join(GEN, n)
principled('Sheer', color=(0.88, 0.86, 0.82), rough=0.95)
_sb = MATS['Sheer'].node_tree.nodes['Principled BSDF']; _sb.inputs['Alpha'].default_value = 0.5
MATS['Sheer'].surface_render_method = 'BLENDED'; MATS['Sheer'].use_backface_culling = False
principled('RugPit', diff=G(rug_texture(GEN, 'gen_rug_pit', (0.58, 0.51, 0.42), (0.50, 0.43, 0.35), (0.62, 0.55, 0.46), 36, bw=0.05)), rough=1.0)   # r5f: tone-on-tone border
principled('RugNook', diff=G(rug_texture(GEN, 'gen_rug_nook', (0.36, 0.30, 0.26), (0.30, 0.25, 0.21), (0.40, 0.34, 0.29), 37, bw=0.06)), rough=1.0)
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
RETEX = {'side_table_01': {'side_table_01': 'side_table_01_walnut.jpg'}, 'modern_arm_chair_01': {'modern_arm_chair_01_legs': 'arm_chair_legs_walnut.jpg', 'modern_arm_chair_01_pillow': 'gen_linen_rust.png'},
         'mid_century_lounge_chair': {'mid_century_lounge_chair': 'lounge_chair_walnut.jpg'}, 'desk_lamp_arm_01': {'desk_lamp_arm_01': 'desk_lamp_black.jpg'}}
def _retex(new, aid):
    for o in new:
        for sl in getattr(o, 'material_slots', []):
            m = sl.material; f = RETEX.get(aid, {}).get(m.name if m else None)
            if not f or not m.node_tree: continue
            b = m.node_tree.nodes.get('Principled BSDF'); ln = b.inputs['Base Color'].links if b else []
            if ln and ln[0].from_node.type == 'TEX_IMAGE': ln[0].from_node.image = img(os.path.join(GEN, f))
def cc0(aid, loc, rotz=0.0, scale=1.0, baked=True):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(CC0, aid, aid + '.gltf'))
    new = [o for o in bpy.data.objects if o not in before]; _retex(new, aid)
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

WARM = (1.0, 0.58, 0.30)
# r2 lamps: every lamp is a real source. A point light sits INSIDE an open, opaque glowing shade, so the light leaves
# through the top and bottom openings and pools on the table / floor below and the wall / ceiling above.
def table_lamp(k, x, y, z, energy=28):
    cyl(f'TLampBase{k}', (x, y, z + 0.13), 0.065, 0.26, 'Ceramic', seg=32, r2=0.045)
    cyl(f'TLampNeck{k}', (x, y, z + 0.30), 0.008, 0.10, 'Brass', seg=12)
    cyl(f'TLampShade{k}', (x, y, z + 0.42), 0.17, 0.24, 'EmitShade', 'EMIT', seg=48, r2=0.14, caps=False)
    light(f'TableLamp{k}', 'POINT', (x, y, z + 0.41), energy, WARM, soft=0.05)

def floor_lamp(k, x, y, h=1.55, energy=55):
    cyl(f'LampBase{k}', (x, y, 0.015), 0.16, 0.03, 'StoneDark', seg=48)
    cyl(f'LampPole{k}', (x, y, h / 2), 0.011, h, 'BlackMetal', seg=12)
    cyl(f'LampShade{k}', (x, y, h + 0.06), 0.22, 0.34, 'EmitShade', 'EMIT', seg=48, r2=0.19, caps=False)
    light(f'FloorLamp{k}', 'POINT', (x, y, h + 0.05), energy, WARM, soft=0.06)

def downlight(x, y, power=6.0, cone=70):
    cyl(f'DLtrim_{x:.2f}_{y:.2f}', (x, y, H - 0.004), 0.045, 0.008, 'EmitDown', 'EMIT', seg=24)
    light(f'DL_{x:.2f}_{y:.2f}', 'SPOT', (x, y, H - 0.01), power, (1.0, 0.62, 0.36), soft=0.03, cone=cone, blend=0.7)

def pendant(k, x, y, z=1.65, r=0.24, energy=45):
    """A drum pendant hung by a cord right over what it lights; the light is inside the open-bottom shade."""
    cyl(f'Pend{k}', (x, y, z), r, 0.24, 'EmitShade', 'EMIT', seg=48, r2=r * 0.96, caps=False)
    cyl(f'PendTop{k}', (x, y, z + 0.118), r * 0.96, 0.006, 'BlackMetal', seg=48)
    cyl(f'PendDiff{k}', (x, y, z - 0.08), r * 0.85, 0.004, 'EmitDown', 'EMIT', seg=48)
    cyl(f'PendCord{k}', (x, y, (H + z + 0.12) / 2), 0.0025, H - z - 0.12, 'Bronze', seg=8)   # r5d: hair-thin bronze, not a black line on the glass
    cyl(f'PendCanopy{k}', (x, y, H - 0.015), 0.06, 0.03, 'BlackMetal', seg=24)
    light(f'PendLight{k}', 'POINT', (x, y, z + 0.02), energy, WARM, soft=0.08)

def linear_pendant(k, x, y, length, z, along='y', energy=60):
    sx, sy = (0.06, length) if along == 'y' else (length, 0.06)
    box(f'LinBar{k}', (x, y, z), (sx, sy, 0.05), 'BlackMetal')
    box(f'LinDiff{k}', (x, y, z - 0.026), (sx * 0.7 if along == 'y' else length - 0.04, sy - 0.04 if along == 'y' else 0.04, 0.003), 'EmitStrip', 'EMIT')
    for s_ in (-1, 1):
        px, py = (x, y + s_ * (length / 2 - 0.15)) if along == 'y' else (x + s_ * (length / 2 - 0.15), y)
        cyl(f'LinCord{k}{s_}', (px, py, (H + z) / 2), 0.003, H - z, 'BlackMetal', seg=8)
    light(f'LinLight{k}', 'AREA', (x, y, z - 0.03), energy, (1.0, 0.66, 0.40), sx=sx * 0.7 if along == 'y' else length - 0.04, sy=sy - 0.04 if along == 'y' else 0.04)

def canvas_on_wall(name, wall, c, w, h, z, mat, frame='Walnut'):
    """ONE framed canvas on a bare side wall ('left' x=IX0 / 'right' x=IX1) centred at y=c, with a picture light."""
    if wall == 'left':
        ob = box(name, (IX0 + 0.035, c, z), (0.04, w, h), mat, bevel=0.004, seg=1); uv_fit(ob, c + w / 2, c - w / 2, z - h / 2, z + h / 2, axes=(1, 2))
        box(name + 'Frame', (IX0 + 0.02, c, z), (0.04, w + 0.06, h + 0.06), frame); xl, dl = IX0 + 0.9, 1
    else:
        ob = box(name, (IX1 - 0.035, c, z), (0.04, w, h), mat, bevel=0.004, seg=1); uv_fit(ob, c - w / 2, c + w / 2, z - h / 2, z + h / 2, axes=(1, 2))
        box(name + 'Frame', (IX1 - 0.02, c, z), (0.04, w + 0.06, h + 0.06), frame); xl, dl = IX1 - 0.9, -1
    # a ceiling spot aimed at the canvas (gallery wash)
    cyl(f'{name}SpotTrim', (xl, c, H - 0.004), 0.045, 0.008, 'EmitDown', 'EMIT', seg=24)
    light(f'{name}Spot', 'SPOT', (xl, c, H - 0.02), 14, (1.0, 0.70, 0.45), soft=0.03, cone=38, blend=0.8,
          rot=(0, math.radians(dl * 30), 0))

def lean_box(name, c, s, zang, lean, mat, bevel=0.002):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * s[0], v.co.y * s[1], v.co.z * s[2] + s[2] / 2))
    if bevel > 0: bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, profile=0.5, affect='EDGES')
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(zang, 3, 'Z') @ Matrix.Rotation(lean, 3, 'X'))
    for v in bm.verts: v.co += Vector(c)
    bm.normal_update(); return finish(bm, name, mat, 'FURN')

def book_mat():
    return rnd.choices(BOOKS, weights=BOOK_W)[0]

def shelf_dress(name, xwall, depth, y0, y1, z, room, sx=1, density=0.8, objects=True):
    """Dress ONE shelf (side wall at x=xwall, books facing the room along +sx): runs of upright books of mixed height,
    a lying stack, a leaning book at a run's end, and the odd object (bowl, vase, bookend). room = clear height."""
    y = y0 + rnd.uniform(0.0, 0.06); kind_prev = None
    while y < y1 - 0.06:
        r_ = rnd.random()
        if r_ < density or kind_prev != 'run':
            if r_ < density * 0.82 or not objects:   # upright run
                n = rnd.randint(5, 16); hbase = rnd.uniform(0.19, min(0.31, room - 0.05)); start = y
                for i in range(n):
                    t = rnd.uniform(0.018, 0.05); hh = min(room - 0.03, hbase * rnd.uniform(0.86, 1.08)); dd = rnd.uniform(0.15, min(0.24, depth - 0.03))
                    if y + t > y1 - 0.01: break
                    bx = xwall + sx * (depth - dd / 2 - 0.015)
                    box(f'{name}B{y:.3f}', (bx, y + t / 2, z + hh / 2), (dd, t, hh), book_mat(), bevel=0.0015, seg=1); y += t + 0.0015
                if rnd.random() < 0.35 and y < y1 - 0.12:   # a leaning book closes the run
                    t = 0.03; hh = min(room - 0.05, hbase); dd = 0.18; lean = -math.radians(rnd.uniform(12, 20))
                    lean_box(f'{name}Lean{y:.3f}', (xwall + sx * (depth - dd / 2 - 0.015), y + 0.01, z), (dd, t, hh), 0.0, lean, book_mat()); y += hh * 0.30 + 0.04
                if rnd.random() < 0.25 and y - start > 0.25 and y < y1 - 0.06:
                    box(f'{name}End{y:.3f}', (xwall + sx * (depth - 0.08), y + 0.008, z + 0.08), (0.10, 0.016, 0.16), 'BlackMetal'); y += 0.02
                kind_prev = 'run'
            else:
                kind = rnd.choice(['stack', 'stack', 'vase', 'bowl', 'stone'])
                cxo = xwall + sx * (depth / 2 + 0.01)
                if kind == 'stack' and y < y1 - 0.30:
                    zz = z
                    for q in range(rnd.randint(2, 5)):
                        hh = rnd.uniform(0.028, 0.05); box(f'{name}St{y:.3f}{q}', (cxo, y + 0.14, zz + hh / 2), (min(depth - 0.04, 0.22), 0.26 - 0.015 * q, hh), book_mat(), bevel=0.0015, seg=1); zz += hh
                    if rnd.random() < 0.5: cyl(f'{name}StObj{y:.3f}', (cxo, y + 0.14, zz + 0.05), 0.04, 0.10, rnd.choice(['Ceramic', 'Brass', 'StoneDark']), seg=24, r2=0.03)
                    y += 0.32
                elif kind == 'vase' and room > 0.26 and y < y1 - 0.18:
                    hh = min(room - 0.04, rnd.uniform(0.16, 0.26)); cyl(f'{name}Vase{y:.3f}', (cxo, y + 0.08, z + hh / 2), rnd.uniform(0.045, 0.065), hh, rnd.choice(['Ceramic', 'StoneDark', 'Ceramic']), seg=28, r2=0.035); y += 0.22
                elif kind == 'bowl' and y < y1 - 0.24:
                    cyl(f'{name}Bowl{y:.3f}', (cxo, y + 0.11, z + 0.035), 0.10, 0.07, rnd.choice(['Ceramic', 'StoneDark']), seg=32, r2=0.06); y += 0.26
                elif y < y1 - 0.16:
                    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=0.06)
                    for v in bm.verts: v.co = Vector((v.co.x + cxo, v.co.y + y + 0.07, v.co.z * 0.7 + z + 0.042))
                    bm.normal_update(); finish(bm, f'{name}Stone{y:.3f}', 'StoneDark', 'FURN'); y += 0.18
                else: y += 0.1
                kind_prev = 'obj'
        else:
            y += rnd.uniform(0.08, 0.25); kind_prev = 'gap'

def round_rug_tex(name, base, ring, seed, n=1024):
    rs = np.random.default_rng(seed); yy, xx = np.mgrid[0:n, 0:n] / n
    rr = np.hypot(xx - 0.5, yy - 0.5) * 2
    fib = _blur(rs.random((n, n)), 1, n=1) - 0.5; mot = _blur(rs.random((n, n)), 24) - 0.5
    col = np.where(((rr > 0.86) & (rr < 0.92))[..., None], np.array(ring), np.array(base))
    col = col * (1 + fib[..., None] * 0.3 + mot[..., None] * 0.4)
    return os.path.join(GEN, _save(GEN, name, col))

def rug_round(name, cx, cy, r, mat):
    _pile(MATS[mat]); ob = cyl(name, (cx, cy, 0.007), r, 0.014, mat, seg=96)
    uv_fit(ob, cx - r, cx + r, cy - r, cy + r); return ob

def task_chair(k, x, y, d, seat_mat='FabricCharcoal'):
    """A modern task chair: 5-star base on casters, gas column, upholstered seat + mesh-like back, arm pads. d = facing."""
    F = Frame(x, y, d); a = F.ang
    for i in range(5):
        aa = a + i * 2 * math.pi / 5 + math.pi / 2
        rbox(f'TC{k}Leg{i}', (x + 0.15 * math.cos(aa), y + 0.15 * math.sin(aa), 0.07), (0.30, 0.035, 0.03), aa, 'BlackMetal', bevel=0.008)
        cyl(f'TC{k}Cast{i}', (x + 0.29 * math.cos(aa), y + 0.29 * math.sin(aa), 0.025), 0.025, 0.04, 'Plastic', seg=12)
    cyl(f'TC{k}Hub', (x, y, 0.08), 0.05, 0.05, 'BlackMetal', seg=24)
    cyl(f'TC{k}Col', (x, y, 0.25), 0.024, 0.32, 'Brass' if False else 'BlackMetal', seg=16)
    rbox(f'TC{k}Mech', F.p(0, 0, 0.42), (0.22, 0.22, 0.04), a, 'BlackMetal')
    rbox(f'TC{k}Seat', F.p(0, 0.03, 0.47), (0.50, 0.48, 0.075), a, seat_mat, bevel=0.03, seg=3)
    rbox(f'TC{k}Spine', F.p(0, -0.25, 0.58), (0.06, 0.03, 0.26), a, 'BlackMetal')
    rbox(f'TC{k}Back', F.p(0, -0.27, 0.86), (0.46, 0.045, 0.46), a, seat_mat, bevel=0.02, seg=3)
    for s_ in (-1, 1):
        rbox(f'TC{k}ArmP{s_}', F.p(s_ * 0.27, -0.04, 0.56), (0.025, 0.04, 0.18), a, 'BlackMetal')
        rbox(f'TC{k}ArmPad{s_}', F.p(s_ * 0.27, -0.02, 0.655), (0.06, 0.25, 0.025), a, 'Plastic', bevel=0.008)

def sheer_curtain(name, x0, x1, y, z0, z1, folds=9):
    """A pleated sheer panel (thin wavy sheet) hanging from the ceiling track at the glass edge."""
    n = folds * 8; bm = bmesh.new(); vs = []
    for i in range(n + 1):
        u = i / n; x = x0 + (x1 - x0) * u; dy = 0.035 * math.sin(u * folds * 2 * math.pi)
        vs.append((bm.verts.new((x, y + dy, z0)), bm.verts.new((x, y + dy, z1))))
    for i in range(n): bm.faces.new((vs[i][0], vs[i + 1][0], vs[i + 1][1], vs[i][1]))
    bm.normal_update(); ob = finish(bm, name, 'Sheer', 'SHEER')
    for p in ob.data.polygons: p.use_smooth = True
    return ob

SEATS = []
def seat(x, y, z, d, kind, zone): SEATS.append((x, y, z, d, kind, zone))

class Frame:
    def __init__(self, cx, cy, d):
        self.c = Vector((cx, cy)); n = math.hypot(*d); self.d = (d[0] / n, d[1] / n); self.ang = math.atan2(-self.d[0], self.d[1])
    def p(self, lx, ly, z=0.0):
        ca, sa = math.cos(self.ang), math.sin(self.ang)
        return (self.c.x + lx * ca - ly * sa, self.c.y + lx * sa + ly * ca, z)

def sofa(name, cx, cy, d, seats, mat, pillow_mats, zone, seat_w=0.9, depth=1.0, throw=True, plinth='DarkWood'):
    F = Frame(cx, cy, d); arm = 0.22; Wd = seats * seat_w + 2 * arm; Dd = depth; a = F.ang
    rbox(name + 'Plinth', F.p(0, 0, 0.04), (Wd - 0.12, Dd - 0.12, 0.08), a, plinth)
    if throw: rbox(name + 'Throw', F.p(Wd / 2 - arm / 2, 0.05, 0.605), (arm + 0.06, Dd * 0.7, 0.03), a, 'Boucle', bevel=0.012, seg=2)
    if throw: rbox(name + 'ThrowFall', F.p(Wd / 2 + 0.02, 0.05, 0.36), (0.03, Dd * 0.7, 0.48), a, 'Boucle', bevel=0.012, seg=2)
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
# r2 cove: a dropped perimeter band (slab H-0.26..H-0.12) with an open LED slot at its inner edge (0.14 deep, 0.12 tall);
# a lip hides the strip from below, the strip is a real AREA light aimed inward + up, washing the central ceiling.
COVE_E = float(os.environ.get('COVE_E', {'library': '7', 'lounge': '6.5', 'studio': '4.5'}[MID]))   # r5: tamer coves
SL = 0.14
SYE = IY1 - 0.42                 # side soffits stop short of the glass: the sheer track runs full width there
SYC, SYL = (IY0 + SYE) / 2, SYE - IY0
box('SoffitL', (IX0 + SOF / 2, SYC, H - 0.19), (SOF, SYL, 0.14), 'Ceiling', 'CEIL')
box('SoffitLUp', (IX0 + (SOF - SL) / 2, SYC, H - 0.06), (SOF - SL, SYL, 0.12), 'Ceiling', 'CEIL')
box('SoffitR', (IX1 - SOF / 2, SYC, H - 0.19), (SOF, SYL, 0.14), 'Ceiling', 'CEIL')
box('SoffitRUp', (IX1 - (SOF - SL) / 2, SYC, H - 0.06), (SOF - SL, SYL, 0.12), 'Ceiling', 'CEIL')
box('SoffitF', (W / 2, IY0 + SOF / 2, H - 0.19), (IX1 - IX0 - 2 * SOF, SOF, 0.14), 'Ceiling', 'CEIL')
box('SoffitFUp', (W / 2, IY0 + (SOF - SL) / 2, H - 0.06), (IX1 - IX0 - 2 * (SOF - SL), SOF - SL, 0.12), 'Ceiling', 'CEIL')
LY = SYL - 0.1; LX = IX1 - IX0 - 2 * SOF - 0.1
for nm, lip_c, lip_s, led_c, led_s, rot, lsx, lsy in (
        ('L', (IX0 + SOF - 0.01, SYC, H - 0.10), (0.02, SYL, 0.04), (IX0 + SOF - 0.09, SYC, H - 0.115), (0.012, LY, 0.006), (0, math.radians(-135), 0), 0.03, LY),
        ('R', (IX1 - SOF + 0.01, SYC, H - 0.10), (0.02, SYL, 0.04), (IX1 - SOF + 0.09, SYC, H - 0.115), (0.012, LY, 0.006), (0, math.radians(135), 0), 0.03, LY),
        ('F', (W / 2, IY0 + SOF - 0.01, H - 0.10), (IX1 - IX0 - 2 * SOF, 0.02, 0.04), (W / 2, IY0 + SOF - 0.09, H - 0.115), (LX, 0.012, 0.006), (math.radians(135), 0, 0), LX, 0.03)):
    box(f'CoveLip{nm}', lip_c, lip_s, 'Ceiling', 'CEIL')
    box(f'CoveLED{nm}', led_c, led_s, 'EmitCove', 'EMIT')
    light(f'Cove{nm}', 'AREA', (led_c[0], led_c[1], led_c[2] + 0.01), COVE_E * max(lsx, lsy), (1.0, 0.64, 0.36), sx=lsx, sy=lsy, rot=rot)
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
# r2: sheer curtains gathered at both glass edges (a ceiling track runs the full width, just inside the glass)
box('CurtainTrack', (W / 2, D - T - 0.16, H - 0.02), (IX1 - IX0, 0.04, 0.025), 'BlackMetal', 'CEIL')
sheer_curtain('SheerL', IX0 + 0.04, IX0 + 0.95, D - T - 0.16, 0.015, H - 0.035, folds=7)
sheer_curtain('SheerR', IX1 - 0.95, IX1 - 0.04, D - T - 0.16, 0.015, H - 0.035, folds=7)
# Cool dusk fill through the glass (the shadows get a blue cast; warm pools read against it)
# r5c fix: area lights emit along local -Z; Rx(+90) aimed SkyFill OUT of the room (+y) and DoorSpill out of the door (-y).
light('SkyFill', 'AREA', (W / 2, D + 0.8, 1.9), float(os.environ.get('SKY_E', '70')), (0.42, 0.52, 1.0), sx=IX1 - IX0, sy=2.8, rot=(math.radians(-90), 0, 0))
light('CeilBounce', 'AREA', (W / 2, D / 2, 0.9), float(os.environ.get('BOUNCE_E', '24')), (1.0, 0.70, 0.45), sx=W - 1.5, sy=D - 1.5, rot=(math.radians(180), 0, 0))
# Faint warm bounce from the doorway (the plaza outside is lit)
light('DoorSpill', 'AREA', (W / 2, -0.6, 1.2), 30, (1.0, 0.78, 0.55), sx=1.4, sy=2.0, rot=(math.radians(90), 0, 0))
# soft warm front fill high on the door wall, aimed into the room and down 30 deg (lifts the faces seen from the door)
light('FrontFill', 'AREA', (W / 2, IY0 + 0.12, 2.75), float(os.environ.get('FRONT_E', {'library': '80', 'lounge': '75', 'studio': '70'}[MID])), (1.0, 0.74, 0.50), sx=6.0, sy=0.5, rot=(math.radians(60), 0, 0))

# ================================================================ module layouts (r2 redesign)
DESKS = []; SCREEN_Y = 1.65
STX = None
def builtin_wall(name, y0, y1, depth=0.38, bays=5, base_h=0.72, top=H - 0.26, n_shelves=6, density=0.8, books=True, leds=True):
    """A full-height built-in on the LEFT wall: walnut carcass, a charcoal back, closed base cabinets with shadow-gap doors,
    open bays above with shelves dressed with books/objects and a warm LED strip under each shelf front (real lights)."""
    x0 = IX0; xf = x0 + depth
    box(f'{name}Back', (x0 + 0.01, (y0 + y1) / 2, top / 2), (0.02, y1 - y0, top), 'StoneDark')
    for s_, y in ((0, y0), (1, y1)): box(f'{name}Side{s_}', (x0 + depth / 2, y + (0.015 if s_ == 0 else -0.015), top / 2), (depth, 0.03, top), 'Walnut', bevel=0.003)
    box(f'{name}Top', (x0 + depth / 2, (y0 + y1) / 2, top - 0.02), (depth, y1 - y0, 0.04), 'Walnut', bevel=0.003)
    box(f'{name}Kick', (x0 + depth / 2 - 0.03, (y0 + y1) / 2, 0.04), (depth - 0.06, y1 - y0 - 0.04, 0.08), 'BlackMetal')
    bw = (y1 - y0 - 0.03) / bays
    # base: doors with shadow gaps
    for i in range(bays * 2):
        dy = (y1 - y0 - 0.06) / (bays * 2); yc = y0 + 0.03 + dy * (i + 0.5)
        box(f'{name}Door{i}', (xf - 0.01, yc, (0.08 + base_h) / 2), (0.02, dy - 0.006, base_h - 0.09), 'Walnut', bevel=0.002)
        box(f'{name}Pull{i}', (xf + 0.004, yc + (dy / 2 - 0.06) * (1 if i % 2 == 0 else -1), base_h - 0.12), (0.008, 0.012, 0.16), 'Brass')
    box(f'{name}BaseBody', (x0 + depth / 2 - 0.01, (y0 + y1) / 2, (0.08 + base_h) / 2), (depth - 0.04, y1 - y0 - 0.06, base_h - 0.08), 'StoneDark')
    zs = [base_h + (top - 0.04 - base_h) * k / n_shelves for k in range(n_shelves)]
    box(f'{name}Counter', (x0 + depth / 2 + 0.01, (y0 + y1) / 2, base_h + 0.015), (depth + 0.02, y1 - y0, 0.03), 'Walnut', bevel=0.003)
    for i in range(1, bays):
        y = y0 + 0.015 + bw * i
        box(f'{name}Div{i}', (x0 + (depth - 0.02) / 2 + 0.02, y, (base_h + top) / 2), (depth - 0.04, 0.03, top - base_h), 'Walnut', bevel=0.002)
    room = zs[1] - zs[0] - 0.025
    for k, z in enumerate(zs):
        if k > 0: box(f'{name}Shelf{k}', (x0 + (depth - 0.02) / 2 + 0.02, (y0 + y1) / 2, z), (depth - 0.04, y1 - y0 - 0.04, 0.025), 'Walnut', bevel=0.002)
        for i in range(bays):
            a0 = y0 + 0.03 + bw * i + 0.012; a1 = a0 + bw - 0.03
            if leds and k < n_shelves - 0 and k >= 0:
                zl = (zs[k + 1] if k + 1 < len(zs) else top - 0.04) - 0.016
                box(f'{name}LED{k}_{i}', (xf - 0.05, (a0 + a1) / 2, zl), (0.01, a1 - a0 - 0.02, 0.004), 'EmitShelf', 'EMIT')
                light(f'{name}LEDL{k}_{i}', 'AREA', (xf - 0.06, (a0 + a1) / 2, zl - 0.006), SHELF_E, (1.0, 0.66, 0.40), sx=0.02, sy=a1 - a0 - 0.02)
            if books: shelf_dress(f'{name}{k}_{i}', x0 + 0.02, depth - 0.02, a0, a1, z + 0.0125, room, 1, density)
    return xf
SHELF_E = float(os.environ.get('SHELF_E', '2.2'))
WALL_ART = None
if MID == 'library':
    # LEFT: full-height built-in bookshelf wall. BACK-LEFT: reading nook on one rug. CENTRE-RIGHT: round table under its pendant.
    # RIGHT: the one artwork over a low walnut console (the live screen slot covers that wall when it mounts).
    builtin_wall('Books', 0.32, 5.10, bays=5)
    # reading nook: lounge chair + ottoman + floor lamp + side table, all on one rug, angled to the room
    rug('RugNookRug', 1.95, 4.55, 2.5, 2.0, 'RugNook')
    nd = (0.62, -0.78); NX, NY = 1.45, 4.95
    cc0('mid_century_lounge_chair', (NX, NY, 0), face_rot(nd)); seat(NX + nd[0] * 0.12, NY + nd[1] * 0.12, 0.46, nd, 'chair', 'nook')
    cc0('Ottoman_01', (NX + nd[0] * 0.98, NY + nd[1] * 0.98, 0), face_rot(nd) + math.pi / 2, 0.8)
    floor_lamp(0, 0.92, 5.45, energy=85)
    cc0('side_table_01', (2.35, 5.25, 0), 0.3)
    cyl('NookMug', (2.28, 5.20, 0.565), 0.04, 0.09, 'Ceramic', seg=24)
    box('NookBook', (2.42, 5.30, 0.565), (0.22, 0.16, 0.03), 'BookC', bevel=0.002, seg=1)
    rbox('Throw', (NX - 0.05, NY + 0.08, 0.47), (0.55, 0.45, 0.03), 0.4, 'Boucle', bevel=0.012, seg=2)
    # round table + 3 chairs on a round rug, the pendant right over the table centre
    RX, RY = 5.35, 3.85
    principled('RugRound', diff=round_rug_tex('gen_rug_round', (0.52, 0.47, 0.41), (0.46, 0.41, 0.35), 44), rough=1.0)
    rug_round('RugTable', RX, RY, 1.22, 'RugRound')
    cyl('TableTop', (RX, RY, 0.745), 0.55, 0.04, 'Walnut', seg=64)
    cc0('brass_vase_01', (RX - 0.05, RY + 0.12, 0.765), 0.0, 0.4)
    cyl('TableStem', (RX, RY, 0.37), 0.05, 0.70, 'BlackMetal', seg=24)
    cyl('TableFoot', (RX, RY, 0.015), 0.30, 0.03, 'BlackMetal', seg=48)
    for i, a_deg in enumerate((0, 90, 180)):
        a_ = math.radians(a_deg); cx_, cy_ = RX + 0.80 * math.cos(a_), RY + 0.80 * math.sin(a_)
        d = (RX - cx_, RY - cy_); n = math.hypot(*d); d = (d[0] / n, d[1] / n)
        cc0('dining_chair_02', (cx_, cy_, 0), face_rot(d)); seat(cx_ + d[0] * 0.03, cy_ + d[1] * 0.03, 0.45, d, 'chair', 'table')
    for j, (dx, dy, h, m) in enumerate(((-0.22, 0.12, 0.035, 'BookB'), (-0.20, 0.14, 0.03, 'BookD'), (-0.23, 0.11, 0.028, 'BookG'))):
        box(f'TableBook{j}', (RX + dx, RY + dy, 0.765 + 0.032 * j + h / 2), (0.24 - 0.02 * j, 0.17, h), m, bevel=0.002, seg=1)
    box('OpenBook', (RX + 0.12, RY - 0.18, 0.772), (0.34, 0.24, 0.012), 'BookD', bevel=0.003)
    cyl('TableCup', (RX + 0.28, RY + 0.14, 0.81), 0.04, 0.09, 'Ceramic', seg=24)
    pendant(0, RX, RY, 1.62, 0.22, 75)
    light('TablePool', 'SPOT', (RX, RY, H - 0.02), 22, (1.0, 0.66, 0.40), soft=0.05, cone=34, blend=0.6)
    # right wall: console + the room's one artwork
    CY_ = 4.70
    box('Console', (IX1 - 0.22, CY_, 0.36), (0.40, 1.7, 0.66), 'Walnut', bevel=0.006)
    box('ConsoleKick', (IX1 - 0.22, CY_, 0.02), (0.34, 1.6, 0.04), 'BlackMetal')
    for q in range(2): box(f'ConsoleSlot{q}', (IX1 - 0.425, CY_ - 0.41 + 0.82 * q, 0.38), (0.006, 0.80, 0.56), 'StoneDark')
    table_lamp(0, IX1 - 0.24, CY_ + 0.62, 0.69, energy=36)
    cc0('ceramic_vase_01', (IX1 - 0.24, CY_ - 0.55, 0.69), 0.0, 0.85)
    for q, m_ in enumerate(('BookB', 'BookD', 'BookG')): box(f'ConsoleBook{q}', (IX1 - 0.25, CY_ + 0.05, 0.69 + 0.02 + 0.036 * q), (0.26 - 0.02 * q, 0.20, 0.036), m_, bevel=0.002, seg=1)
    canvas_on_wall('CanvasA', 'right', CY_, 1.40, 1.00, 1.78, 'CanvasB'); WALL_ART = 'right'
    # plants: one planter type (stone), two plants framing the glass corners
    potted('money_tree', 'pachira_aquatica_01', ['pachira_aquatica_01_bark_d', 'pachira_aquatica_01_leaves_d'], (6.70, 5.55, 0), 0.6, 1.0, POT(0.25, 0.48))
    potted('calathea_b', 'calathea_orbifolia_01', ['calathea_orbifolia_01_b'], (7.45, 0.62, 0), 0.4, 1.6, POT(0.17, 0.48))
    for (x, y) in ((2.6, 1.5), (6.0, 1.3)): downlight(x, y, 3.0, 60)
elif MID == 'lounge':
    # r5: ONE conversation group on ONE rug, its axis along the view: the sofa floats with its back to the glass and
    # faces the door; two identical armchairs face it across the coffee table (side by side, toed in to the table);
    # the pendant hangs right over the coffee table. Secondary zone on the right: a reading chair + ottoman + floor lamp
    # + side table on a small round rug by the glass. ONE large artwork on the left wall over a side table + lamp.
    # r5b: the whole group sits back from the door so the armchairs are in full view (not cropped by the lens)
    GX, GY = 3.55, 3.95                       # group centre = coffee table (r5f: on the camera axis)
    rug('RugLounge', GX, GY + 0.08, 3.8, 2.9, 'RugPit')
    SY = GY + 1.16
    sofa('Sofa', GX, SY, (0, -1), 3, 'Boucle', ['VelvetRust', 'FabricCharcoal'], 'lounge', seat_w=0.84, throw=False, plinth='BlackMetal')
    # extra cushions + a throw over the right arm (styled, not symmetric)
    FS = Frame(GX, SY, (0, -1)); a_ = FS.ang
    rbox('SofaPillow2', FS.p(-0.62, -0.05, 0.62), (0.40, 0.12, 0.38), a_ - 0.10, 'Linen', bevel=0.06, seg=3)
    rbox('SofaPillow3', FS.p(0.70, -0.07, 0.60), (0.36, 0.12, 0.34), a_ + 0.12, 'FabricCharcoal', bevel=0.06, seg=3)
    rbox('SofaThrowArm', FS.p(1.45, 0.05, 0.62), (0.30, 0.62, 0.035), a_, 'Linen', bevel=0.014, seg=2)
    rbox('SofaThrowFall', FS.p(1.61, 0.05, 0.40), (0.035, 0.62, 0.44), a_, 'Linen', bevel=0.014, seg=2)
    rbox('SofaThrowSeat', FS.p(1.12, 0.15, 0.475), (0.42, 0.60, 0.03), a_ + 0.05, 'Linen', bevel=0.012, seg=2)
    CTX, CTY = GX, GY
    cc0('coffee_table_round_01', (CTX, CTY, 0), 0.0, 0.72)
    ctop = 0.49 * 0.72
    for j, (h, m) in enumerate(((0.035, 'BookD'), (0.03, 'BookA'), (0.025, 'BookG'))):
        box(f'CoffeeBook{j}', (CTX - 0.12, CTY + 0.10, ctop + 0.005 + 0.033 * j + h / 2), (0.24 - 0.02 * j, 0.30 - 0.03 * j, h), m, bevel=0.002, seg=1)
    cyl('CoffeeBowl', (CTX + 0.16, CTY - 0.10, ctop + 0.04), 0.11, 0.07, 'Ceramic', seg=32, r2=0.07)
    cc0('brass_vase_01', (CTX + 0.10, CTY + 0.20, ctop), 0.0, 0.30)
    # two identical armchairs facing the sofa across the table, each toed in toward the group centre (between table and sofa)
    for k, sx_ in enumerate((-1, 1)):
        # r5f: a U: each chair at a front corner of the table, turned 50 deg in toward the sofa (3/4 view from the door)
        cx_, cy_ = GX + sx_ * 1.30, GY - 0.55
        d = (-sx_ * math.sin(math.radians(50)), math.cos(math.radians(50)))
        cc0('modern_arm_chair_01', (cx_, cy_, 0), face_rot(d)); seat(cx_ + d[0] * 0.05, cy_ + d[1] * 0.05, 0.53, d, 'chair', 'lounge')
    # sofa ends: side table + lamp (left, under the artwork), floor lamp (right)
    cc0('side_table_01', (GX - 1.95, SY - 0.10, 0), math.pi / 2)
    table_lamp(1, GX - 1.95, SY - 0.10, 0.55, energy=40)
    cc0('side_table_01', (GX + 1.92, SY - 0.10, 0), math.pi / 2)
    cc0('ceramic_vase_01', (GX + 1.92, SY - 0.10, 0.55), 0.0, 0.7)
    pendant(0, CTX, CTY, 2.30, 0.36, 75)
    canvas_on_wall('CanvasSofa', 'left', 3.60, 1.60, 1.15, 1.70, 'CanvasW'); WALL_ART = 'left'
    # a slim walnut bench under the artwork (grounds it on the wall) with a stack of books
    box('ArtBench', (IX0 + 0.22, 3.60, 0.22), (0.36, 1.6, 0.04), 'Walnut', bevel=0.004)
    for s_ in (-1, 1): box(f'ArtBenchLeg{s_}', (IX0 + 0.22, 3.60 + s_ * 0.72, 0.10), (0.30, 0.04, 0.20), 'BlackMetal')
    for q, m_ in enumerate(('BookA', 'BookD')): box(f'ArtBenchBook{q}', (IX0 + 0.22, 3.25, 0.24 + 0.02 + 0.04 * q), (0.24, 0.30, 0.04), m_, bevel=0.002, seg=1)
    # right wall: a long low sideboard (media wall: the screen slot sits above it), one lamp, a vase, a book stack
    SBX = IX1 - 0.24
    box('Sideboard', (SBX, 2.75, 0.36), (0.44, 2.4, 0.64), 'Walnut', bevel=0.006)
    box('SideboardKick', (SBX, 2.75, 0.02), (0.38, 2.3, 0.04), 'BlackMetal')
    for q in range(3): box(f'SideboardSlot{q}', (SBX - 0.225, 2.75 - 0.78 + 0.78 * q, 0.38), (0.006, 0.74, 0.54), 'StoneDark')
    table_lamp(2, SBX, 1.85, 0.68)
    cc0('ceramic_vase_01', (SBX, 3.55, 0.68), 0.0, 0.8)
    for q, m_ in enumerate(('BookB', 'BookA', 'BookG')): box(f'SideBook{q}', (SBX, 3.0, 0.68 + 0.02 + 0.04 * q), (0.26, 0.20, 0.04), m_, bevel=0.002, seg=1)
    # secondary zone (right, by the glass): reading chair + ottoman on a small round rug, floor lamp behind, side table
    principled('RugRoundL', diff=round_rug_tex('gen_rug_round_l', (0.40, 0.36, 0.31), (0.35, 0.31, 0.27), 45), rough=1.0)
    rd = (-0.55, -0.83); RCX, RCY = 6.85, 4.60
    rug_round('RugRead', RCX - 0.25, RCY - 0.38, 1.0, 'RugRoundL')
    cc0('mid_century_lounge_chair', (RCX, RCY, 0), face_rot(rd)); seat(RCX + rd[0] * 0.12, RCY + rd[1] * 0.12, 0.46, rd, 'chair', 'reading')
    cc0('Ottoman_01', (RCX + rd[0] * 0.95, RCY + rd[1] * 0.95, 0), face_rot(rd) + math.pi / 2, 0.8)
    floor_lamp(1, RCX + 0.50, RCY + 0.30, h=1.5, energy=60)
    cc0('side_table_01', (RCX - 0.75, RCY + 0.25, 0), 0.4)
    cyl('ReadMug', (RCX - 0.79, RCY + 0.20, 0.565), 0.04, 0.09, 'Ceramic', seg=24)
    box('ReadBook', (RCX - 0.67, RCY + 0.30, 0.565), (0.22, 0.16, 0.03), 'BookC', bevel=0.002, seg=1)
    potted('money_tree', 'pachira_aquatica_01', ['pachira_aquatica_01_bark_d', 'pachira_aquatica_01_leaves_d'], (0.75, 5.40, 0), 1.2, 1.1, POT(0.27, 0.50))
    potted('calathea_b', 'calathea_orbifolia_01', ['calathea_orbifolia_01_b'], (7.45, 0.62, 0), 2.0, 1.6, POT(0.17, 0.48))
    for (x, y) in ((5.6, 1.6),): downlight(x, y, 3.0, 60)
elif MID == 'studio':
    # r5: ONE double-sided bench desk PERPENDICULAR to the glass (screens face along x: never backlit by the view).
    # Four identical task chairs, two per side, mirrored at equal spacing; NO desk lamps: the bench is lit by a brighter
    # linear pendant right over it + an integrated LED strip under the cable-spine shelf. The desk has a walnut modesty
    # panel and a black cable tray under the top. Left wall: built-in shelving. Right wall: credenza + ONE artwork + an
    # acoustic slat panel field behind the art (the wall feature).
    BX, BY0, BY1, BD = 4.0, 2.05, 4.85, 1.6
    BYC, BL = (BY0 + BY1) / 2, BY1 - BY0
    rug('RugStudio', BX, BYC, 4.0, 4.0, 'RugCharcoal')
    top = 0.74
    box('BenchTop', (BX, BYC, top - 0.02), (BD, BL, 0.04), 'Walnut', bevel=0.006)
    box('BenchApron', (BX, BYC, top - 0.065), (BD - 0.10, BL - 0.10, 0.05), 'BlackMetal')
    for y in (BY0 + 0.12, BY1 - 0.12):   # two closed walnut panel legs (sled ends)
        box(f'BenchEnd{y:.2f}', (BX, y, (top - 0.09) / 2), (BD - 0.06, 0.05, top - 0.09), 'Walnut', bevel=0.004)
    box('Modesty', (BX, BYC, 0.43), (0.03, BL - 0.30, 0.46), 'Walnut', bevel=0.003)
    box('CableTray', (BX, BYC, top - 0.16), (0.26, BL - 0.40, 0.08), 'BlackMetal')
    # cable spine: a low walnut shelf on black posts down the middle, with an LED strip under it lighting both work zones
    box('SpineShelf', (BX, BYC, top + 0.32), (0.30, BL - 0.20, 0.025), 'Walnut', bevel=0.003)
    for y in (BY0 + 0.18, BYC, BY1 - 0.18): box(f'SpinePost{y:.2f}', (BX, y, top + 0.16), (0.03, 0.03, 0.32), 'BlackMetal')
    box('SpineLED', (BX, BYC, top + 0.305), (0.22, BL - 0.30, 0.004), 'EmitStrip', 'EMIT')
    light('SpineLight', 'AREA', (BX, BYC, top + 0.30), float(os.environ.get('SPINE_E', '40')), (1.0, 0.70, 0.46), sx=0.22, sy=BL - 0.30, rot=(math.radians(180), 0, 0))
    for q, (yy, m_) in enumerate(((BY0 + 0.45, 'BookB'), (BY0 + 0.52, 'BookA'), (BY0 + 0.58, 'BookF'))):
        box(f'SpineBook{q}', (BX, yy, top + 0.333 + 0.11), (0.20, 0.045, 0.22), m_, bevel=0.002, seg=1)
    cc0('ceramic_vase_01', (BX, BY1 - 0.55, top + 0.333), 0.0, 0.55)
    SLOTS = [(BYC - 0.72, -1), (BYC + 0.72, -1), (BYC - 0.72, 1), (BYC + 0.72, 1)]
    for k, (cy, side) in enumerate(SLOTS):
        f = (-side, 0)
        mx = BX + side * 0.30; mz = top + 0.36
        box(f'MonBezel{k}', (mx, cy, mz), (0.025, 0.62, 0.37), 'Plastic', bevel=0.006)
        xs = mx + side * 0.0135
        so = quad(f'Screen{k}', [(xs, cy - 0.295, mz - 0.17), (xs, cy + 0.295, mz - 0.17), (xs, cy + 0.295, mz + 0.17), (xs, cy - 0.295, mz + 0.17)] if side > 0 else
                  [(xs, cy + 0.295, mz - 0.17), (xs, cy - 0.295, mz - 0.17), (xs, cy - 0.295, mz + 0.17), (xs, cy + 0.295, mz + 0.17)], f'EmitScreen{k % 3}', 'EMIT')
        uv_fit(so, cy - 0.295 if side > 0 else cy + 0.295, cy + 0.295 if side > 0 else cy - 0.295, mz - 0.17, mz + 0.17, axes=(1, 2))
        box(f'MonNeck{k}', (mx - side * 0.04, cy, top + 0.12), (0.025, 0.05, 0.24), 'BlackMetal')
        box(f'MonBase{k}', (mx - side * 0.02, cy, top + 0.006), (0.16, 0.22, 0.012), 'BlackMetal', bevel=0.003)
        kx = BX + side * 0.58
        box(f'Keyb{k}', (kx, cy, top + 0.01), (0.13, 0.42, 0.018), 'Plastic', bevel=0.004)
        box(f'Mouse{k}', (kx, cy - 0.30 * side, top + 0.012), (0.1, 0.06, 0.024), 'Plastic', bevel=0.01)
        box(f'DeskPad{k}', (kx - side * 0.02, cy + 0.02, top + 0.002), (0.34, 0.80, 0.003), 'FabricCharcoal')
        # one styled object per seat, alternating, never a lamp
        if k in (0, 3): cyl(f'Mug{k}', (kx + side * 0.04, cy + 0.36 * side, top + 0.05), 0.04, 0.1, 'Ceramic', seg=24)
        else: box(f'Notebook{k}', (kx + side * 0.02, cy + 0.38 * side, top + 0.008), (0.21, 0.29, 0.016), 'BookG', bevel=0.002)
        cxh = BX + side * (BD / 2 + 0.36)
        task_chair(k, cxh, cy, f)
        seat(cxh, cy, 0.47, f, 'desk', 'studio')
        DESKS.append({'x': BX + side * 0.55, 'y': cy, 'face': (side, 0), 'screen': {'x': xs, 'y': cy, 'z': mz}})
    linear_pendant(0, BX, BYC, BL - 0.4, 1.95, 'y', energy=float(os.environ.get('LIN_E', '120')))
    # walnut slats above the bench
    x = BX - 1.3
    while x <= BX + 1.3 + 1e-6:
        box(f'CeilSlat{x:.2f}', (x, BYC, H - 0.045), (0.045, BL + 1.2, 0.07), 'Walnut', 'CEIL'); x += 0.11
    box('CeilSlatBack', (BX, BYC, H - 0.005), (2.75, BL + 1.2, 0.01), 'StoneDark', 'CEIL')
    # left wall: a shorter built-in (shelves with objects, binders, fewer books), it runs back toward the glass so it reads
    builtin_wall('ShelfL', 2.10, 5.20, bays=3, n_shelves=5, density=0.62)
    # right wall: low credenza (front half) + the acoustic slat field with the ONE artwork (back half, in view)
    box('Credenza', (IX1 - 0.24, 2.55, 0.31), (0.44, 2.4, 0.56), 'Walnut', bevel=0.006)
    box('CredenzaKick', (IX1 - 0.24, 2.55, 0.02), (0.38, 2.3, 0.04), 'BlackMetal')
    for q in range(3): box(f'CredSlot{q}', (IX1 - 0.465, 2.55 - 0.78 + 0.78 * q, 0.33), (0.006, 0.74, 0.48), 'StoneDark')
    cc0('ceramic_vase_01', (IX1 - 0.24, 1.65, 0.59), 0.0, 0.8)
    for q, m_ in enumerate(('BookF', 'BookD', 'BookA')): box(f'CredBook{q}', (IX1 - 0.25, 3.0, 0.59 + 0.02 + 0.036 * q), (0.26 - 0.02 * q, 0.20, 0.036), m_, bevel=0.002, seg=1)
    table_lamp(0, IX1 - 0.24, 3.45, 0.59, energy=34)
    AY0, AY1 = 3.95, 5.45
    box('AcuBack', (IX1 - 0.012, (AY0 + AY1) / 2, 1.55), (0.02, AY1 - AY0, 2.5), 'FabricCharcoal')
    yy = AY0 + 0.03
    while yy < AY1 - 0.02:
        box(f'AcuSlat{yy:.2f}', (IX1 - 0.035, yy, 1.55), (0.025, 0.028, 2.5), 'Walnut'); yy += 0.055
    canvas_on_wall('CanvasStudio', 'right', 4.70, 0.95, 1.25, 1.62, 'CanvasE'); WALL_ART = 'right'
    potted('money_tree', 'pachira_aquatica_01', ['pachira_aquatica_01_bark_d', 'pachira_aquatica_01_leaves_d'], (0.75, 5.50, 0), 0.6, 1.15, POT(0.27, 0.50))
    potted('calathea_c', 'calathea_orbifolia_01', ['calathea_orbifolia_01_c'], (7.35, 1.0, 0), 1.0, 1.3, POT(0.18, 0.36))
    potted('money_tree_shrub', 'pachira_aquatica_01', ['pachira_aquatica_01_bark_c', 'pachira_aquatica_01_leaves_c'], (7.30, 5.55, 0), 0.4, 1.0, POT(0.30, 0.46))
    for (x, y) in ((2.0, 1.4), (6.0, 1.4)): downlight(x, y, 3.0, 60)

# ================================================================ desk-lamp emitters (CC0 desk lamps, build.py)
for m in bpy.data.materials:
    if m.name.startswith('desk_lamp_arm_01_light') and m.node_tree:
        b = m.node_tree.nodes.get('Principled BSDF')
        if b: b.inputs['Emission Color'].default_value = (1.0, 0.70, 0.45, 1); b.inputs['Emission Strength'].default_value = 4.0
k = 0
for o in list(ROOM.objects):
    if o.type != 'MESH' or not o.material_slots: continue
    idx = [i for i, sl in enumerate(o.material_slots) if sl.material and sl.material.name.startswith('desk_lamp_arm_01_light')]
    if not idx: continue
    pts = [o.matrix_world @ o.data.vertices[v].co for p in o.data.polygons if p.material_index in idx for v in p.vertices]
    if not pts: continue
    c = sum(pts, Vector()) / len(pts)
    light(f'DeskLamp{k}', 'SPOT', (c.x, c.y, c.z - 0.04), 14, (1.0, 0.62, 0.36), soft=0.02, cone=100, blend=0.8); k += 1

# ================================================================ world: the penthouse city panorama (blue hour) through the glass
wd = bpy.data.worlds.new('City'); scene.world = wd; wd.use_nodes = True; nt = wd.node_tree; nt.nodes.clear()
tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping'); mp.inputs['Rotation'].default_value = (0, 0, math.radians(float(os.environ.get('CITY_ROT', '200'))))
et = nt.nodes.new('ShaderNodeTexEnvironment'); _cp = os.path.join(GEN, 'city_clean.exr'); et.image = bpy.data.images.load(_cp if os.path.exists(_cp) else os.path.join(A, 'city.exr')); et.image.colorspace_settings.name = 'Linear Rec.709'
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
    fx, fy = dk.get('face', (0, -1))   # direction the screen faces (Blender xy)
    anchors['desks'].append({**L(dk['x'], dk['y']), 'rotY': yaw((fx, fy)), 'monitor': {'y': round(s['z'], 3), 'z': round((s['x'] - dk['x']) * fx + (s['y'] - dk['y']) * fy, 3), 'width': 0.69, 'height': 0.40}})
for i, (x, y, z, d, kind, zone) in enumerate(SEATS):
    anchors['seats'].append({**L(x, y, z), 'rotY': yaw(d), 'kind': kind, 'zone': zone})
    empty(f'seat_{i + 1}', (x, y, z), face_rot(d), {'kind': kind, 'zone': zone, 'seat_h': round(z, 3)})
empty('sign_anchor', (W / 2, -T - 0.035, 2.86), 0.0)
empty('screen_anchor', (IX1 - 0.03, 3.0, SCREEN_Y), face_rot((-1, 0)))
for i, b in enumerate(anchors['boards']): empty(f'board_anchor_{i + 1}', (b['x'] + W / 2, D / 2 - b['z'], b['y']), math.pi)

# collision blocks (room-local rectangles) from the furniture footprint on the floor (everything FURN taller than 0.3 m)
BLOCKS = {
    'library': [(IX0 + 0.2, 2.71, 0.2, 2.4), (5.35, 3.85, 1.0, 1.0), (1.75, 4.75, 0.8, 0.75), (IX1 - 0.22, 4.70, 0.22, 0.85), (6.70, 5.55, 0.28, 0.28), (7.45, 0.62, 0.2, 0.2)],
    'lounge': [(3.55, 5.11, 1.5, 0.5), (3.55, 3.95, 0.47, 0.47), (2.25, 3.4, 0.42, 0.42), (4.85, 3.4, 0.42, 0.42), (1.6, 5.01, 0.28, 0.28), (IX1 - 0.24, 2.75, 0.22, 1.2), (6.6, 4.35, 0.75, 0.7), (0.75, 5.40, 0.3, 0.3), (7.45, 0.62, 0.2, 0.2)],
    'studio': [(4.0, 3.45, 0.8, 1.4), (IX0 + 0.2, 3.65, 0.2, 1.55), (IX1 - 0.24, 2.55, 0.22, 1.2), (0.75, 5.5, 0.28, 0.28), (7.35, 1.0, 0.2, 0.2), (7.30, 5.55, 0.3, 0.3)],
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

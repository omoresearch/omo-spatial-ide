# Builds the penthouse room + procedural Manhattan-like city in Blender and saves scene.blend.
# Run: blender -b --factory-startup -P build.py
import bpy, bmesh, math, random, os, sys
from mathutils import Vector
sys.path.insert(0, os.path.dirname(__file__))
from common import NB

LANE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
A = os.path.join(LANE, 'assets')
random.seed(7)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
ROOM = bpy.data.collections.new('Room'); scene.collection.children.link(ROOM)
CITY = bpy.data.collections.new('City'); scene.collection.children.link(CITY)

RW, RD, RH = 18.0, 12.0, 3.4          # room width (x), depth (y), height (z)
H = 230.0                              # floor height above street

# ---------------------------------------------------------------- materials
MATS = {}
TILE = {}

def img(name, colorspace='sRGB'):
    im = bpy.data.images.load(os.path.join(A, name), check_existing=True)
    im.colorspace_settings.name = colorspace
    return im

def principled(name, color=(0.5, 0.5, 0.5), rough=0.5, metal=0.0, diff=None, roughmap=None, normal=None, tile=1.0, spec=0.5, emit=None, emit_strength=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nb = NB(m.node_tree); nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    uv = None
    if diff or roughmap or normal:
        uv = nb.node('ShaderNodeUVMap', uv_map='UVMap')
    if diff:
        t = nb.node('ShaderNodeTexImage'); t.image = img(diff); nb.link(uv.outputs[0], t.inputs[0])
        nb.link(t.outputs[0], bsdf.inputs['Base Color'])
    if roughmap:
        t = nb.node('ShaderNodeTexImage'); t.image = img(roughmap, 'Non-Color'); nb.link(uv.outputs[0], t.inputs[0])
        nb.link(t.outputs[0], bsdf.inputs['Roughness'])
    if normal:
        t = nb.node('ShaderNodeTexImage'); t.image = img(normal, 'Non-Color'); nb.link(uv.outputs[0], t.inputs[0])
        nm = nb.node('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = 0.6
        nb.link(t.outputs[0], nm.inputs['Color']); nb.link(nm.outputs[0], bsdf.inputs['Normal'])
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = (*emit, 1)
        bsdf.inputs['Emission Strength'].default_value = emit_strength
        bsdf.inputs['Base Color'].default_value = (0, 0, 0, 1)
    MATS[name] = m; TILE[name] = tile
    return m

principled('Parquet', diff='herringbone_parquet_diff_2k.jpg', roughmap='herringbone_parquet_rough_2k.jpg', normal='herringbone_parquet_nor_gl_2k.jpg', tile=2.0)
MATS['Parquet'].node_tree.nodes['Normal Map'].inputs['Strength'].default_value = 0.25   # soft, satin oiled oak: no wavy mirror
principled('Walnut', diff='wood_table_001_diff_1k.jpg', roughmap='wood_table_001_rough_1k.jpg', tile=1.4)
principled('DarkWood', diff='dark_wood_diff_1k.jpg', rough=0.45, tile=1.2)
principled('Marble', diff='marble_01_diff_1k.jpg', roughmap='marble_01_rough_1k.jpg', tile=0.9)
principled('Rug', diff='fabric_pattern_07_col_1_1k.jpg', rough=1.0, tile=1.2)
principled('Plaster', color=(0.56, 0.54, 0.51), rough=0.9)
principled('Ceiling', color=(0.72, 0.72, 0.70), rough=0.95)
principled('Oak', color=(0.30, 0.17, 0.08), rough=0.55)
principled('Bronze', color=(0.10, 0.085, 0.07), rough=0.35, metal=1.0)
principled('BlackMetal', color=(0.03, 0.03, 0.03), rough=0.35, metal=1.0)
principled('Chrome', color=(0.6, 0.6, 0.6), rough=0.15, metal=1.0)
principled('FabricOat', color=(0.50, 0.44, 0.36), rough=1.0)
principled('FabricCharcoal', color=(0.035, 0.035, 0.04), rough=0.85)
principled('Leather', color=(0.20, 0.07, 0.025), rough=0.45)
principled('Leaf', color=(0.035, 0.10, 0.025), rough=0.45)
principled('LeafLight', color=(0.07, 0.16, 0.04), rough=0.5)
principled('Pot', color=(0.20, 0.19, 0.17), rough=0.8)
principled('Plastic', color=(0.025, 0.025, 0.028), rough=0.45)
principled('Ceramic', color=(0.80, 0.78, 0.74), rough=0.15)
principled('BookA', color=(0.45, 0.40, 0.32), rough=0.8)
principled('BookB', color=(0.08, 0.12, 0.18), rough=0.8)
principled('BookC', color=(0.35, 0.08, 0.05), rough=0.8)
principled('Stone', color=(0.20, 0.19, 0.18), rough=0.7)
principled('EmitDown', emit=(1.0, 0.62, 0.34), emit_strength=6.0)
for _k in range(3): principled(f'EmitScreen{_k}', emit=(0.45, 0.55, 0.70), emit_strength=1.6)
principled('EmitShade', emit=(1.0, 0.56, 0.27), emit_strength=5.0)   # r4b: amber, not white
principled('EmitStrip', emit=(1.0, 0.74, 0.50), emit_strength=7.0)
principled('EmitBackBar', emit=(1.0, 0.55, 0.22), emit_strength=3.0)
principled('EmitCove', emit=(1.0, 0.55, 0.25), emit_strength=0.8)   # r5: cove at ~12% of the original (EmitStrip 7.0)

# ---------------------------------------------------------------- mesh helpers
OBJS = []  # (obj, group)

def boxmap(bm, tile):
    uvl = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        n = f.normal; ax = max(range(3), key=lambda i: abs(n[i]))
        for l in f.loops:
            p = l.vert.co
            if ax == 0: u, v = p.y, p.z
            elif ax == 1: u, v = p.x, p.z
            else: u, v = p.x, p.y
            l[uvl].uv = (u / tile, v / tile)

def finish(bm, name, mat, group):
    boxmap(bm, TILE.get(mat, 1.0))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    me.materials.append(MATS[mat])
    for p in me.polygons: p.use_smooth = False
    ob = bpy.data.objects.new(name, me); ROOM.objects.link(ob)
    ob['grp'] = 'LEAF' if name.endswith('Leaves') else group
    OBJS.append((ob, group))
    return ob

def box(name, c, s, mat, group='FURN', bevel=0.0, seg=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * s[0] + c[0], v.co.y * s[1] + c[1], v.co.z * s[2] + c[2]))
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=seg, profile=0.5, affect='EDGES')
    bm.normal_update()
    return finish(bm, name, mat, group)

def cyl(name, c, r, h, mat, group='FURN', seg=32, r2=None, caps=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)
    for v in bm.verts: v.co += Vector(c)
    bm.normal_update()
    return finish(bm, name, mat, group)

def quad(name, pts, mat, group):
    bm = bmesh.new(); vs = [bm.verts.new(p) for p in pts]; bm.faces.new(vs); bm.normal_update()
    return finish(bm, name, mat, group)


# ---------------------------------------------------------------- CC0 glTF props (Poly Haven, via ../cc0-assets)
CC0 = os.path.abspath(os.path.join(LANE, '..', 'cc0-assets', 'assets', 'models'))
PROPS = bpy.data.collections.new('Props'); scene.collection.children.link(PROPS)
REALTIME = []   # props drawn live in three.js (still present in the bake as shadow casters)
def cc0(aid, loc, rotz=0.0, scale=1.0, baked=True):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(CC0, aid, aid + '.gltf'))
    new = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new('cc0_' + aid, None); scene.collection.objects.link(root)
    root.location = loc; root.rotation_euler = (0, 0, rotz); root.scale = (scale,) * 3
    for o in new:
        if o.parent is None: o.parent = root
    bpy.context.view_layer.update()
    meshes = []
    for o in new:
        if o.type == 'MESH':
            mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
            for c in list(o.users_collection): c.objects.unlink(o)
            (ROOM if baked else PROPS).objects.link(o)
            o['grp'] = 'FURN'; meshes.append(o)
    for o in new:
        if o.type != 'MESH': bpy.data.objects.remove(o)
    bpy.data.objects.remove(root)
    if not baked:
        REALTIME.append({'id': aid, 'pos': [loc[0], loc[2], -loc[1]], 'rotY': rotz, 'scale': scale})
    return meshes

# ---------------------------------------------------------------- shell
OUT = os.environ.get('BAKED_OUT') or os.path.join(LANE, 'baked', 'next')
GEN = os.path.join(LANE, 'blender', 'gen'); os.makedirs(GEN, exist_ok=True)
SKY = (2.6, 6.0, 4.75, 7.25)          # skylight strip over the lounge pit (x0, x1, y0, y1)
quad('Floor', [(0, 0, 0), (RW, 0, 0), (RW, RD, 0), (0, RD, 0)], 'Parquet', 'FLOOR')
_sx0, _sx1, _sy0, _sy1 = SKY
for _n, (_a, _b, _c, _d) in enumerate(((0, RW, 0, _sy0), (0, RW, _sy1, RD), (0, _sx0, _sy0, _sy1), (_sx1, RW, _sy0, _sy1))):
    quad(f'CeilingPlane{_n}', [(_a, _c, RH), (_a, _d, RH), (_b, _d, RH), (_b, _c, RH)], 'Ceiling', 'CEIL')
# solid walls: west (x=0) and south (y=0)
quad('WallW', [(0, 0, 0), (0, RD, 0), (0, RD, RH), (0, 0, RH)], 'Plaster', 'WALLS')
quad('WallS', [(0, 0, 0), (0, 0, RH), (RW, 0, RH), (RW, 0, 0)], 'Plaster', 'WALLS')
box('BaseW', (0.01, RD / 2, 0.05), (0.02, RD, 0.10), 'Plaster', 'WALLS')
box('BaseS', (RW / 2, 0.01, 0.05), (RW, 0.02, 0.10), 'Plaster', 'WALLS')
# oak slat feature wall behind the big watch screen (west wall, y 2.5..9.5)
for i in range(70):
    y = 2.5 + i * 0.1
    box(f'Slat{i}', (0.035, y, RH / 2), (0.05, 0.045, RH - 0.02), 'Oak', 'WALLS')
# elevator core doors on the south wall
for k, x0 in enumerate((3.0, 5.2)):
    box(f'DoorFrame{k}', (x0 + 0.6, 0.03, 1.25), (1.4, 0.06, 2.5), 'Bronze', 'WALLS')
    box(f'Door{k}', (x0 + 0.6, 0.065, 1.2), (1.2, 0.02, 2.4), 'Stone', 'WALLS')
for i in range(13):
    x = i * 1.5
    box(f'MulN{i}', (x, RD - 0.07, RH / 2), (0.06, 0.14, RH), 'Bronze', 'WALLS')
for i in range(9):
    y = i * 1.5
    box(f'MulE{i}', (RW - 0.07, y, RH / 2), (0.14, 0.06, RH), 'Bronze', 'WALLS')
box('SillN', (RW / 2, RD - 0.07, 0.03), (RW, 0.14, 0.06), 'Bronze', 'WALLS')
box('SillE', (RW - 0.07, RD / 2, 0.03), (0.14, RD, 0.06), 'Bronze', 'WALLS')
box('HeadN', (RW / 2, RD - 0.07, RH - 0.04), (RW, 0.14, 0.08), 'Bronze', 'WALLS')
box('HeadE', (RW - 0.07, RD / 2, RH - 0.04), (0.14, RD, 0.08), 'Bronze', 'WALLS')
box('ColNE', (RW - 0.25, RD - 0.25, RH / 2), (0.5, 0.5, RH), 'Plaster', 'WALLS', bevel=0.01)
# dropped soffit band along the solid walls with a (dimmer) cove light slot
box('SoffitW', (0.6, RD / 2, RH - 0.15), (1.2, RD, 0.3), 'Ceiling', 'CEIL')
box('SoffitS', (RW / 2, 0.6, RH - 0.15), (RW, 1.2, 0.3), 'Ceiling', 'CEIL')
box('CoveW', (1.25, RD / 2 + 0.6, RH - 0.28), (0.03, RD - 1.2, 0.02), 'EmitCove', 'EMIT')
box('CoveS', (RW / 2 + 0.6, 1.25, RH - 0.28), (RW - 1.2, 0.03, 0.02), 'EmitCove', 'EMIT')

# downlights (r4: cut to ~35%): sparse, dim ambient only; each zone gets its own warm pool from pendants/lamps (zones.py)
LIGHTS = []
def downlight(x, y, z, power=60.0, size=95):
    cyl(f'DLtrim_{x:.1f}_{y:.1f}', (x, y, z - 0.004), 0.055, 0.008, 'EmitDown', 'EMIT', seg=24)
    ld = bpy.data.lights.new(f'DL_{x}_{y}', 'SPOT'); ld.energy = power; ld.spot_size = math.radians(size)
    ld.spot_blend = 0.6; ld.shadow_soft_size = 0.04; ld.color = (1.0, 0.50, 0.20)   # r5: ~3000 K
    ob = bpy.data.objects.new(ld.name, ld); ob.location = (x, y, z - 0.01); ROOM.objects.link(ob)
    LIGHTS.append(ob)
# r5: ambient cut to ~12% of the original (26 / 22-30 / 16 W); only the art accents stay brighter (narrow, on the canvases)
for y in (2.0, 10.4):
    downlight(0.55, y, RH - 0.3, 3.5, 60)      # grazers on the slats either side of the screen
for x, pw, cone in ((1.45, 14, 45), (7.4, 2.5, 60), (12.65, 14, 45), (15.6, 16, 45)):
    downlight(x, 0.55, RH - 0.3, pw, cone)      # 1.45 / 12.65 / 15.6 = picture accents on the south-wall art
for (x, y) in ((8.6, 3.2), (12.4, 3.4), (13.0, 7.8), (16.4, 7.6)):
    downlight(x, y, RH, 2, 90)
# cool dusk fill through the glass (gives the shadows a blue cast -> warm pools read against it)
for nm, loc, rot, sx, sy in (('SkyFillN', (RW / 2, RD + 0.6, 2.0), (math.radians(90), 0, 0), RW, 3.0),
                              ('SkyFillE', (RW + 0.6, RD / 2, 2.0), (math.radians(90), 0, math.radians(-90)), RD, 3.0)):
    ld = bpy.data.lights.new(nm, 'AREA'); ld.shape = 'RECTANGLE'; ld.size = sx; ld.size_y = sy
    ld.energy = 55; ld.color = (0.42, 0.52, 1.0)   # r5: ~20% of r4 (was the flat 'daylight')
    lo = bpy.data.objects.new(nm, ld); lo.location = loc; lo.rotation_euler = rot; ROOM.objects.link(lo)
    lo.visible_camera = False; lo.visible_glossy = False

# ---------------------------------------------------------------- CC0 decor kept from v1
cc0('hanging_picture_frame_02', (0.012, 1.5, 1.7), -math.pi / 2, 1.6)
LAMPS = []   # realtime accent lights for three.js: {pos (three coords), color, intensity, distance}

def desk_lamp_emitters():
    """CC0 desk lamps: make the bulb/shade material a real emitter and put a small spot under each shade."""
    for m in bpy.data.materials:
        if m.name.startswith('desk_lamp_arm_01_light') and m.node_tree:
            b = m.node_tree.nodes.get('Principled BSDF')
            if b:
                b.inputs['Emission Color'].default_value = (1.0, 0.56, 0.26, 1)
                b.inputs['Emission Strength'].default_value = 8.0
    k = 0
    for o in list(ROOM.objects):
        if o.type != 'MESH' or not o.material_slots: continue
        idx = [i for i, sl in enumerate(o.material_slots) if sl.material and sl.material.name.startswith('desk_lamp_arm_01_light')]
        if not idx: continue
        pts = [o.matrix_world @ o.data.vertices[v].co for p in o.data.polygons if p.material_index in idx for v in p.vertices]
        if not pts: continue
        c = sum(pts, Vector()) / len(pts)
        ld = bpy.data.lights.new(f'DeskLamp{k}', 'SPOT'); ld.energy = 34; ld.spot_size = math.radians(90); ld.spot_blend = 0.75
        ld.shadow_soft_size = 0.02; ld.color = (1.0, 0.46, 0.15)
        lo = bpy.data.objects.new(ld.name, ld); lo.location = (c.x, c.y, c.z - 0.10); ROOM.objects.link(lo)
        LAMPS.append({'name': ld.name, 'pos': [c.x, c.z - 0.10, -c.y], 'color': [1.0, 0.46, 0.15], 'intensity': 1.0, 'distance': 1.6})
        k += 1
    print('DESK LAMPS', k)

# ---------------------------------------------------------------- social-lounge zoning (zones.py)
import zones
SEATS = zones.furnish(globals())
desk_lamp_emitters()

# ---------------------------------------------------------------- city (procedural Manhattan, see city.py)
TOWER = (-24.0, RW, -30.0, RD)   # our own tower footprint (room is its NE corner)
import city
N_BLDG, N_CITY_FACES = city.build(scene, CITY, H, TOWER)

# camera rig used for the probe/pano and the tour stills
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'None'

import json
os.makedirs(OUT, exist_ok=True)
json.dump(REALTIME, open(os.path.join(OUT, 'props.json'), 'w'), indent=1)
json.dump(LAMPS, open(os.path.join(OUT, 'lamps.json'), 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(LANE, 'blender', 'scene.blend'))
print('BUILD OK seats', len(SEATS), 'objects', len(OBJS), 'buildings', N_BLDG, 'faces city', N_CITY_FACES)

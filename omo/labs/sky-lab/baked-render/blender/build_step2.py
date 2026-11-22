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
principled('EmitDown', emit=(1.0, 0.80, 0.58), emit_strength=40.0)
for _k in range(3): principled(f'EmitScreen{_k}', emit=(0.45, 0.55, 0.70), emit_strength=1.6)
principled('EmitShade', emit=(1.0, 0.72, 0.45), emit_strength=8.0)
principled('EmitStrip', emit=(1.0, 0.78, 0.55), emit_strength=18.0)

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

def cyl(name, c, r, h, mat, group='FURN', seg=32, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)
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
quad('Floor', [(0, 0, 0), (RW, 0, 0), (RW, RD, 0), (0, RD, 0)], 'Parquet', 'FLOOR')
quad('CeilingPlane', [(0, 0, RH), (0, RD, RH), (RW, RD, RH), (RW, 0, RH)], 'Ceiling', 'CEIL')
# solid walls: west (x=0) and south (y=0)
quad('WallW', [(0, 0, 0), (0, RD, 0), (0, RD, RH), (0, 0, RH)], 'Plaster', 'WALLS')
quad('WallS', [(0, 0, 0), (0, 0, RH), (RW, 0, RH), (RW, 0, 0)], 'Plaster', 'WALLS')
# baseboards
box('BaseW', (0.01, RD / 2, 0.05), (0.02, RD, 0.10), 'Plaster', 'WALLS')
box('BaseS', (RW / 2, 0.01, 0.05), (RW, 0.02, 0.10), 'Plaster', 'WALLS')
# feature wall of vertical oak slats on west wall (y from 2.5 to 9.5)
for i in range(70):
    y = 2.5 + i * 0.1
    box(f'Slat{i}', (0.035, y, RH / 2), (0.05, 0.045, RH - 0.02), 'Oak', 'WALLS')
# elevator core doors on south wall: two bronze-framed recesses
for k, x0 in enumerate((3.0, 5.2)):
    box(f'DoorFrame{k}', (x0 + 0.6, 0.03, 1.25), (1.4, 0.06, 2.5), 'Bronze', 'WALLS')
    box(f'Door{k}', (x0 + 0.6, 0.065, 1.2), (1.2, 0.02, 2.4), 'Stone', 'WALLS')
# curtain-wall mullions on north (y=RD) and east (x=RW) glass
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

# ceiling: dropped soffit band along the solid walls with a cove light slot
box('SoffitW', (0.6, RD / 2, RH - 0.15), (1.2, RD, 0.3), 'Ceiling', 'CEIL')
box('SoffitS', (RW / 2, 0.6, RH - 0.15), (RW, 1.2, 0.3), 'Ceiling', 'CEIL')
box('CoveW', (1.25, RD / 2 + 0.6, RH - 0.28), (0.03, RD - 1.2, 0.02), 'EmitStrip', 'EMIT')
box('CoveS', (RW / 2 + 0.6, 1.25, RH - 0.28), (RW - 1.2, 0.03, 0.02), 'EmitStrip', 'EMIT')

# downlights (visible trims + real spot lights)
LIGHTS = []
def downlight(x, y, z, power=60.0, size=95):
    cyl(f'DLtrim_{x:.1f}_{y:.1f}', (x, y, z - 0.004), 0.055, 0.008, 'EmitDown', 'EMIT', seg=24)
    ld = bpy.data.lights.new(f'DL_{x}_{y}', 'SPOT'); ld.energy = power; ld.spot_size = math.radians(size)
    ld.spot_blend = 0.6; ld.shadow_soft_size = 0.04; ld.color = (1.0, 0.82, 0.62)
    ob = bpy.data.objects.new(ld.name, ld); ob.location = (x, y, z - 0.01); ROOM.objects.link(ob)
    LIGHTS.append(ob)
for y in (2.4, 4.8, 7.2, 9.6):
    downlight(0.55, y, RH - 0.3, 45, 70)       # wall washers -> scallops on slats
for x in (2.5, 7.0, 11.5, 16.0):
    downlight(x, 0.55, RH - 0.3, 45, 70)
for x in (3.5, 7.5, 11.5, 15.5):
    for y in (3.8, 7.6, 10.6):
        if (x, y) in ((15.5, 10.6),):
            continue
        downlight(x, y, RH, 35, 100)

# ---------------------------------------------------------------- desks (3) facing south, user sits on north side
SCREENS = []
def desk(k, cx, cy):
    top = 0.79
    cc0('metal_office_desk', (cx, cy, 0), 0.0)
    # monitor: faces -y (south) toward the seated user. Screen front at y = my - 0.016
    mx, my, mz = cx, cy + 0.12, top + 0.42
    box(f'MonBezel{k}', (mx, my, mz), (0.72, 0.03, 0.43), 'Plastic', bevel=0.006)
    s = quad(f'Screen{k}', [(mx - 0.345, my - 0.016, mz - 0.2), (mx + 0.345, my - 0.016, mz - 0.2), (mx + 0.345, my - 0.016, mz + 0.2), (mx - 0.345, my - 0.016, mz + 0.2)], f'EmitScreen{k}', 'EMIT')
    SCREENS.append(s)
    box(f'MonNeck{k}', (mx, my + 0.05, top + 0.15), (0.05, 0.03, 0.3), 'BlackMetal')
    box(f'MonBase{k}', (mx, my + 0.02, top + 0.006), (0.25, 0.18, 0.012), 'BlackMetal', bevel=0.003)
    box(f'Keyb{k}', (cx - 0.05, cy - 0.2, top + 0.01), (0.44, 0.14, 0.02), 'Plastic', bevel=0.004)
    box(f'Mouse{k}', (cx + 0.3, cy - 0.2, top + 0.012), (0.06, 0.1, 0.025), 'Plastic', bevel=0.01)
    cyl(f'Mug{k}', (cx - 0.6, cy - 0.15, top + 0.05), 0.04, 0.1, 'Ceramic', seg=24)
    box(f'Notebook{k}', (cx + 0.55, cy - 0.05, top + 0.008), (0.21, 0.29, 0.016), ['BookA', 'BookB', 'BookC'][k], bevel=0.002)
    cc0('desk_lamp_arm_01', (cx + 0.78, cy + 0.22, top), math.radians(200))
    # chair on the south side; the user faces north (toward the glass)
    cc0('dining_chair_02', (cx + 0.05, cy - 0.72, 0), math.radians(180 + (k - 1) * 6))
for k, cx in enumerate((4.2, 7.6, 11.0)):
    desk(k, cx, 5.0)
# linear pendant above the desk row
box('PendantBar', (7.6, 5.0, 2.55), (8.0, 0.08, 0.05), 'BlackMetal')
box('PendantDiffuser', (7.6, 5.0, 2.523), (7.9, 0.05, 0.006), 'EmitStrip', 'EMIT')
for x in (3.8, 11.4):
    box(f'PendantWire{x}', (x, 5.0, 2.98), (0.01, 0.01, 0.84), 'BlackMetal')
pl = bpy.data.lights.new('PendantLight', 'AREA'); pl.shape = 'RECTANGLE'; pl.size = 7.9; pl.size_y = 0.05
pl.energy = 220; pl.color = (1.0, 0.85, 0.68)
plo = bpy.data.objects.new('PendantLight', pl); plo.location = (7.6, 5.0, 2.515); ROOM.objects.link(plo)

# ---------------------------------------------------------------- lounge (NE corner)
LX, LY = 13.2, 7.4
box('Rug', (15.0, 9.2, 0.006), (4.2, 3.2, 0.012), 'Rug')
cc0('sofa_02', (15.0, 7.55, 0), math.pi, 1.25)          # faces +y (north glass)
cc0('mid_century_lounge_chair', (13.35, 9.5, 0), math.radians(70))
cc0('modern_arm_chair_01', (16.85, 9.45, 0), math.radians(-75))
cc0('coffee_table_round_01', (15.1, 9.35, 0), 0.0, 0.85)
cc0('Ottoman_01', (15.0, 10.75, 0), 0.0)
cc0('ceramic_vase_01', (15.0, 9.3, 0.415), 0.0, 0.8)
# standing meeting spot in the SE glass corner + extra lounge pieces (all CC0, all baked)
cc0('round_wooden_table_01', (15.9, 2.6, 0), 0.3)
for _i, _a in enumerate((0.4, 2.5, 4.4)):
    cc0('bar_chair_round_01', (15.9 + math.cos(_a) * 0.95, 2.6 + math.sin(_a) * 0.95, 0), _a + math.pi / 2)
cc0('side_table_01', (16.95, 7.45, 0), 0.0)
cc0('modern_ceiling_lamp_01', (15.1, 9.35, RH - 1.19), 0.0)
cc0('hanging_picture_frame_02', (12.4, 0.012, 1.75), math.pi, 2.4)
cc0('hanging_picture_frame_02', (0.012, 1.5, 1.7), -math.pi / 2, 1.6)
# floor lamps: marble base, black pole, warm fabric drum shade (emissive) + a real bulb light for the bake
LAMPS = []   # realtime accent lights for three.js: {pos (three coords), color, intensity, distance}
def floor_lamp(k, x, y, h=1.62):
    cyl(f'LampBase{k}', (x, y, 0.02), 0.17, 0.04, 'Marble', seg=48)
    cyl(f'LampPole{k}', (x, y, h / 2), 0.011, h, 'BlackMetal', seg=12)
    cyl(f'LampShade{k}', (x, y, h + 0.02), 0.21, 0.32, 'EmitShade', 'EMIT', seg=48, r2=0.19)
    cyl(f'LampCap{k}', (x, y, h + 0.185), 0.19, 0.008, 'BlackMetal', seg=48)
    lp = bpy.data.lights.new(f'FloorLamp{k}', 'POINT'); lp.energy = 60; lp.shadow_soft_size = 0.12; lp.color = (1.0, 0.70, 0.42)
    lo = bpy.data.objects.new(lp.name, lp); lo.location = (x, y, h - 0.02); ROOM.objects.link(lo)
    LAMPS.append({'name': lp.name, 'pos': [x, h - 0.02, -y], 'color': [1.0, 0.70, 0.42], 'intensity': 2.2, 'distance': 3.5})
floor_lamp(0, 12.9, 7.0)
floor_lamp(1, 17.25, 10.55)

def desk_lamp_emitters():
    """CC0 desk lamps: make the bulb/shade material a real emitter and put a small spot under each shade."""
    for m in bpy.data.materials:
        if m.name.startswith('desk_lamp_arm_01_light') and m.node_tree:
            b = m.node_tree.nodes.get('Principled BSDF')
            if b:
                b.inputs['Emission Color'].default_value = (1.0, 0.78, 0.52, 1)
                b.inputs['Emission Strength'].default_value = 25.0
    k = 0
    for o in list(ROOM.objects):
        if o.type != 'MESH' or not o.material_slots: continue
        idx = [i for i, sl in enumerate(o.material_slots) if sl.material and sl.material.name.startswith('desk_lamp_arm_01_light')]
        if not idx: continue
        pts = [o.matrix_world @ o.data.vertices[v].co for p in o.data.polygons if p.material_index in idx for v in p.vertices]
        if not pts: continue
        c = sum(pts, Vector()) / len(pts)
        # spot sits just under the shade mouth (inside the shade it would be occluded) and throws a warm pool on the desk
        ld = bpy.data.lights.new(f'DeskLamp{k}', 'SPOT'); ld.energy = 30; ld.spot_size = math.radians(100); ld.spot_blend = 0.75
        ld.shadow_soft_size = 0.02; ld.color = (1.0, 0.78, 0.52)
        lo = bpy.data.objects.new(ld.name, ld); lo.location = (c.x, c.y, c.z - 0.10); ROOM.objects.link(lo)
        LAMPS.append({'name': ld.name, 'pos': [c.x, c.z - 0.10, -c.y], 'color': [1.0, 0.78, 0.52], 'intensity': 1.1, 'distance': 1.6})
        k += 1
    print('DESK LAMPS', k)

# credenza along west wall slats (CC0 cabinet, back to the wall)
cc0('modern_wooden_cabinet', (0.40, 6.0, 0), math.radians(90))
cc0('book_encyclopedia_set_01', (0.40, 5.3, 0.68), 0.0, 1.0, baked=False)
cc0('brass_vase_01', (0.42, 7.0, 0.68), 0.0, 0.75)
cc0('ceramic_vase_01', (0.42, 6.5, 0.68), 0.0, 0.9)

# ---------------------------------------------------------------- plants
def plant(name, x, y, pot_r=0.22, pot_h=0.45, leaves=140, height=1.5, spread=0.55, kind='ficus'):
    cyl(name + 'Pot', (x, y, pot_h / 2), pot_r, pot_h, 'Pot', seg=40, r2=pot_r * 0.82)
    cyl(name + 'Soil', (x, y, pot_h - 0.03), pot_r * 0.92, 0.02, 'DarkWood', seg=32)
    bm = bmesh.new(); bm2 = bmesh.new()
    rnd = random.Random(hash(name) & 0xffff)
    if kind == 'snake':
        for i in range(leaves):
            ang = rnd.random() * 6.283; r0 = rnd.random() * pot_r * 0.6
            bx, by = x + math.cos(ang) * r0, y + math.sin(ang) * r0
            hh = height * (0.5 + 0.5 * rnd.random()); w = 0.035 + 0.02 * rnd.random()
            lean = 0.15 * rnd.random(); la = rnd.random() * 6.283; tw = rnd.random() * 3.14
            prev = None
            for s in range(6):
                f = s / 5.0; ww = w * (1 - f ** 2.5) + 0.002
                cx = bx + math.cos(la) * lean * f * f; cy = by + math.sin(la) * lean * f * f; cz = pot_h + hh * f
                dx, dy = math.cos(tw + f) * ww, math.sin(tw + f) * ww
                a = bm.verts.new((cx - dx, cy - dy, cz)); b = bm.verts.new((cx + dx, cy + dy, cz))
                if prev: bm.faces.new((prev[0], prev[1], b, a))
                prev = (a, b)
    else:
        trunk_top = pot_h + height * 0.55
        bmesh.ops.create_cone(bm2, cap_ends=True, segments=8, radius1=0.02, radius2=0.012, depth=trunk_top - pot_h)
        for v in bm2.verts: v.co += Vector((x, y, (pot_h + trunk_top) / 2))
        for i in range(leaves):
            u = rnd.random(); ang = rnd.random() * 6.283
            r = spread * math.sqrt(rnd.random()) * (0.4 + 0.6 * math.sin(math.pi * min(1, u * 1.1)))
            cx, cy = x + math.cos(ang) * r, y + math.sin(ang) * r
            cz = trunk_top + (u - 0.35) * height * 0.75
            L = 0.16 + 0.08 * rnd.random(); W = L * 0.55
            yaw = ang + rnd.uniform(-0.8, 0.8); pitch = rnd.uniform(-0.9, 0.3)
            dirv = Vector((math.cos(yaw) * math.cos(pitch), math.sin(yaw) * math.cos(pitch), math.sin(pitch)))
            side = dirv.cross(Vector((0, 0, 1))); side.normalize() if side.length > 1e-4 else None
            up = side.cross(dirv)
            base = Vector((cx, cy, cz)) - dirv * L * 0.5
            pts = [base, base + dirv * L * 0.35 + side * W * 0.5 + up * 0.02, base + dirv * L, base + dirv * L * 0.35 - side * W * 0.5 + up * 0.02]
            vs = [bm.verts.new(p) for p in pts]; bm.faces.new(vs)
    bm.normal_update()
    finish(bm, name + 'Leaves', 'Leaf' if kind != 'snake' else 'LeafLight', 'FURN')
    if kind != 'snake':
        bm2.normal_update(); finish(bm2, name + 'Trunk', 'DarkWood', 'FURN')
cc0('pachira_aquatica_01', (12.35, 11.1, 0), 0.4, 1.0, baked=False)
cc0('potted_plant_01', (1.0, 10.8, 0), 1.1, 1.25, baked=False)
cc0('potted_plant_02', (17.3, 6.7, 0), 0.0, 1.3, baked=False)
cc0('calathea_orbifolia_01', (2.2, 5.0, 0), 0.7, 1.4, baked=False)
cc0('potted_plant_02', (13.0, 5.0, 0), 2.0, 1.0, baked=False)
cc0('potted_plant_04', (4.2 - 0.62, 5.0 + 0.22, 0.79), 0.0, 1.0, baked=False)
cc0('potted_plant_04', (11.0 - 0.62, 5.0 + 0.22, 0.79), 1.0, 1.0, baked=False)

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
os.makedirs(os.path.join(LANE, 'baked'), exist_ok=True)
json.dump(REALTIME, open(os.path.join(LANE, 'baked', 'props.json'), 'w'), indent=1)
json.dump(LAMPS, open(os.path.join(LANE, 'baked', 'lamps.json'), 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(LANE, 'blender', 'scene.blend'))
print('BUILD OK objects', len(OBJS), 'buildings', N_BLDG, 'faces city', N_CITY_FACES)

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
principled('EmitScreen', emit=(0.55, 0.68, 0.85), emit_strength=2.5)
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
    top = 0.74
    box(f'DeskTop{k}', (cx, cy, top - 0.015), (1.7, 0.8, 0.03), 'Walnut', bevel=0.004)
    for sx in (-1, 1):
        box(f'DeskLeg{k}{sx}', (cx + sx * 0.8, cy, (top - 0.03) / 2), (0.04, 0.7, top - 0.03), 'BlackMetal')
        box(f'DeskFoot{k}{sx}', (cx + sx * 0.8, cy, 0.01), (0.05, 0.72, 0.02), 'BlackMetal')
    box(f'DeskBar{k}', (cx, cy + 0.3, top - 0.08), (1.6, 0.03, 0.06), 'BlackMetal')
    # monitor: faces -y (south). Screen front at y = cy - 0.06
    mx, my, mz = cx, cy + 0.05, top + 0.42
    box(f'MonBezel{k}', (mx, my, mz), (0.72, 0.03, 0.43), 'Plastic', bevel=0.006)
    s = quad(f'Screen{k}', [(mx - 0.345, my - 0.016, mz - 0.2), (mx + 0.345, my - 0.016, mz - 0.2), (mx + 0.345, my - 0.016, mz + 0.2), (mx - 0.345, my - 0.016, mz + 0.2)], 'EmitScreen', 'EMIT')
    SCREENS.append(s)
    box(f'MonNeck{k}', (mx, my + 0.05, top + 0.15), (0.05, 0.03, 0.3), 'BlackMetal')
    box(f'MonBase{k}', (mx, my + 0.02, top + 0.006), (0.25, 0.18, 0.012), 'BlackMetal', bevel=0.003)
    # keyboard + mouse + mug + notebook
    box(f'Keyb{k}', (cx - 0.05, cy - 0.2, top + 0.01), (0.44, 0.14, 0.02), 'Plastic', bevel=0.004)
    box(f'Mouse{k}', (cx + 0.3, cy - 0.2, top + 0.012), (0.06, 0.1, 0.025), 'Plastic', bevel=0.01)
    cyl(f'Mug{k}', (cx - 0.6, cy - 0.15, top + 0.05), 0.04, 0.1, 'Ceramic', seg=24)
    box(f'Notebook{k}', (cx + 0.55, cy - 0.05, top + 0.008), (0.21, 0.29, 0.016), ['BookA', 'BookB', 'BookC'][k], bevel=0.002)
    # chair (on north side of desk, user faces south)
    chx, chy = cx, cy - 0.78
    box(f'ChairSeat{k}', (chx, chy, 0.47), (0.5, 0.48, 0.08), 'FabricCharcoal', bevel=0.03, seg=3)
    box(f'ChairBack{k}', (chx, chy - 0.27, 0.82), (0.46, 0.06, 0.55), 'FabricCharcoal', bevel=0.025, seg=3)
    box(f'ChairSpine{k}', (chx, chy - 0.3, 0.55), (0.06, 0.03, 0.2), 'BlackMetal')
    cyl(f'ChairGas{k}', (chx, chy, 0.27), 0.025, 0.34, 'Chrome', seg=16)
    for a in range(5):
        ang = a * 2 * math.pi / 5 + k
        bx, by = chx + math.cos(ang) * 0.17, chy + math.sin(ang) * 0.17
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            x, y, z = v.co.x * 0.34, v.co.y * 0.04, v.co.z * 0.03
            v.co = Vector((chx + x * math.cos(ang) - y * math.sin(ang) + math.cos(ang) * 0.17, chy + x * math.sin(ang) + y * math.cos(ang) + math.sin(ang) * 0.17, 0.08 + z))
        bm.normal_update(); finish(bm, f'ChairLeg{k}{a}', 'BlackMetal', 'FURN')
        cyl(f'Caster{k}{a}', (chx + math.cos(ang) * 0.33, chy + math.sin(ang) * 0.33, 0.03), 0.025, 0.05, 'Plastic', seg=12)
for k, cx in enumerate((4.2, 7.6, 11.0)):
    desk(k, cx, 5.0)
# linear pendant above the desk row
box('PendantBar', (7.6, 5.0, 2.55), (8.0, 0.08, 0.05), 'BlackMetal')
box('PendantDiffuser', (7.6, 5.0, 2.523), (7.9, 0.05, 0.006), 'EmitStrip', 'EMIT')
for x in (3.8, 11.4):
    box(f'PendantWire{x}', (x, 5.0, 2.98), (0.004, 0.004, 0.84), 'BlackMetal')
pl = bpy.data.lights.new('PendantLight', 'AREA'); pl.shape = 'RECTANGLE'; pl.size = 7.9; pl.size_y = 0.05
pl.energy = 220; pl.color = (1.0, 0.85, 0.68)
plo = bpy.data.objects.new('PendantLight', pl); plo.location = (7.6, 5.0, 2.515); ROOM.objects.link(plo)

# ---------------------------------------------------------------- lounge (NE corner)
LX, LY = 13.2, 7.4
box('Rug', (15.0, 9.2, 0.006), (4.2, 3.2, 0.012), 'Rug')
# L-sofa: back along x (south side, facing north to the glass) + return along y on west side
box('SofaBase', (15.0, 7.65, 0.22), (3.4, 0.95, 0.3), 'FabricOat', bevel=0.04, seg=3)
box('SofaBack', (15.0, 7.25, 0.58), (3.4, 0.22, 0.48), 'FabricOat', bevel=0.08, seg=4)
box('SofaRet', (13.55, 9.0, 0.22), (0.95, 2.0, 0.3), 'FabricOat', bevel=0.04, seg=3)
box('SofaRetBack', (13.15, 9.1, 0.58), (0.22, 2.2, 0.48), 'FabricOat', bevel=0.08, seg=4)
for i in range(3):
    box(f'Cushion{i}', (14.0 + i * 1.08, 7.75, 0.43), (1.02, 0.8, 0.14), 'FabricOat', bevel=0.06, seg=4)
for i in range(2):
    box(f'CushionR{i}', (13.6, 8.65 + i * 0.95, 0.43), (0.8, 0.9, 0.14), 'FabricOat', bevel=0.06, seg=4)
box('Throw', (16.2, 7.35, 0.75), (0.45, 0.16, 0.42), 'Leather', bevel=0.06, seg=4)
cyl('CoffeeTop', (15.2, 9.4, 0.38), 0.6, 0.04, 'Marble', seg=64)
cyl('CoffeeBase', (15.2, 9.4, 0.18), 0.35, 0.36, 'BlackMetal', seg=48)
cyl('Vase', (15.0, 9.3, 0.5), 0.07, 0.2, 'Ceramic', seg=32, r2=0.05)
box('TrayBook1', (15.45, 9.55, 0.415), (0.3, 0.22, 0.03), 'BookB', bevel=0.003)
box('TrayBook2', (15.43, 9.57, 0.44), (0.26, 0.2, 0.025), 'BookA', bevel=0.003)
# lounge chair facing sofa
box('LChairSeat', (16.8, 10.6, 0.3), (0.8, 0.8, 0.22), 'Leather', bevel=0.06, seg=4)
box('LChairBack', (17.15, 10.75, 0.62), (0.18, 0.8, 0.5), 'Leather', bevel=0.07, seg=4)
for dx in (-0.35, 0.35):
    for dy in (-0.35, 0.35):
        box(f'LChairLeg{dx}{dy}', (16.8 + dx, 10.6 + dy, 0.1), (0.03, 0.03, 0.2), 'BlackMetal')
# floor lamp (arc) near sofa corner
cyl('LampBase', (12.9, 7.0, 0.02), 0.18, 0.04, 'Marble', seg=48)
cyl('LampPole', (12.9, 7.0, 0.85), 0.012, 1.7, 'BlackMetal', seg=12)
cyl('LampShade', (12.9, 7.0, 1.62), 0.22, 0.3, 'EmitShade', 'EMIT', seg=48, r2=0.16)
lp = bpy.data.lights.new('LampLight', 'POINT'); lp.energy = 40; lp.shadow_soft_size = 0.12; lp.color = (1.0, 0.7, 0.42)
lpo = bpy.data.objects.new('LampLight', lp); lpo.location = (12.9, 7.0, 1.55); ROOM.objects.link(lpo)

# credenza along west wall slats with books
box('Credenza', (0.45, 6.0, 0.36), (0.45, 3.6, 0.6), 'DarkWood', bevel=0.005)
box('CredTop', (0.45, 6.0, 0.675), (0.48, 3.64, 0.03), 'Marble', bevel=0.003)
for i in range(9):
    h = 0.2 + 0.07 * random.random()
    box(f'Book{i}', (0.45, 4.6 + i * 0.045, 0.69 + h / 2), (0.16, 0.035, h), random.choice(['BookA', 'BookB', 'BookC']), bevel=0.002)
cyl('VaseCred', (0.45, 7.2, 0.86), 0.09, 0.34, 'Ceramic', seg=32, r2=0.06)

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
plant('PlantA', 12.4, 11.2, leaves=260, height=1.8, spread=0.6)
plant('PlantB', 17.3, 6.6, pot_r=0.2, pot_h=0.5, leaves=45, height=1.1, kind='snake')
plant('PlantC', 1.0, 10.8, pot_r=0.26, pot_h=0.55, leaves=220, height=1.6, spread=0.55)
plant('PlantD', 2.0, 5.2, pot_r=0.16, pot_h=0.38, leaves=35, height=0.8, kind='snake')
plant('PlantE', 0.5, 6.6, pot_r=0.12, pot_h=0.2, leaves=60, height=0.35, spread=0.22)
# move plant E onto the credenza
for ob, g in OBJS:
    if ob.name.startswith('PlantE'):
        ob.location.z = 0.69

# ---------------------------------------------------------------- city
def haze_wrap(m, nb, shader_out):
    out = m.node_tree.nodes.get('Material Output') or nb.node('ShaderNodeOutputMaterial')
    cam = nb.node('ShaderNodeCameraData')
    fac = nb.math('SUBTRACT', 1.0, nb.math('EXPONENT', nb.math('MULTIPLY', cam.outputs['View Distance'], -1.0 / 2600.0)))
    fac = nb.math('MULTIPLY', fac, 0.85)
    em = nb.node('ShaderNodeEmission'); em.inputs[0].default_value = (0.30, 0.24, 0.30, 1); em.inputs[1].default_value = 0.35
    mix = nb.node('ShaderNodeMixShader'); nb.link(fac, mix.inputs[0]); nb.link(shader_out, mix.inputs[1]); nb.link(em.outputs[0], mix.inputs[2])
    nb.link(mix.outputs[0], out.inputs[0])

def building_mat():
    m = bpy.data.materials.new('Building'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); nb = NB(nt)
    out = nb.node('ShaderNodeOutputMaterial')
    geo = nb.node('ShaderNodeNewGeometry'); attr = nb.node('ShaderNodeAttribute', attribute_name='bid')
    bid = attr.outputs['Fac']
    px, py, pz = nb.sep(geo.outputs['Position']); nx, ny, nz = nb.sep(geo.outputs['Normal'])
    facing_y = nb.math('GREATER_THAN', nb.math('ABSOLUTE', ny), nb.math('ABSOLUTE', nx))
    s = nb.mixf(facing_y, py, px)
    colw = nb.mixf(nb.math('GREATER_THAN', bid, 0.5), 1.5, 2.1)
    floor_h = nb.mixf(nb.math('GREATER_THAN', nb.math('FRACT', nb.math('MULTIPLY', bid, 7.0)), 0.5), 3.6, 4.2)
    cs = nb.math('DIVIDE', s, colw); cv = nb.math('DIVIDE', pz, floor_h)
    fx = nb.math('FRACT', cs); fy = nb.math('FRACT', cv)
    curtain = nb.math('GREATER_THAN', nb.math('FRACT', nb.math('MULTIPLY', bid, 13.0)), 0.55)
    wx = nb.math('MAXIMUM', nb.between(fx, 0.14, 0.86), curtain)
    wy = nb.between(fy, nb.mixf(curtain, 0.22, 0.08), 0.86)
    win = nb.math('MULTIPLY', wx, wy)
    cell = nb.comb(nb.math('FLOOR', cs), nb.math('FLOOR', cv), nb.math('MULTIPLY', bid, 1000.0))
    nv, ncol = nb.noise(cell)
    nv2, _ = nb.noise(nb.vmath('ADD', cell, (17.3, 5.1, 2.7)))
    thr = nb.math('ADD', 0.35, nb.math('MULTIPLY', nb.math('FRACT', nb.math('MULTIPLY', bid, 31.0)), 0.5))
    lit = nb.math('MULTIPLY', nb.math('GREATER_THAN', nv, thr), win)
    facade = nb.math('LESS_THAN', nb.math('ABSOLUTE', nz), 0.5)
    lit = nb.math('MULTIPLY', lit, facade)
    warm = nb.mixc(nb.math('POWER', nv2, 2.0), (1.0, 0.62, 0.32, 1), (0.85, 0.92, 1.0, 1))
    inten = nb.math('ADD', 1.0, nb.math('MULTIPLY', nv2, 5.0))
    # crowns: top 6 m of tall buildings glow
    tall = nb.math('GREATER_THAN', bid, 0.93)
    emis = nb.math('MULTIPLY', lit, inten)
    bsdf = nb.node('ShaderNodeBsdfPrincipled')
    wallc = nb.mixc(nb.math('FRACT', nb.math('MULTIPLY', bid, 3.7)), (0.05, 0.05, 0.055, 1), (0.16, 0.14, 0.12, 1))
    glass = (0.012, 0.014, 0.018, 1)
    nb.link(nb.mixc(win, wallc, glass), bsdf.inputs['Base Color'])
    nb.link(nb.mixf(win, 0.85, 0.12), bsdf.inputs['Roughness'])
    nb.link(warm, bsdf.inputs['Emission Color']); nb.link(emis, bsdf.inputs['Emission Strength'])
    haze_wrap(m, nb, bsdf.outputs[0])
    return m

def road_mat(name, along_x):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); nb = NB(nt)
    out = nb.node('ShaderNodeOutputMaterial')
    geo = nb.node('ShaderNodeNewGeometry'); px, py, pz = nb.sep(geo.outputs['Position'])
    a = px if along_x else py
    attr = nb.node('ShaderNodeAttribute', attribute_name='across'); c = attr.outputs['Fac']  # -1..1 across road
    hw = nb.node('ShaderNodeAttribute', attribute_name='halfw').outputs['Fac']
    cm = nb.math('MULTIPLY', c, hw)  # metres from centreline
    lane = nb.math('FLOOR', nb.math('DIVIDE', cm, 3.3))
    lanec = nb.math('ADD', nb.math('MULTIPLY', lane, 3.3), 1.65)
    dl = nb.math('ABSOLUTE', nb.math('SUBTRACT', cm, lanec))
    # cars: 7 m cells, 55% occupied
    cell = nb.math('FLOOR', nb.math('DIVIDE', a, 7.5))
    nv, _ = nb.noise(nb.comb(cell, lane, 3.0 if along_x else 9.0))
    occ = nb.math('GREATER_THAN', nv, 0.5)
    fa = nb.math('FRACT', nb.math('DIVIDE', a, 7.5))
    inlane = nb.math('LESS_THAN', nb.math('ABSOLUTE', nb.math('SUBTRACT', nb.math('ABSOLUTE', nb.math('SUBTRACT', cm, lanec)), 0.7)), 0.22)
    head = nb.math('MULTIPLY', nb.math('MULTIPLY', inlane, occ), nb.math('LESS_THAN', fa, 0.12))
    tail = nb.math('MULTIPLY', nb.math('MULTIPLY', inlane, occ), nb.math('GREATER_THAN', fa, 0.55))
    tail = nb.math('MULTIPLY', tail, nb.math('LESS_THAN', fa, 0.62))
    pos = nb.math('GREATER_THAN', cm, 0.0)
    whitel = nb.math('MULTIPLY', head, pos); redl = nb.math('MULTIPLY', tail, nb.math('SUBTRACT', 1.0, pos))
    whitel = nb.math('ADD', whitel, nb.math('MULTIPLY', nb.math('MULTIPLY', head, 0.0), 1.0))
    # car bodies
    body = nb.math('MULTIPLY', nb.math('MULTIPLY', occ, nb.math('LESS_THAN', dl, 0.95)), nb.math('LESS_THAN', fa, 0.62))
    # street lights every 32 m at both kerbs
    sl_a = nb.math('ABSOLUTE', nb.math('SUBTRACT', nb.math('FRACT', nb.math('DIVIDE', a, 32.0)), 0.5))
    sl_c = nb.math('ABSOLUTE', nb.math('SUBTRACT', nb.math('ABSOLUTE', c), 0.93))
    dist = nb.math('SQRT', nb.math('ADD', nb.math('POWER', nb.math('MULTIPLY', sl_a, 32.0), 2.0), nb.math('POWER', nb.math('MULTIPLY', sl_c, hw), 2.0)))
    lamp = nb.math('LESS_THAN', dist, 0.6)
    pool = nb.math('EXPONENT', nb.math('MULTIPLY', dist, -0.35))
    bsdf = nb.node('ShaderNodeBsdfPrincipled')
    nb.link(nb.mixc(body, (0.018, 0.018, 0.02, 1), (0.08, 0.08, 0.09, 1)), bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.55
    emc = nb.vmath('ADD', nb.vmath('SCALE', nb.comb(1.0, 0.95, 0.85), None), None) if False else None
    # emission colour/strength
    e_white = nb.math('MULTIPLY', whitel, 14.0); e_red = nb.math('MULTIPLY', redl, 9.0)
    e_lamp = nb.math('ADD', nb.math('MULTIPLY', lamp, 30.0), nb.math('MULTIPLY', pool, 0.55))
    col = nb.vmath('ADD', nb.vmath('ADD', nb.vmath('MULTIPLY', nb.comb(e_white, e_white, e_white), (1.0, 0.95, 0.85)), nb.vmath('MULTIPLY', nb.comb(e_red, e_red, e_red), (1.0, 0.06, 0.03))), nb.vmath('MULTIPLY', nb.comb(e_lamp, e_lamp, e_lamp), (1.0, 0.62, 0.32)))
    nb.link(col, bsdf.inputs['Emission Color']); bsdf.inputs['Emission Strength'].default_value = 1.0
    haze_wrap(m, nb, bsdf.outputs[0])
    return m

MB = building_mat(); MRx = road_mat('RoadEW', True); MRy = road_mat('RoadNS', False)
MG = bpy.data.materials.new('Ground'); MG.use_nodes = True
MG.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.03, 0.03, 0.032, 1)
MG.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
MW = bpy.data.materials.new('Water'); MW.use_nodes = True
MW.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.005, 0.007, 0.01, 1)
MW.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.06
for mm in (MG, MW):
    nb = NB(mm.node_tree); haze_wrap(mm, nb, mm.node_tree.nodes['Principled BSDF'].outputs[0])

AV0, AVS, AVW = 38.0, 260.0, 30.0     # avenue centre x0, spacing, width (run along y)
ST0, STS, STW = 25.0, 80.0, 18.0      # street centre y0, spacing, width (run along x)
R = 2600.0
RIVER_E, RIVER_W = 1150.0, -1500.0
G = -H

bmB = bmesh.new(); bidL = bmB.faces.layers.float.new('bid')
def add_bldg(x0, x1, y0, y1, h, bid):
    vs = [bmB.verts.new(p) for p in [(x0, y0, G), (x1, y0, G), (x1, y1, G), (x0, y1, G), (x0, y0, G + h), (x1, y0, G + h), (x1, y1, G + h), (x0, y1, G + h)]]
    for f in [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)]:
        fa = bmB.faces.new([vs[i] for i in f]); fa[bidL] = bid

TOWER = (-24.0, RW, -30.0, RD)   # our own tower footprint (room is its NE corner)
rnd = random.Random(42)
nA = int(R / AVS) + 2; nS = int(R / STS) + 2
for i in range(-nA, nA):
    xa = AV0 + i * AVS + AVW / 2; xb = AV0 + (i + 1) * AVS - AVW / 2
    for j in range(-nS, nS):
        ya = ST0 + j * STS + STW / 2; yb = ST0 + (j + 1) * STS - STW / 2
        cxm, cym = (xa + xb) / 2, (ya + yb) / 2
        d = math.hypot(cxm, cym)
        if d > R: continue
        east = cxm > RIVER_E; west = cxm < RIVER_W
        if (RIVER_E - 120 < cxm < RIVER_E + 350) or (RIVER_W - 300 < cxm < RIVER_W + 120):
            continue  # rivers
        # park: a dark rectangle to the north-west
        if -700 < cxm < -200 and 600 < cym < 1800:
            continue
        x = xa + 4
        while x < xb - 6:
            w = rnd.uniform(18, 46); x2 = min(x + w, xb - 4)
            for (y0, y1) in ((ya + 4, cym - 1), (cym + 1, yb - 4)) if rnd.random() < 0.7 else ((ya + 4, yb - 4),):
                if not (x2 < TOWER[0] - 6 or x > TOWER[1] + 6 or y1 < TOWER[2] - 6 or y0 > TOWER[3] + 6):
                    continue
                bid = rnd.random()
                if east or west:
                    h = rnd.uniform(12, 45) * (1.4 if rnd.random() < 0.15 else 1.0)
                else:
                    near = math.exp(-d / 1400.0)
                    h = 15 + rnd.lognormvariate(3.4, 0.55) * (0.6 + 0.8 * near)
                    if rnd.random() < 0.06 + 0.06 * near:
                        h = rnd.uniform(180, 420); bid = 0.93 + 0.07 * rnd.random()
                    if d < 320: h = min(h, 120 + d * 0.2)
                inset = rnd.uniform(0, 2.5)
                add_bldg(x + inset, x2 - inset, y0 + inset, y1 - inset, h, bid)
                if h > 120 and rnd.random() < 0.6:   # setback tier
                    s = (x2 - x) * 0.2
                    add_bldg(x + s, x2 - s, y0 + s * 0.6, y1 - s * 0.6, h * rnd.uniform(1.05, 1.18), bid)
            x = x2 + rnd.uniform(0.5, 3)
meB = bpy.data.meshes.new('City'); bmB.to_mesh(meB); bmB.free(); meB.materials.append(MB)
obB = bpy.data.objects.new('City', meB); CITY.objects.link(obB)
# our own tower below the room (separate object so the panorama can hide it)
bmB = bmesh.new(); bidL = bmB.faces.layers.float.new('bid')
add_bldg(TOWER[0], TOWER[1], TOWER[2], TOWER[3], H - 0.6, 0.31)
meT = bpy.data.meshes.new('OwnTower'); bmB.to_mesh(meT); bmB.free(); meT.materials.append(MB)
obT = bpy.data.objects.new('OwnTower', meT); CITY.objects.link(obT)

def road_mesh(name, along_x, mat):
    bm = bmesh.new(); acr = bm.verts.layers.float.new('across') if False else None
    me = bpy.data.meshes.new(name)
    verts, faces, across, halfw = [], [], [], []
    if along_x:
        for j in range(-nS, nS + 1):
            yc = ST0 + j * STS
            if abs(yc) > R: continue
            hw = STW / 2
            base = len(verts)
            verts += [(-R, yc - hw, G + 0.05), (R, yc - hw, G + 0.05), (R, yc + hw, G + 0.05), (-R, yc + hw, G + 0.05)]
            across += [-1, -1, 1, 1]; halfw += [hw] * 4
            faces.append((base, base + 1, base + 2, base + 3))
    else:
        for i in range(-nA, nA + 1):
            xc = AV0 + i * AVS
            if abs(xc) > R or RIVER_E - 120 < xc < RIVER_E + 350 or RIVER_W - 300 < xc < RIVER_W + 120: continue
            hw = AVW / 2
            base = len(verts)
            verts += [(xc - hw, -R, G + 0.06), (xc + hw, -R, G + 0.06), (xc + hw, R, G + 0.06), (xc - hw, R, G + 0.06)]
            across += [-1, 1, 1, -1]; halfw += [hw] * 4
            faces.append((base, base + 1, base + 2, base + 3))
    me.from_pydata(verts, [], faces)
    a1 = me.attributes.new('across', 'FLOAT', 'POINT'); a2 = me.attributes.new('halfw', 'FLOAT', 'POINT')
    for k in range(len(verts)): a1.data[k].value = across[k]; a2.data[k].value = halfw[k]
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me); CITY.objects.link(ob)
road_mesh('RoadsEW', True, MRx); road_mesh('RoadsNS', False, MRy)
mg = bpy.data.meshes.new('Ground'); mg.from_pydata([(-R * 1.5, -R * 1.5, G), (R * 1.5, -R * 1.5, G), (R * 1.5, R * 1.5, G), (-R * 1.5, R * 1.5, G)], [], [(0, 1, 2, 3)]); mg.materials.append(MG)
og = bpy.data.objects.new('Ground', mg); CITY.objects.link(og)
for nm, (xa, xb) in (('RiverE', (RIVER_E - 120, RIVER_E + 350)), ('RiverW', (RIVER_W - 300, RIVER_W + 120))):
    mw = bpy.data.meshes.new(nm); mw.from_pydata([(xa, -R * 1.5, G + 0.1), (xb, -R * 1.5, G + 0.1), (xb, R * 1.5, G + 0.1), (xa, R * 1.5, G + 0.1)], [], [(0, 1, 2, 3)]); mw.materials.append(MW)
    ow = bpy.data.objects.new(nm, mw); CITY.objects.link(ow)

# ---------------------------------------------------------------- sky (blue hour)
w = bpy.data.worlds.new('Dusk'); scene.world = w; w.use_nodes = True; nt = w.node_tree; nt.nodes.clear(); nb = NB(nt)
out = nb.node('ShaderNodeOutputWorld')
tc = nb.node('ShaderNodeTexCoord'); dx, dy, dz = nb.sep(tc.outputs['Generated'])
elev = nb.math('ARCSINE', nb.math('MINIMUM', nb.math('MAXIMUM', dz, -1.0), 1.0))
sundir = nb.math('ADD', nb.math('MULTIPLY', dx, -0.92), nb.math('MULTIPLY', dy, 0.38))  # sun set to the WNW
sunf = nb.math('POWER', nb.math('MAXIMUM', nb.math('ADD', nb.math('MULTIPLY', sundir, 0.5), 0.5), 0.0), 3.0)
t = nb.math('POWER', nb.math('MAXIMUM', elev, 0.0), 0.55)
grad = nb.mixc(nb.math('MINIMUM', nb.math('MULTIPLY', t, 1.4), 1.0), (0.30, 0.30, 0.48, 1), (0.025, 0.04, 0.11, 1))
glow = nb.math('MULTIPLY', nb.math('EXPONENT', nb.math('MULTIPLY', nb.math('MAXIMUM', elev, 0.0), -14.0)), nb.math('ADD', 0.25, nb.math('MULTIPLY', sunf, 1.6)))
glowc = nb.vmath('MULTIPLY', nb.comb(glow, glow, glow), (1.0, 0.42, 0.18))
sky = nb.vmath('ADD', grad, glowc)
below = nb.math('LESS_THAN', elev, 0.0)
sky = nb.mixc(below, sky, (0.20, 0.16, 0.20, 1))
bg = nb.node('ShaderNodeBackground'); nb.link(sky, bg.inputs[0]); bg.inputs[1].default_value = 1.0
nb.link(bg.outputs[0], out.inputs[0])

# camera rig used for the probe/pano and the tour stills
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'None'

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(LANE, 'blender', 'scene.blend'))
print('BUILD OK objects', len(OBJS), 'faces city', len(meB.polygons))

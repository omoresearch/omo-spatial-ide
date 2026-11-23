# Social-lounge zoning (look lane, 22 Nov): replaces the office layout of build.py v1 + dress.py.
#   West   : lounge: U sectional (7 places) + coffee table + rug, ~3.8 m from and facing the big
#            watch screen on the oak-slat wall  -> empty 'watchscreen_anchor' (+Z into the room, w 4.6, h 2.6)
#   NW     : reading nook (lounge chair + ottoman + floor lamp + bookshelf + rug + plant)
#   NE     : window bench (3 places) on the glass
#   Centre : bar island (3 m stone/wood counter, 4 stools, back-lit bottle shelf, 2 pendants)
#   E      : 4-seat round dining table by the east glass
#   North  : work studio: 3 clean walnut desks (EmitScreen0/1/2 kept, desk-1 at x 7.6 for the live/mp tests), pendant, slat ceiling
#   East   : two window armchairs + side table lamp
#   Ceiling: skylight strip over the pit showing the starry dusk sky (hole cut in build.py)
# Every seat place exports an empty 'seat_<n>' (+Z = facing in three.js, userData.kind/zone/seat_h).
# Plants are real CC0 models, every one in a pot; single variants are cut out of the CC0 multi-plant files and
# exported as baked/plant_<key>.glb for the live three.js draw (probe-lit), and stay in the bake as shadow casters.
import bpy, bmesh, math, os, random
import numpy as np
from mathutils import Vector, Matrix
from dress import rug_texture, canvas_texture, uv_fit, _blur, _save


def _fabric(A, name, base, seed, n=512, weave=0.05, mott=0.35):
    rs = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n] / n
    fib = _blur(rs.random((n, n)), 1, n=1) - 0.5
    mot = _blur(rs.random((n, n)), 20) - 0.5
    wv = 0.5 + 0.5 * np.sin(x * n * 0.5 * np.pi) * np.sin(y * n * 0.5 * np.pi)
    k = 1 + fib[..., None] * 0.30 + mot[..., None] * mott + (wv[..., None] - 0.5) * weave
    return os.path.join(A, _save(A, name, np.ones((n, n, 3)) * np.array(base) * k))


def _screen_tex(A, name, w=1024, h=576):
    """Ambient 'idle' frame for the watch screen: plum -> teal wash with a soft glow, no text, no logos."""
    y, x = np.mgrid[0:h, 0:w]; u = x / w; v = y / h
    plum = np.array((0.30, 0.10, 0.36)); teal = np.array((0.06, 0.32, 0.36)); amber = np.array((0.62, 0.34, 0.16))
    t = np.clip(u * 0.75 + v * 0.35, 0, 1)[..., None]
    col = plum * (1 - t) + teal * t
    g = np.exp(-(((u - 0.32) / 0.22) ** 2 + ((v - 0.62) / 0.30) ** 2))[..., None]
    col = col * (1 - 0.45 * g) + amber * 0.45 * g
    vig = (1 - 0.55 * (((u - 0.5) * 1.8) ** 2 + ((v - 0.5) * 1.8) ** 2)).clip(0.25, 1)[..., None]
    return os.path.join(A, _save(A, name, col * vig))


def furnish(B):
    box, cyl, principled, cc0, finish = B['box'], B['cyl'], B['principled'], B['cc0'], B['finish']
    MATS, LAMPS, ROOM, PROPS, RH, scene, OUT = B['MATS'], B['LAMPS'], B['ROOM'], B['PROPS'], B['RH'], B['scene'], B['OUT']
    A = B['GEN']   # generated textures live in blender/gen (absolute paths)
    REALTIME, CC0 = B['REALTIME'], B['CC0']
    rnd = random.Random(23)
    G = lambda n: os.path.join(A, n)
    SEATS = []

    mk = bpy.data.collections.get('Markers') or bpy.data.collections.new('Markers')
    if mk.name not in scene.collection.children: scene.collection.children.link(mk)

    def empty(name, loc, rotz, props):
        e = bpy.data.objects.new(name, None); e.empty_display_type = 'ARROWS'; e.empty_display_size = 0.3
        e.location = loc; e.rotation_euler = (0, 0, rotz)
        for k, v in props.items(): e[k] = v
        mk.objects.link(e); return e

    def face_rot(d):
        """Blender z-rotation so that the object's local -Y points along world d (= three.js local +Z)."""
        return math.atan2(d[0], -d[1])

    def seat(x, y, z, d, kind, zone):
        SEATS.append((x, y, z, d, kind, zone))

    def light(name, kind, loc, energy, color, rt=None, **kw):
        ld = bpy.data.lights.new(name, kind); ld.energy = energy; ld.color = color
        ld.shadow_soft_size = kw.get('soft', 0.08)
        if kind == 'SPOT':
            ld.spot_size = math.radians(kw.get('cone', 100)); ld.spot_blend = kw.get('blend', 0.7)
        if kind == 'AREA':
            ld.shape = 'RECTANGLE'; ld.size = kw.get('sx', 1.0); ld.size_y = kw.get('sy', 0.05)
        lo = bpy.data.objects.new(name, ld); lo.location = loc; ROOM.objects.link(lo)
        if 'rotx' in kw: lo.rotation_euler = (kw['rotx'], 0, kw.get('rotz', 0))
        if kind == 'AREA': lo.visible_camera = False; lo.visible_glossy = False   # light only, no visible panel
        if rt:
            LAMPS.append({'name': name, 'pos': [loc[0], loc[2], -loc[1]], 'color': list(color), 'intensity': rt[0], 'distance': rt[1]})

    # rotated box: size in the local frame, rotated by ang about z around its centre
    def rbox(name, c, s, ang, mat, group='FURN', bevel=0.0, seg=2):
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts: v.co = Vector((v.co.x * s[0], v.co.y * s[1], v.co.z * s[2]))
        if bevel > 0: bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=seg, profile=0.5, affect='EDGES')
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(ang, 3, 'Z'))
        for v in bm.verts: v.co += Vector(c)
        bm.normal_update(); return finish(bm, name, mat, group)

    class Frame:
        """Local furniture frame: local +Y = the way the piece faces; ang = world rotation."""
        def __init__(self, cx, cy, d):
            self.c = Vector((cx, cy)); n = math.hypot(*d); self.d = (d[0] / n, d[1] / n)
            self.ang = math.atan2(-self.d[0], self.d[1])
        def p(self, lx, ly, z=0.0):
            ca, sa = math.cos(self.ang), math.sin(self.ang)
            return (self.c.x + lx * ca - ly * sa, self.c.y + lx * sa + ly * ca, z)

    # ------------------------------------------------------------------ materials
    principled('VelvetTeal', diff=_fabric(A, 'gen_velvet_teal', (0.07, 0.27, 0.28), 31), rough=0.82, tile=0.9)
    principled('VelvetMustard', diff=_fabric(A, 'gen_velvet_mustard', (0.56, 0.36, 0.08), 32), rough=0.85, tile=0.9)
    principled('VelvetRust', diff=_fabric(A, 'gen_velvet_rust', (0.46, 0.15, 0.07), 33), rough=0.85, tile=0.9)
    principled('VelvetPlum', diff=_fabric(A, 'gen_velvet_plum', (0.25, 0.08, 0.20), 34), rough=0.85, tile=0.9)
    principled('Boucle', diff=_fabric(A, 'gen_boucle_oat', (0.66, 0.60, 0.50), 35, weave=0.14, mott=0.2), rough=1.0, tile=0.6)
    principled('RugPit', diff=G(rug_texture(A, 'gen_rug_pit', (0.58, 0.50, 0.40), (0.30, 0.16, 0.10), (0.72, 0.60, 0.42), 36, bw=0.06)), rough=1.0)
    principled('RugNook', diff=G(rug_texture(A, 'gen_rug_nook', (0.28, 0.12, 0.20), (0.18, 0.08, 0.13), (0.70, 0.52, 0.30), 37, bw=0.08)), rough=1.0)
    principled('RugOat', diff=G(rug_texture(A, 'gen_rug_oat', (0.60, 0.54, 0.45), (0.16, 0.15, 0.15), (0.60, 0.54, 0.45), 1)), rough=1.0)
    principled('RugCharcoal', diff=G(rug_texture(A, 'gen_rug_charcoal', (0.36, 0.31, 0.25), (0.22, 0.17, 0.13), (0.62, 0.52, 0.36), 2, bw=0.04)), rough=1.0)
    principled('RugSlate', diff=G(rug_texture(A, 'gen_rug_slate', (0.46, 0.40, 0.33), (0.30, 0.20, 0.14), (0.72, 0.62, 0.44), 3, bw=0.05)), rough=1.0)
    principled('CanvasB', diff=G(canvas_texture(A, 'gen_canvas_b', (0.80, 0.76, 0.66),
               [(0.10, 0.58, 0.12, 0.88, (0.06, 0.10, 0.20), 0.04), (0.64, 0.90, 0.40, 0.88, (0.74, 0.52, 0.16), 0.04)], 5, w=1024, h=700)), rough=0.85)
    principled('Bottle', color=(0.05, 0.09, 0.05), rough=0.12)
    principled('BottleClear', color=(0.50, 0.52, 0.46), rough=0.06)
    principled('BottleBlue', color=(0.03, 0.07, 0.16), rough=0.08)
    principled('BottleRed', color=(0.30, 0.03, 0.03), rough=0.08)
    principled('LeatherTan', color=(0.38, 0.18, 0.07), rough=0.5)
    principled('Linen', diff=_fabric(A, 'gen_linen_rust', (0.50, 0.20, 0.09), 38, weave=0.18, mott=0.15), rough=1.0, tile=0.5)
    principled('RugBar', diff=G(rug_texture(A, 'gen_rug_bar', (0.42, 0.20, 0.12), (0.20, 0.09, 0.06), (0.74, 0.56, 0.32), 39, bw=0.05)), rough=1.0)
    principled('CanvasW', diff=G(canvas_texture(A, 'gen_canvas_w', (0.74, 0.66, 0.54),
               [(0.12, 0.52, 0.10, 0.62, (0.56, 0.20, 0.08), 0.05), (0.40, 0.90, 0.48, 0.90, (0.10, 0.20, 0.22), 0.05), (0.20, 0.70, 0.70, 0.86, (0.82, 0.62, 0.24), 0.03)], 7, w=700, h=1024)), rough=0.85)
    principled('CanvasE', diff=G(canvas_texture(A, 'gen_canvas_e', (0.20, 0.17, 0.15),
               [(0.08, 0.92, 0.55, 0.92, (0.62, 0.30, 0.12), 0.06), (0.30, 0.70, 0.12, 0.45, (0.80, 0.70, 0.52), 0.04)], 9, w=760, h=1024)), rough=0.85)
    principled('BottleAmber', color=(0.30, 0.12, 0.03), rough=0.12)
    principled('BookD', color=(0.62, 0.58, 0.50), rough=0.8)
    principled('BookE', color=(0.12, 0.20, 0.16), rough=0.8)
    principled('ScreenGlass', color=(0.004, 0.004, 0.005), rough=0.12)
    principled('EmitBarUnder', emit=(1.0, 0.48, 0.16), emit_strength=6.0)
    principled('EmitCandle', emit=(1.0, 0.55, 0.20), emit_strength=30.0)
    principled('Wax', color=(0.82, 0.76, 0.66), rough=0.6)
    principled('PotTerracotta', color=(0.42, 0.20, 0.11), rough=0.85)
    principled('PotStone', color=(0.52, 0.50, 0.46), rough=0.75)
    principled('PotBlack', color=(0.03, 0.03, 0.032), rough=0.5)
    principled('Soil', color=(0.05, 0.035, 0.025), rough=1.0)
    # watch screen: emissive idle frame (image -> emission so it survives the glTF export)
    m = principled('EmitWatch', emit=(1, 1, 1), emit_strength=3.0)
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'UVMap'
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = bpy.data.images.load(_screen_tex(A, 'gen_watch_idle'), check_existing=True)
    nt.links.new(uvn.outputs[0], t.inputs[0]); nt.links.new(t.outputs[0], b.inputs['Emission Color'])

    def rug(name, cx, cy, w, d, mat):
        ob = box(name, (cx, cy, 0.007), (w, d, 0.014), mat, bevel=0.004, seg=1)
        uv_fit(ob, cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2)

    # ------------------------------------------------------------------ upholstered pieces (one coherent soft style)
    def sofa(name, cx, cy, d, seats, mat, pillow_mats, zone, seat_w=0.9, depth=1.0, kind='sofa'):
        F = Frame(cx, cy, d); arm = 0.22; W = seats * seat_w + 2 * arm; D = depth; a = F.ang
        rbox(name + 'Plinth', F.p(0, 0, 0.04), (W - 0.12, D - 0.12, 0.08), a, 'DarkWood')
        if seats >= 3:   # knitted throw draped over one arm
            rbox(name + 'Throw', F.p(W / 2 - arm / 2, 0.05, 0.605), (arm + 0.06, D * 0.7, 0.03), a, 'Boucle', bevel=0.012, seg=2)
            rbox(name + 'ThrowFall', F.p(W / 2 + 0.02, 0.05, 0.36), (0.03, D * 0.7, 0.48), a, 'Boucle', bevel=0.012, seg=2)
        rbox(name + 'Base', F.p(0, 0, 0.19), (W, D, 0.22), a, mat, bevel=0.03, seg=2)
        rbox(name + 'Back', F.p(0, -D / 2 + 0.11, 0.52), (W, 0.22, 0.48), a, mat, bevel=0.05, seg=3)
        for sx in (-1, 1):
            rbox(f'{name}Arm{sx}', F.p(sx * (W / 2 - arm / 2), 0.0, 0.36), (arm, D, 0.48), a, mat, bevel=0.06, seg=3)
        for i in range(seats):
            lx = -W / 2 + arm + seat_w * (i + 0.5)
            rbox(f'{name}Seat{i}', F.p(lx, 0.09, 0.385), (seat_w - 0.025, D - 0.27, 0.15), a, mat, bevel=0.055, seg=3)
            rbox(f'{name}BackC{i}', F.p(lx, -D / 2 + 0.31, 0.64), (seat_w - 0.04, 0.19, 0.40), a + 0.0, mat, bevel=0.075, seg=3)
            sx, sy, _ = F.p(lx, 0.10)
            seat(sx, sy, 0.46, F.d, kind, zone)
        for j, pm in enumerate(pillow_mats):
            sxn = -1 if j == 0 else 1
            rbox(f'{name}Pillow{j}', F.p(sxn * (W / 2 - arm - 0.26), -D / 2 + 0.45, 0.63), (0.42, 0.13, 0.40), a + sxn * 0.18, pm, bevel=0.06, seg=3)
        return F

    # ================================================================== LOUNGE PIT + WATCH SCREEN (west wall)
    SY, SZ, SW_, SH_ = 6.0, 1.72, 4.6, 2.6
    box('WatchBezel', (0.08, SY, SZ), (0.04, SW_ + 0.10, SH_ + 0.10), 'Plastic', bevel=0.006)   # front face x 0.10 < live west wall 0.115
    scr = B['quad']('WatchScreen', [(0.104, SY - SW_ / 2, SZ - SH_ / 2), (0.104, SY + SW_ / 2, SZ - SH_ / 2),
                                    (0.104, SY + SW_ / 2, SZ + SH_ / 2), (0.104, SY - SW_ / 2, SZ + SH_ / 2)], 'EmitWatch', 'EMIT')
    uv_fit(scr, SY - SW_ / 2, SY + SW_ / 2, SZ - SH_ / 2, SZ + SH_ / 2, axes=(1, 2))
    empty('watchscreen_anchor', (0.17, SY, SZ), face_rot((1, 0)),
          {'w': SW_, 'h': SH_, 'wall': 'west', 'note': 'centre of the big wall screen; local +Z faces into the room (three.js)'})
    # low walnut media console under the screen
    box('Console', (0.33, SY, 0.17), (0.48, 3.4, 0.30), 'Walnut', bevel=0.006)
    box('ConsoleKick', (0.33, SY, 0.012), (0.40, 3.3, 0.024), 'BlackMetal')
    cc0('brass_vase_01', (0.33, SY - 1.35, 0.32), 0.0, 0.55)
    cc0('ceramic_vase_01', (0.33, SY + 1.30, 0.32), 0.0, 0.75)
    cc0('book_encyclopedia_set_01', (0.30, SY + 0.45, 0.32), 0.0, 0.9, baked=False)

    rug('RugPitRug', 3.15, 6.0, 4.4, 5.6, 'RugPit')
    # ---- U sectional facing the watch screen: main run x 3.55..4.55 (seats ~3.8 m from the screen), two short returns
    SM = 'VelvetTeal'
    X0, X1, Y0, Y1, XR = 3.55, 4.55, 3.7, 8.3, 2.3       # main run front/back, ends, return open end
    box('SecPlinthM', ((X0 + X1) / 2, 6.0, 0.04), (0.88, Y1 - Y0 - 0.12, 0.08), 'DarkWood')
    box('SecBaseM', ((X0 + X1) / 2, 6.0, 0.19), (X1 - X0, Y1 - Y0, 0.22), SM, bevel=0.03)
    box('SecBackM', (X1 - 0.11, 6.0, 0.52), (0.22, Y1 - Y0, 0.48), SM, bevel=0.05, seg=3)
    for k, sy in enumerate((-1, 1)):
        yb = Y0 if sy < 0 else Y1                  # outer edge of the return
        yc = yb - sy * 0.5                         # return centre line
        box(f'SecPlinthR{k}', ((XR + X0) / 2, yc, 0.04), (X0 - XR - 0.06, 0.88, 0.08), 'DarkWood')
        box(f'SecBaseR{k}', ((XR + X0) / 2, yc, 0.19), (X0 - XR, 1.0, 0.22), SM, bevel=0.03)
        box(f'SecBackR{k}', ((XR + X1 - 0.22) / 2, yb - sy * 0.11, 0.52), (X1 - 0.22 - XR, 0.22, 0.48), SM, bevel=0.05, seg=3)
        box(f'SecArmR{k}', (XR + 0.11, yc, 0.36), (0.22, 1.0, 0.48), SM, bevel=0.06, seg=3)
        # return seat cushion + back cushion (sitter faces into the U)
        rc = yb - sy * (0.22 + 0.04 + 0.365)
        box(f'SecSeatR{k}', ((XR + 0.22 + X0) / 2, rc, 0.385), (X0 - XR - 0.24, 0.73, 0.15), SM, bevel=0.055, seg=3)
        box(f'SecBackCR{k}', ((XR + 0.22 + X0) / 2, yb - sy * 0.31, 0.64), (X0 - XR - 0.26, 0.19, 0.40), SM, bevel=0.075, seg=3)
        seat((XR + 0.22 + X0) / 2, rc, 0.46, (0, -sy), 'sofa', 'lounge')
        # corner cushion (deep, faces the screen on a slight diagonal)
        box(f'SecSeatC{k}', ((X0 + X1 - 0.22) / 2 - 0.03, rc, 0.385), (0.75, 0.73, 0.15), SM, bevel=0.055, seg=3)
        box(f'SecBackCC{k}', ((X0 + X1 - 0.22) / 2, yb - sy * 0.31, 0.64), (0.74, 0.19, 0.40), SM, bevel=0.075, seg=3)
        n = math.hypot(1, 0.3); seat(X0 + 0.38, rc, 0.46, (-1 / n, -sy * 0.3 / n), 'sofa', 'lounge')
    # main run: 3 seats between the corners
    ya, yb_ = Y0 + 0.22 + 0.04 + 0.73, Y1 - 0.22 - 0.04 - 0.73
    sw = (yb_ - ya) / 3
    for i in range(3):
        y = ya + sw * (i + 0.5)
        box(f'SecSeatM{i}', (X0 + 0.04 + 0.365, y, 0.385), (0.73, sw - 0.025, 0.15), SM, bevel=0.055, seg=3)
        box(f'SecBackCM{i}', (X1 - 0.31, y, 0.64), (0.19, sw - 0.04, 0.40), SM, bevel=0.075, seg=3)
        seat(X0 + 0.40, y, 0.46, (-1, 0), 'sofa', 'lounge')
    for j, (pm, y, x) in enumerate((('VelvetMustard', 4.25, 4.18), ('VelvetRust', 4.75, 4.20), ('VelvetRust', 7.25, 4.20), ('VelvetMustard', 7.75, 4.18),
                                    ('VelvetPlum', 6.0, 4.19))):
        rbox(f'SecPillow{j}', (x, y, 0.66), (0.13, 0.42, 0.40), 0.18 * (1 if j % 2 else -1), pm, bevel=0.06, seg=3)
    for k, y in enumerate((3.98, 8.02)):          # pillows on the returns, leaning on the backs
        rbox(f'SecPillowR{k}', (2.85, y + (0.08 if k == 0 else -0.08), 0.66), (0.42, 0.13, 0.40), 0.15, ['VelvetMustard', 'VelvetRust'][k], bevel=0.06, seg=3)
    rbox('SecThrow', (2.41, 4.2, 0.605), (0.28, 0.75, 0.03), 0.0, 'Boucle', bevel=0.012, seg=2)
    rbox('SecThrowFall', (2.29, 4.2, 0.36), (0.03, 0.75, 0.48), 0.0, 'Boucle', bevel=0.012, seg=2)
    # coffee table in the U: walnut top, black frame, tray + candles + books
    CTX, CTY = 2.55, 6.0
    box('CoffeeTop', (CTX, CTY, 0.37), (1.0, 1.5, 0.04), 'Walnut', bevel=0.01)
    box('CoffeeShelf', (CTX, CTY, 0.10), (0.86, 1.36, 0.02), 'Walnut')
    for sx in (-0.45, 0.45):
        for sy in (-0.7, 0.7):
            box(f'CoffeeLeg{sx}{sy}', (CTX + sx, CTY + sy, 0.18), (0.03, 0.03, 0.35), 'BlackMetal')
    box('CoffeeTray', (CTX + 0.05, CTY - 0.25, 0.40), (0.32, 0.55, 0.02), 'Bronze', bevel=0.004)
    for i, (dx, dy, hh) in enumerate(((-0.05, -0.40, 0.14), (0.06, -0.25, 0.10), (-0.04, -0.11, 0.07))):
        cyl(f'Candle{i}', (CTX + 0.05 + dx, CTY + dy, 0.41 + hh / 2), 0.035, hh, 'Wax', seg=20)
        cyl(f'Flame{i}', (CTX + 0.05 + dx, CTY + dy, 0.41 + hh + 0.018), 0.008, 0.03, 'EmitCandle', 'EMIT', seg=8, r2=0.001)
        light(f'CandleLight{i}', 'POINT', (CTX + 0.05 + dx, CTY + dy, 0.41 + hh + 0.05), 3.0, (1.0, 0.50, 0.18), soft=0.02)
    for j, (h, m) in enumerate(((0.035, 'BookC'), (0.03, 'BookD'), (0.025, 'BookB'))):
        box(f'CoffeeBook{j}', (CTX - 0.15, CTY + 0.42, 0.39 + 0.035 * j + h / 2), (0.22 - 0.02 * j, 0.30 - 0.03 * j, h), m, bevel=0.002, seg=1)
    cyl('CoffeeBowl', (CTX + 0.2, CTY + 0.35, 0.43), 0.11, 0.07, 'Ceramic', seg=32, r2=0.06)
    for i, (dx, dy) in enumerate(((0.3, -0.55), (0.22, -0.62), (-0.3, 0.05), (0.32, 0.62))):   # drinks
        cyl(f'Tumbler{i}', (CTX + dx, CTY + dy, 0.39 + 0.045), 0.032, 0.09, 'Ceramic', seg=20, r2=0.036)
    cyl('WineBottle', (CTX - 0.25, CTY - 0.45, 0.39 + 0.15), 0.037, 0.30, 'Bottle', seg=20, r2=0.03)
    rbox('Magazine0', (CTX + 0.2, CTY + 0.05, 0.393), (0.29, 0.22, 0.006), 0.3, 'BookB')
    # side tables + lamps: one at each outer corner of the sectional, plus a sofa-back console with two lamps
    def table_lamp(k, x, y, z, energy=40, rt=(0.8, 2.6), shade='EmitShade'):
        cyl(f'TLampBase{k}', (x, y, z + 0.16), 0.07, 0.32, 'Ceramic', seg=32, r2=0.05)
        cyl(f'TLampShade{k}', (x, y, z + 0.42), 0.17, 0.22, shade, 'EMIT', seg=48, r2=0.15, caps=False)   # r5: open shade
        cyl(f'TLampTop{k}', (x, y, z + 0.528), 0.148, 0.004, 'BlackMetal', seg=48)                       # r5b: closed top, light goes down
        light(f'TableLamp{k}', 'SPOT', (x, y, z + 0.36), energy * 2.4, (1.0, 0.50, 0.18), rt, soft=0.05, cone=150, blend=0.6)
        light(f'TableLampUp{k}', 'POINT', (x, y, z + 0.44), energy * 0.35, (1.0, 0.52, 0.20), soft=0.08)
    for k, y in enumerate((3.25, 8.75)):
        cc0('side_table_01', (4.1, y, 0), 0.0)
        table_lamp(k, 4.1, y, 0.55)
    box('SofaConsole', (4.80, 6.0, 0.36), (0.34, 2.6, 0.04), 'Walnut', bevel=0.006)
    box('SofaConsoleTop', (4.80, 6.0, 0.72), (0.34, 2.6, 0.04), 'Walnut', bevel=0.006)
    for sy in (-1.25, 1.25):
        box(f'SofaConsoleLeg{sy}', (4.80, 6.0 + sy, 0.36), (0.30, 0.04, 0.72), 'BlackMetal')
    for i, y in enumerate((5.3, 6.6)):
        cyl(f'ConsoleVase{i}', (4.80, y, 0.74 + 0.10), 0.06, 0.20, ['Ceramic', 'Bronze'][i], seg=24, r2=0.04)
    table_lamp(3, 4.80, 7.05, 0.74, energy=34)
    table_lamp(4, 4.80, 4.95, 0.74, energy=34)
    # warm floor lamp in the pit's SW corner (away from the screen face)
    def floor_lamp(k, x, y, h=1.62, energy=55, rt=(1.6, 3.2)):
        cyl(f'LampBase{k}', (x, y, 0.02), 0.17, 0.04, 'Marble', seg=48)
        cyl(f'LampPole{k}', (x, y, h / 2), 0.011, h, 'BlackMetal', seg=12)
        cyl(f'LampShade{k}', (x, y, h + 0.02), 0.21, 0.32, 'EmitShade', 'EMIT', seg=48, r2=0.19, caps=False)   # r5: open shade
        cyl(f'LampCap{k}', (x, y, h + 0.178), 0.19, 0.006, 'BlackMetal', seg=48)                           # r5b: closed top
        light(f'FloorLamp{k}', 'SPOT', (x, y, h - 0.06), energy * 1.8, (1.0, 0.50, 0.18), rt, soft=0.06, cone=140, blend=0.6)
        light(f'FloorLampUp{k}', 'POINT', (x, y, h + 0.02), energy * 0.3, (1.0, 0.52, 0.20), soft=0.1)
    floor_lamp(0, 0.85, 2.80, energy=95, rt=(1.4, 3.2))

    # ================================================================== READING NOOK (NW corner)
    rug('RugNookRug', 1.95, 10.72, 2.9, 2.05, 'RugNook')
    nd = (0.82, 0.57)
    cc0('mid_century_lounge_chair', (1.55, 10.55, 0), face_rot(nd))
    seat(1.55 + nd[0] * 0.12, 10.55 + nd[1] * 0.12, 0.46, nd, 'chair', 'nook')
    cc0('Ottoman_01', (1.55 + nd[0] * 0.95, 10.55 + nd[1] * 0.95, 0), face_rot(nd), 0.9)
    floor_lamp(1, 1.08, 11.22, h=1.55, energy=100, rt=(1.8, 3.4))
    cc0('side_table_01', (2.15, 9.85, 0), 0.3)
    cyl('NookMug', (2.08, 9.82, 0.57), 0.04, 0.09, 'Ceramic', seg=24)
    box('NookBook', (2.22, 9.9, 0.565), (0.22, 0.16, 0.03), 'BookC', bevel=0.002, seg=1)
    # bookshelf (west wall, north end): steel frame, oak shelves, books (kept from v1)
    X0, Y0, Y1 = 0.02, 9.65, 11.85
    for y in (Y0, (Y0 + Y1) / 2, Y1):
        box(f'ShelfPost{y:.2f}', (X0 + 0.19, y, 1.3), (0.38, 0.03, 2.6), 'BlackMetal')
    for k, z in enumerate((0.06, 0.50, 0.94, 1.38, 1.82, 2.26)):
        box(f'Shelf{k}', (X0 + 0.19, (Y0 + Y1) / 2, z), (0.36, Y1 - Y0, 0.03), 'Oak', bevel=0.003)
        for (a0, a1) in ((Y0 + 0.03, (Y0 + Y1) / 2 - 0.03), ((Y0 + Y1) / 2 + 0.03, Y1 - 0.03)):
            y = a0 + rnd.uniform(0.0, 0.15)
            while y < a1 - 0.05:
                if rnd.random() < 0.18:
                    if rnd.random() < 0.5:
                        cyl(f'ShelfVase{k}_{y:.2f}', (X0 + 0.19, y + 0.08, z + 0.015 + 0.09), 0.06, 0.18, rnd.choice(['Ceramic', 'Stone', 'Bronze']), seg=24, r2=0.04)
                    y += 0.25; continue
                for _ in range(rnd.randint(5, 14)):
                    t = rnd.uniform(0.022, 0.045); hh = rnd.uniform(0.20, 0.33); dd = rnd.uniform(0.17, 0.24)
                    if y + t > a1: break
                    box(f'Book{k}_{y:.3f}', (X0 + 0.04 + dd / 2, y + t / 2, z + 0.015 + hh / 2), (dd, t, hh),
                        rnd.choice(['BookA', 'BookB', 'BookC', 'BookD', 'BookE', 'Leather']), bevel=0.002, seg=1)
                    y += t + 0.002
                if rnd.random() < 0.35 and y < a1 - 0.25:
                    zz = z + 0.015
                    for _ in range(rnd.randint(2, 4)):
                        hh = rnd.uniform(0.03, 0.05)
                        box(f'Stack{k}_{y:.3f}_{zz:.3f}', (X0 + 0.15, y + 0.13, zz + hh / 2), (0.22, 0.24, hh), rnd.choice(['BookA', 'BookD', 'BookB']), bevel=0.002, seg=1)
                        zz += hh
                    y += 0.3
                y += rnd.uniform(0.02, 0.08)
        # warm LED strip under each shelf (bake only)
        if k >= 1:
            box(f'ShelfLED{k}', (X0 + 0.34, (Y0 + Y1) / 2, z - 0.02), (0.012, Y1 - Y0 - 0.1, 0.006), 'EmitStrip', 'EMIT')

    # ================================================================== WINDOW BENCH (NE glass)
    bx0, bx1, by = 13.2, 17.0, 11.55   # NE glass
    box('BenchBase', ((bx0 + bx1) / 2, by, 0.19), (bx1 - bx0, 0.55, 0.38), 'Walnut', bevel=0.008)
    box('BenchCushion', ((bx0 + bx1) / 2, by - 0.02, 0.43), (bx1 - bx0 - 0.04, 0.52, 0.10), 'Boucle', bevel=0.04, seg=3)
    for i, (x, pm) in enumerate(((bx0 + 0.45, 'VelvetPlum'), (bx0 + 1.75, 'VelvetMustard'), (bx1 - 0.5, 'VelvetTeal'))):
        rbox(f'BenchPillow{i}', (x, by + 0.17, 0.66), (0.44, 0.13, 0.40), 0.12 * (i - 1), pm, bevel=0.06, seg=3)
    for i in range(3):
        x = bx0 + (bx1 - bx0) * (i + 0.5) / 3
        seat(x, by - 0.08, 0.48, (0, -1), 'sofa', 'bench')

    # ================================================================== BAR (centre): 3 m island counter running N-S, stone top, fluted wood front
    # r4b: guests sit on the east side facing west; a low back-lit bottle gantry behind the bartender faces them (and the
    # east tour camera); kept low (1.45 m) so it does not hide the watch screen from the east.
    CX, CY = 11.2, 6.0
    L = 3.0
    box('BarBody', (CX, CY, 0.51), (0.60, L, 1.02), 'Walnut', bevel=0.008)
    box('BarTop', (CX + 0.06, CY, 1.045), (0.76, L + 0.12, 0.05), 'Marble', bevel=0.008)
    y = CY - L / 2 + 0.05
    while y < CY + L / 2 - 0.03:   # vertical fluting on the guest face
        box(f'BarFlute{y:.2f}', (CX + 0.31, y, 0.52), (0.03, 0.045, 0.92), 'DarkWood', bevel=0.008, seg=2)
        y += 0.075
    box('BarKick', (CX + 0.27, CY, 0.04), (0.06, L - 0.04, 0.08), 'Bronze')
    # r5: warm guest-side glow: LED under the stone overhang washing down the fluting + a toe-kick glow on the floor
    UL, UC = L - 0.70, CY + 0.30          # guest face north of the L return
    box('BarUnderLED', (CX + 0.40, UC, 1.012), (0.02, UL, 0.006), 'EmitBarUnder', 'EMIT')
    box('BarToeLED', (CX + 0.305, UC, 0.085), (0.012, UL, 0.008), 'EmitBarUnder', 'EMIT')
    light('BarUnderLight', 'AREA', (CX + 0.40, UC, 1.0), 22, (1.0, 0.48, 0.16), sx=0.06, sy=UL, rotx=0.0)
    light('BarToeLight', 'AREA', (CX + 0.36, UC, 0.09), 8, (1.0, 0.48, 0.16), sx=0.05, sy=UL, rotx=0.0)
    # r5: short L return at the south end (guest side), same stone top + fluting
    LRX0, LRX1, LRY = CX + 0.30, CX + 1.25, CY - L / 2 + 0.30
    box('BarRetBody', ((LRX0 + LRX1) / 2, LRY, 0.51), (LRX1 - LRX0, 0.60, 1.02), 'Walnut', bevel=0.008)
    box('BarRetTop', ((LRX0 + LRX1) / 2 + 0.04, LRY - 0.06, 1.045), (LRX1 - LRX0 + 0.08, 0.76, 0.05), 'Marble', bevel=0.008)
    x_ = LRX0 + 0.06
    while x_ < LRX1 - 0.02:
        box(f'BarRetFlute{x_:.2f}', (x_, LRY - 0.31, 0.52), (0.045, 0.03, 0.92), 'DarkWood', bevel=0.008, seg=2)
        x_ += 0.075
    box('BarRetUnderLED', ((LRX0 + LRX1) / 2, LRY - 0.40, 1.012), (LRX1 - LRX0, 0.02, 0.006), 'EmitBarUnder', 'EMIT')
    light('BarRetUnderLight', 'AREA', ((LRX0 + LRX1) / 2, LRY - 0.40, 1.0), 9, (1.0, 0.48, 0.16), sx=LRX1 - LRX0, sy=0.06, rotx=0.0)
    box('BarFootRail', (CX + 0.42, CY + 0.40, 0.24), (0.035, L - 1.0, 0.035), 'Bronze')
    for sy in (-0.85, 1.25):
        box(f'BarFootPost{sy}', (CX + 0.37, CY + sy, 0.12), (0.10, 0.025, 0.24), 'Bronze')
    box('BarInnerShelf', (CX - 0.22, CY, 0.80), (0.18, L - 0.1, 0.03), 'DarkWood')
    def stool(k, x, y, d):   # r5: light oak legs, tan leather seat, bronze foot ring (no black)
        cyl(f'StoolSeat{k}', (x, y, 0.725), 0.20, 0.06, 'LeatherTan', seg=40, r2=0.19)
        cyl(f'StoolPan{k}', (x, y, 0.685), 0.16, 0.025, 'Oak', seg=32)
        for j in range(4):
            a_ = math.radians(45 + 90 * j)
            rbox(f'StoolLeg{k}{j}', (x + 0.13 * math.cos(a_), y + 0.13 * math.sin(a_), 0.34), (0.03, 0.03, 0.68), a_, 'Oak', bevel=0.006)
        cyl(f'StoolRing{k}', (x, y, 0.27), 0.155, 0.018, 'Bronze', seg=40, caps=False)
        F = Frame(x, y, d)
        rbox(f'StoolBack{k}', F.p(0, -0.17, 0.86), (0.30, 0.03, 0.12), F.ang, 'Oak', bevel=0.01)
        for sx in (-1, 1):
            rbox(f'StoolBackPost{k}{sx}', F.p(sx * 0.12, -0.165, 0.79), (0.025, 0.025, 0.14), F.ang, 'Oak')
        seat(x, y, 0.75, d, 'stool', 'bar')
    for i, sy in enumerate((-0.38, 0.32, 1.02)):
        stool(i, CX + 0.80, CY + sy + rnd.uniform(-0.04, 0.04), (-1, 0))
    stool(3, (LRX0 + LRX1) / 2 + 0.15, LRY - 0.80, (0, 1))   # at the L return, facing north
    for i, (dy, m) in enumerate(((-1.25, 'Bottle'), (-1.12, 'BottleAmber'), (1.2, 'BottleAmber'))):
        cyl(f'TopBottle{i}', (CX - 0.12, CY + dy, 1.07 + 0.15), 0.037, 0.30, m, seg=20, r2=0.022)
    for i, dy in enumerate((-0.75, -0.6, 0.1, 0.65, 0.8)):
        cyl(f'BarGlass{i}', (CX + 0.18 - 0.05 * (i % 2), CY + dy, 1.07 + 0.05), 0.034, 0.10, 'Ceramic', seg=16, r2=0.03)
    cyl('BarCandle', (CX + 0.05, CY - 0.15, 1.07 + 0.045), 0.03, 0.09, 'Wax', seg=16)
    cyl('BarFlame', (CX + 0.05, CY - 0.15, 1.07 + 0.09 + 0.014), 0.007, 0.026, 'EmitCandle', 'EMIT', seg=8, r2=0.001)
    # low back-lit bottle gantry (faces east, toward the stools)
    BX = CX - 1.35
    box('BackBar', (BX, CY, 0.45), (0.46, L - 0.2, 0.90), 'DarkWood', bevel=0.008)
    box('BackBarTop', (BX + 0.01, CY, 0.915), (0.50, L - 0.15, 0.03), 'Marble', bevel=0.004)
    box('BackPanel', (BX - 0.20, CY, 1.18), (0.05, L - 0.2, 0.56), 'DarkWood', bevel=0.004)
    box('BackGlow', (BX - 0.17, CY, 1.18), (0.01, L - 0.36, 0.44), 'EmitBackBar', 'EMIT')
    box('BackCap', (BX - 0.12, CY, 1.475), (0.22, L - 0.15, 0.035), 'Walnut', bevel=0.004)
    box('BarShelf0', (BX - 0.08, CY, 1.10), (0.18, L - 0.3, 0.03), 'Oak', bevel=0.003)
    box('BarShelfLED0', (BX - 0.15, CY, 1.455), (0.012, L - 0.4, 0.006), 'EmitStrip', 'EMIT')
    # r5: varied gantry: bottles of many heights/colours with real necks, plus objects (shaker, glass stacks, bowl, plant, books)
    BMATS = ['BottleAmber', 'BottleAmber', 'BottleClear', 'Bottle', 'BottleBlue', 'BottleRed', 'BottleClear', 'Ceramic']
    for j, (xx, z) in enumerate(((BX - 0.08, 1.115), (BX + 0.10, 0.93))):
        y = CY - L / 2 + 0.22; n_ = 0
        while y < CY + L / 2 - 0.22:
            n_ += 1; roll = rnd.random()
            if j == 1 and roll < 0.30:          # gap on the work counter
                y += rnd.uniform(0.12, 0.25); continue
            if roll < 0.12:                      # cocktail shaker / mixing glass
                cyl(f'Shaker{j}_{y:.2f}', (xx, y, z + 0.11), 0.042, 0.22, 'Chrome', seg=24, r2=0.035)
                y += 0.13; continue
            if roll < 0.20:                      # stack of rocks glasses
                for q in range(3): cyl(f'GlassStack{j}_{y:.2f}_{q}', (xx, y, z + 0.04 + q * 0.075), 0.04, 0.075, 'Ceramic', seg=20, r2=0.044)
                y += 0.13; continue
            if roll < 0.25 and j == 0:           # small bowl of citrus
                cyl(f'BarBowl{y:.2f}', (xx, y + 0.06, z + 0.035), 0.09, 0.07, 'Bronze', seg=32, r2=0.06)
                for q in range(3): cyl(f'Lemon{y:.2f}{q}', (xx - 0.03 + 0.03 * q, y + 0.04 + 0.02 * q, z + 0.08), 0.03, 0.05, 'VelvetMustard', seg=12)
                y += 0.22; continue
            tall = rnd.random() < 0.35
            r = rnd.uniform(0.03, 0.048); hh = rnd.uniform(0.24, 0.34) if tall else rnd.uniform(0.13, 0.22)
            m_ = rnd.choice(BMATS)
            cyl(f'Bottle{j}_{y:.2f}', (xx, y, z + hh * 0.36), r, hh * 0.72, m_, seg=18)
            cyl(f'BottleSh{j}_{y:.2f}', (xx, y, z + hh * 0.76), r, hh * 0.08, m_, seg=18, r2=r * 0.4)
            cyl(f'BottleNk{j}_{y:.2f}', (xx, y, z + hh * 0.90), r * 0.33, hh * 0.20, m_, seg=12)
            y += 2 * r + rnd.uniform(0.02, 0.07)
    cc0('potted_plant_04', (BX + 0.12, CY + 1.12, 0.93), 0.4, 0.8, baked=False)
    for q, m_ in enumerate(('BookC', 'BookD', 'BookB')):
        box(f'BarBook{q}', (BX + 0.10, CY - 1.10, 0.93 + 0.015 + 0.03 * q), (0.20, 0.26 - 0.02 * q, 0.03), m_, bevel=0.002, seg=1)
    # two pendants over the counter
    for i, dy in enumerate((-0.78, 0.78)):
        y = CY + dy
        cyl(f'BarPend{i}', (CX, y, 1.98), 0.17, 0.26, 'EmitShade', 'EMIT', seg=40, r2=0.07, caps=False)
        cyl(f'BarPendTop{i}', (CX, y, 2.108), 0.07, 0.004, 'Bronze', seg=24)
        cyl(f'BarPendCap{i}', (CX, y, 2.115), 0.07, 0.02, 'Bronze', seg=24)
        box(f'BarWire{i}', (CX, y, (RH + 2.12) / 2), (0.005, 0.005, RH - 2.12), 'BlackMetal')
        light(f'BarPendLight{i}', 'SPOT', (CX, y, 1.90), 90, (1.0, 0.52, 0.20), (1.0, 2.8), cone=95, blend=0.5, soft=0.05)
    light('BarGlowLight', 'AREA', (BX - 0.05, CY, 1.18), 45, (1.0, 0.48, 0.16), sx=L - 0.4, sy=0.44, rotx=math.radians(90), rotz=math.radians(-90))   # faces +x (stools)

    rug('RugBarRug', 11.55, 5.85, 4.3, 4.6, 'RugBar')   # r5: anchors the bar as a lounge zone, not a reception desk

    # ================================================================== r5b: reading pair behind the sectional (fills the empty floor; own warm pool)
    rug('RugPair', 5.95, 6.0, 1.9, 2.6, 'RugNook')
    for k, (y, d) in enumerate(((5.15, (0.25, 1.0)), (6.85, (0.25, -1.0)))):
        cc0('mid_century_lounge_chair', (5.85, y, 0), face_rot(d), 0.95)
        seat(5.85 + d[0] * 0.1, y + d[1] * 0.1, 0.44, d, 'chair', 'lounge')
    cc0('side_table_01', (6.25, 6.0, 0), 0.6)
    cyl('PairCup0', (6.20, 5.95, 0.57), 0.04, 0.09, 'Ceramic', seg=24)
    box('PairBook', (6.30, 6.08, 0.565), (0.22, 0.16, 0.03), 'BookE', bevel=0.002, seg=1)
    floor_lamp(2, 5.35, 6.0, h=1.50, energy=70, rt=(1.2, 3.0))

    # ================================================================== r5: two conversation chairs angled at the sectional
    for k, (x, y) in enumerate(((1.45, 3.45), (1.45, 8.55))):
        d = (CTX - x, CTY - y); n = math.hypot(*d); d = (d[0] / n, d[1] / n)
        cc0('modern_arm_chair_01', (x, y, 0), face_rot(d))
        seat(x + d[0] * 0.05, y + d[1] * 0.05, 0.53, d, 'chair', 'lounge')
        F = Frame(x, y, d)   # rust linen throw folded over the chair back
        rbox(f'ChairThrow{k}', F.p(0.12, -0.33, 0.80), (0.42, 0.10, 0.03), F.ang, 'Linen', bevel=0.012, seg=2)
        rbox(f'ChairThrowFall{k}', F.p(0.12, -0.39, 0.62), (0.42, 0.03, 0.36), F.ang, 'Linen', bevel=0.012, seg=2)
    cyl('Pouf0', (2.15, 2.55, 0.21), 0.30, 0.42, 'VelvetMustard', seg=40)
    # extra throws: linen over the north return arm, boucle over the window-bench end
    rbox('SecThrow2', (2.41, 7.8, 0.605), (0.28, 0.70, 0.03), 0.0, 'Linen', bevel=0.012, seg=2)
    rbox('SecThrow2Fall', (2.29, 7.8, 0.36), (0.03, 0.70, 0.48), 0.0, 'Linen', bevel=0.012, seg=2)
    rbox('BenchThrow', (16.55, 11.50, 0.50), (0.60, 0.50, 0.04), 0.1, 'Linen', bevel=0.015, seg=2)

    # ================================================================== r5: walnut sideboard + lamp under the south canvas (a warm pool in a dark gap)
    box('Sideboard', (12.60, 0.26, 0.38), (2.3, 0.44, 0.68), 'Walnut', bevel=0.006)
    box('SideboardKick', (12.60, 0.28, 0.02), (2.2, 0.38, 0.04), 'BlackMetal')
    for q in range(3):
        box(f'SideboardSlot{q}', (12.65 - 0.62 + 0.62 * q, 0.035, 0.40), (0.56, 0.01, 0.56), 'DarkWood', bevel=0.003)
    table_lamp(5, 11.66, 0.27, 0.72, energy=30, rt=(0.7, 2.4))
    cyl('SideVase', (13.50, 0.26, 0.72 + 0.15), 0.07, 0.30, 'PotTerracotta', seg=32, r2=0.045)
    for q, m_ in enumerate(('BookB', 'BookA')):
        box(f'SideBook{q}', (12.75, 0.24, 0.72 + 0.02 + 0.04 * q), (0.26, 0.20, 0.04), m_, bevel=0.002, seg=1)

    # ================================================================== r5: art on the blank walls (canvases + picture accents in build.py)
    def canvas(name, cx, w, h, z, mat):
        ob = box(name, (cx, 0.025, z), (w, 0.04, h), mat, bevel=0.004, seg=1)
        uv_fit(ob, cx + w / 2, cx - w / 2, z - h / 2, z + h / 2, axes=(0, 2))
        box(name + 'Frame', (cx, 0.014, z), (w + 0.05, 0.028, h + 0.05), 'Oak')
    canvas('CanvasW', 1.45, 0.95, 1.36, 1.62, 'CanvasW')
    canvas('CanvasE', 15.6, 1.10, 1.45, 1.62, 'CanvasE')

    # ================================================================== r5: tall open shelving divider screening the work studio from the lounge
    # Runs E-W along the studio's south side (y 8.05), two runs with a 2.0 m opening at x 6.6..8.6 that keeps the
    # live/mp desk-1 sight line (x 7.6, y 4.32 looking north) clear. Open cells, so it screens without walling off.
    DY, DD, DH = 8.05, 0.36, 2.30
    for run, (xa, xb) in enumerate(((4.95, 6.60), (8.60, 10.35))):
        nb_ = int(round((xb - xa) / 0.62)); bw = (xb - xa) / nb_
        for i in range(nb_ + 1):
            box(f'DivPost{run}_{i}', (xa + i * bw, DY, DH / 2), (0.04, DD, DH), 'Walnut', bevel=0.004)
        zs = (0.04, 0.48, 0.92, 1.36, 1.80, 2.26)
        for k, z in enumerate(zs):
            box(f'DivShelf{run}_{k}', ((xa + xb) / 2, DY, z), (xb - xa, DD - 0.02, 0.03), 'Oak', bevel=0.003)
        for i in range(nb_):
            for k, z in enumerate(zs[:-1]):
                c0, c1 = xa + i * bw + 0.03, xa + (i + 1) * bw - 0.03; z0 = z + 0.015
                r_ = rnd.random()
                if r_ < 0.30:      # books, upright, running along x (spines face both rooms)
                    x_ = c0 + rnd.uniform(0, 0.08); end = c1 - rnd.uniform(0.0, 0.18)
                    while x_ < end:
                        t = rnd.uniform(0.022, 0.045); hh = rnd.uniform(0.20, 0.33); dd = rnd.uniform(0.18, 0.26)
                        if x_ + t > end: break
                        box(f'DivBook{run}_{i}_{k}_{x_:.3f}', (x_ + t / 2, DY, z0 + hh / 2), (t, dd, hh),
                            rnd.choice(['BookA', 'BookB', 'BookC', 'BookD', 'BookE', 'Leather']), bevel=0.002, seg=1)
                        x_ += t + 0.002
                elif r_ < 0.42:    # stacked books + object on top
                    zz = z0
                    for _ in range(rnd.randint(3, 5)):
                        hh = rnd.uniform(0.03, 0.05)
                        box(f'DivStack{run}_{i}_{k}_{zz:.3f}', ((c0 + c1) / 2, DY, zz + hh / 2), (0.24, 0.20, hh), rnd.choice(['BookA', 'BookD', 'BookB', 'BookC']), bevel=0.002, seg=1)
                        zz += hh
                    cyl(f'DivOrb{run}_{i}_{k}', ((c0 + c1) / 2, DY, zz + 0.06), 0.06, 0.12, rnd.choice(['Bronze', 'Ceramic', 'Stone']), seg=24, r2=0.03)
                elif r_ < 0.58:    # vase / pot
                    cyl(f'DivVase{run}_{i}_{k}', (rnd.uniform(c0 + 0.1, c1 - 0.1), DY, z0 + 0.13), rnd.uniform(0.05, 0.08), 0.26,
                        rnd.choice(['Ceramic', 'PotTerracotta', 'Stone', 'Bronze', 'PotBlack']), seg=28, r2=0.035)
                elif r_ < 0.66 and k < 4:   # framed print leaning in the cell
                    rbox(f'DivPrint{run}_{i}_{k}', ((c0 + c1) / 2, DY, z0 + 0.17), (0.30, 0.02, 0.34), 0.0, rnd.choice(['CanvasB', 'CanvasW', 'CanvasE']), bevel=0.003)
                # else: open cell (see-through)
        # warm LED under the top shelf of each run (bake + small realtime glow)
        box(f'DivLED{run}', ((xa + xb) / 2, DY, 2.24), (xb - xa - 0.08, 0.012, 0.006), 'EmitStrip', 'EMIT')
        light(f'DivLight{run}', 'AREA', ((xa + xb) / 2, DY, 2.23), 10, (1.0, 0.52, 0.20), sx=xb - xa - 0.1, sy=0.05, rotx=math.radians(180))
    # trailing plants on the divider top + big floor plants at the ends
    cc0('potted_plant_04', (5.55, DY, 2.275), 0.3, 1.0, baked=False)
    cc0('potted_plant_04', (9.75, DY, 2.275), 2.1, 1.0, baked=False)
    cc0('potted_plant_04', (9.15, DY, 0.495), 1.3, 0.9, baked=False)

    # ================================================================== DINING: 4-seat round table by the east glass
    RX, RY = 16.0, 8.8
    rug('RugDining', RX, RY, 2.5, 2.5, 'RugSlate')
    cyl('DineTop', (RX, RY, 0.745), 0.56, 0.04, 'Walnut', seg=64)
    cyl('DineStem', (RX, RY, 0.37), 0.05, 0.70, 'BlackMetal', seg=24)
    cyl('DineFoot', (RX, RY, 0.015), 0.30, 0.03, 'BlackMetal', seg=48)
    for i in range(4):
        a_ = math.radians(45 + 90 * i); cx_, cy_ = RX + 0.74 * math.cos(a_), RY + 0.74 * math.sin(a_)
        d = (RX - cx_, RY - cy_); n = math.hypot(*d); d = (d[0] / n, d[1] / n)
        cc0('dining_chair_02', (cx_, cy_, 0), face_rot(d) + math.radians(rnd.uniform(-5, 5)))
        seat(cx_ + d[0] * 0.03, cy_ + d[1] * 0.03, 0.45, d, 'chair', 'dining')
        cyl(f'Plate{i}', (RX + 0.32 * math.cos(a_), RY + 0.32 * math.sin(a_), 0.769), 0.11, 0.008, 'Ceramic', seg=32)
        cyl(f'WineGlass{i}', (RX + 0.30 * math.cos(a_ + 0.4), RY + 0.30 * math.sin(a_ + 0.4), 0.765 + 0.08), 0.03, 0.16, 'Ceramic', seg=16, r2=0.012)
    cyl('DineCandle', (RX, RY, 0.765 + 0.09), 0.025, 0.18, 'Wax', seg=16)
    cyl('DineFlame', (RX, RY, 0.765 + 0.18 + 0.016), 0.007, 0.028, 'EmitCandle', 'EMIT', seg=8, r2=0.001)
    cyl('DinePend', (RX, RY, 1.70), 0.30, 0.22, 'EmitShade', 'EMIT', seg=48, r2=0.28, caps=False)
    cyl('DinePendTop', (RX, RY, 1.808), 0.28, 0.004, 'BlackMetal', seg=48)
    cyl('DinePendCap', (RX, RY, 1.815), 0.29, 0.01, 'BlackMetal', seg=48)
    box('DineWire', (RX, RY, (RH + 1.82) / 2), (0.006, 0.006, RH - 1.82), 'BlackMetal')
    light('DinePendLight', 'SPOT', (RX, RY, 1.62), 110, (1.0, 0.50, 0.18), (0.9, 2.6), soft=0.05, cone=120, blend=0.5)

    # canvas on the south wall
    ob = box('CanvasB', (12.65, 0.02, 1.62), (1.55, 0.04, 1.06), 'CanvasB', bevel=0.004, seg=1)
    uv_fit(ob, 12.65 + 0.775, 12.65 - 0.775, 1.62 - 0.53, 1.62 + 0.53, axes=(0, 2))
    box('CanvasBFrame', (12.65, 0.012, 1.62), (1.6, 0.024, 1.11), 'BlackMetal')

    # ================================================================== WORK STUDIO (NE corner): 3 clean desks
    rug('RugStudio', 7.6, 9.55, 5.3, 2.5, 'RugCharcoal')
    SCREENS = []
    def desk(k, cx, cy):
        top = 0.75; w, d = 1.45, 0.72
        box(f'DeskTop{k}', (cx, cy, top - 0.015), (w, d, 0.03), 'Walnut', bevel=0.004)
        for sx in (-1, 1):                      # slim black steel sled frame
            x = cx + sx * (w / 2 - 0.06)
            for sy in (-1, 1):
                box(f'DeskPost{k}{sx}{sy}', (x, cy + sy * (d / 2 - 0.05), (top - 0.03) / 2), (0.025, 0.025, top - 0.03), 'BlackMetal')
            box(f'DeskSled{k}{sx}', (x, cy, 0.0125), (0.025, d - 0.06, 0.025), 'BlackMetal')
            box(f'DeskRail{k}{sx}', (x, cy, top - 0.045), (0.025, d - 0.06, 0.025), 'BlackMetal')
        box(f'DeskBeam{k}', (cx, cy + d / 2 - 0.08, top - 0.06), (w - 0.14, 0.03, 0.05), 'BlackMetal')
        mx, my, mz = cx, cy + 0.12, top + 0.42
        box(f'MonBezel{k}', (mx, my, mz), (0.72, 0.03, 0.43), 'Plastic', bevel=0.006)
        s = B['quad'](f'Screen{k}', [(mx - 0.345, my - 0.016, mz - 0.2), (mx + 0.345, my - 0.016, mz - 0.2), (mx + 0.345, my - 0.016, mz + 0.2), (mx - 0.345, my - 0.016, mz + 0.2)], f'EmitScreen{k}', 'EMIT')
        SCREENS.append(s)
        box(f'MonNeck{k}', (mx, my + 0.05, top + 0.15), (0.05, 0.03, 0.3), 'BlackMetal')
        box(f'MonBase{k}', (mx, my + 0.02, top + 0.006), (0.25, 0.18, 0.012), 'BlackMetal', bevel=0.003)
        box(f'Keyb{k}', (cx - 0.05, cy - 0.17, top + 0.01), (0.44, 0.14, 0.02), 'Plastic', bevel=0.004)
        box(f'Mouse{k}', (cx + 0.28, cy - 0.17, top + 0.012), (0.06, 0.1, 0.025), 'Plastic', bevel=0.01)
        cyl(f'Mug{k}', (cx - 0.52, cy - 0.12, top + 0.05), 0.04, 0.1, 'Ceramic', seg=24)
        box(f'Notebook{k}', (cx + 0.5, cy - 0.04, top + 0.008), (0.21, 0.29, 0.016), ['BookA', 'BookB', 'BookC'][k], bevel=0.002)
        cc0('desk_lamp_arm_01', (cx - 0.62, cy + 0.2, top), math.radians(160))
        cc0('dining_chair_02', (cx + 0.03, cy - 0.70, 0), math.radians(180 + (k - 1) * 5))
    STX, STY = (6.0, 7.6, 9.2), 9.8   # desk-1 monitor ~5.6 m from the live/mp test seat pose (x 7.6, y 4.32)
    for k, cx in enumerate(STX):
        desk(k, cx, STY)
    # linear pendant over the desks (warm, task-level but not glaring)
    box('PendantBar', (7.6, STY - 0.2, 2.45), (4.8, 0.07, 0.045), 'BlackMetal')
    box('PendantDiffuser', (7.6, STY - 0.2, 2.426), (4.7, 0.045, 0.005), 'EmitStrip', 'EMIT')
    for x in (5.45, 9.75):
        box(f'PendantWire{x}', (x, STY - 0.2, (RH + 2.47) / 2), (0.008, 0.008, RH - 2.47), 'BlackMetal')
    light('PendantLight', 'AREA', (7.6, STY - 0.2, 2.42), 40, (1.0, 0.60, 0.30), sx=4.7, sy=0.05)
    # oak slat ceiling over the studio
    x = 5.25
    while x < 9.95:
        box(f'CeilSlat{x:.2f}', (x, 9.75, RH - 0.045), (0.045, 2.4, 0.07), 'Oak', 'CEIL')
        x += 0.11
    box('CeilSlatBack', (7.6, 9.75, RH - 0.005), (4.7, 2.4, 0.01), 'FabricCharcoal', 'CEIL')

    # ================================================================== EAST WINDOW CHAIRS
    for k, (y, d) in enumerate(((4.55, (0.86, 0.51)), (6.35, (0.86, -0.51)))):
        cc0('modern_arm_chair_01', (16.45, y, 0), face_rot(d))
        seat(16.45 + d[0] * 0.05, y + d[1] * 0.05, 0.53, d, 'chair', 'window')
    cc0('side_table_01', (17.2, 5.45, 0), 0.0)
    table_lamp(2, 17.2, 5.45, 0.55, energy=40, rt=(0.8, 2.6))
    rug('RugWindow', 16.6, 5.45, 2.2, 2.6, 'RugOat')

    # ================================================================== skylight well over the pit (hole cut in build.py)
    sx0, sx1, sy0, sy1 = B['SKY']; dep = 0.32
    box('SkyWellW', (sx0 - 0.02, (sy0 + sy1) / 2, RH + dep / 2), (0.04, sy1 - sy0 + 0.08, dep), 'Ceiling', 'CEIL')
    box('SkyWellE', (sx1 + 0.02, (sy0 + sy1) / 2, RH + dep / 2), (0.04, sy1 - sy0 + 0.08, dep), 'Ceiling', 'CEIL')
    box('SkyWellS', ((sx0 + sx1) / 2, sy0 - 0.02, RH + dep / 2), (sx1 - sx0, 0.04, dep), 'Ceiling', 'CEIL')
    box('SkyWellN', ((sx0 + sx1) / 2, sy1 + 0.02, RH + dep / 2), (sx1 - sx0, 0.04, dep), 'Ceiling', 'CEIL')
    n = 5
    for i in range(1, n):
        x = sx0 + (sx1 - sx0) * i / n
        box(f'SkyMull{i}', (x, (sy0 + sy1) / 2, RH + dep - 0.03), (0.05, sy1 - sy0, 0.06), 'Bronze', 'CEIL')
    box('SkyMullL', ((sx0 + sx1) / 2, (sy0 + sy1) / 2, RH + dep - 0.03), (sx1 - sx0, 0.05, 0.06), 'Bronze', 'CEIL')
    # soft warm cove inside the well rim
    box('SkyCove', ((sx0 + sx1) / 2, sy0 + 0.03, RH + 0.05), (sx1 - sx0 - 0.1, 0.01, 0.012), 'EmitStrip', 'EMIT')

    # ================================================================== potted plants (CC0, all in pots)
    def potted(key, aid, keep, loc, rotz, scale, pot=None, baked_shadow=True):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(CC0, aid, aid + '.gltf'))
        new = [o for o in bpy.data.objects if o not in before]
        bpy.context.view_layer.update()
        meshes = [o for o in new if o.type == 'MESH']
        for o in meshes:
            mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
        for o in new:
            if o.type != 'MESH': bpy.data.objects.remove(o)
        kept = []
        for o in meshes:
            if keep and not any(o.name.startswith(p) for p in keep): bpy.data.objects.remove(o)
            else: kept.append(o)
        pts = [o.matrix_world @ v.co for o in kept for v in o.data.vertices]
        cx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2; cy = (min(p.y for p in pts) + max(p.y for p in pts)) / 2
        # trunk base centre (lowest 10 cm) is a better pot centre than the canopy box
        zmin = min(p.z for p in pts); low = [p for p in pts if p.z < zmin + 0.1]
        if low: cx = sum(p.x for p in low) / len(low); cy = sum(p.y for p in low) / len(low)
        objs = list(kept)
        if pot:
            r, h, pm = pot['r'], pot['h'], pot['mat']; sink = pot.get('sink', 0.03)
            for o in kept: o.location += Vector((-cx, -cy, h - sink - zmin))
            for nm, rr, hh, zc, mat, r2 in (('Pot', r, h, h / 2, pm, r * pot.get('taper', 0.86)), ('Soil', r * 0.9, 0.02, h - 0.035, 'Soil', None)):
                bm = bmesh.new()
                bmesh.ops.create_cone(bm, cap_ends=True, segments=40, radius1=rr * (pot.get('taper', 0.86) if nm == 'Pot' else 1), radius2=rr if nm == 'Pot' else rr, depth=hh)
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
        path = os.path.join(OUT, 'plant_' + key + '.glb')   # flat file: mp/server.cjs only allows /baked/<file>
        if not os.path.exists(path) or key not in EXPORTED:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            bpy.ops.object.select_all(action='DESELECT')
            for o in objs: o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
                                      export_lights=False, export_cameras=False, export_extras=False)
            EXPORTED.add(key)
        T = Matrix.Translation(loc) @ Matrix.Rotation(rotz, 4, 'Z') @ Matrix.Scale(scale, 4)
        for o in objs: o.matrix_world = T @ o.matrix_world
        REALTIME.append({'id': key, 'url': 'plant_' + key + '.glb', 'pos': [loc[0], loc[2], -loc[1]], 'rotY': rotz, 'scale': scale})
    EXPORTED = set()
    tree = ['pachira_aquatica_01_bark_d', 'pachira_aquatica_01_leaves_d']
    shrub = ['pachira_aquatica_01_bark_c', 'pachira_aquatica_01_leaves_c']
    potted('money_tree_tall', 'pachira_aquatica_01', tree, (11.8, 11.3, 0), 0.6, 1.15, {'r': 0.27, 'h': 0.52, 'mat': 'PotTerracotta'})
    potted('money_tree_tall', 'pachira_aquatica_01', tree, (17.4, 10.45, 0), 2.4, 1.0, {'r': 0.27, 'h': 0.52, 'mat': 'PotTerracotta'})
    potted('money_tree_shrub', 'pachira_aquatica_01', shrub, (0.75, 0.75, 0), 1.2, 1.2, {'r': 0.30, 'h': 0.48, 'mat': 'PotStone'})
    potted('calathea_b', 'calathea_orbifolia_01', ['calathea_orbifolia_01_b'], (0.42, 3.55, 0), 0.4, 1.7, {'r': 0.17, 'h': 0.50, 'mat': 'PotBlack', 'taper': 0.75})
    potted('calathea_b', 'calathea_orbifolia_01', ['calathea_orbifolia_01_b'], (0.42, 8.45, 0), 2.0, 1.7, {'r': 0.17, 'h': 0.50, 'mat': 'PotBlack', 'taper': 0.75})
    potted('calathea_c', 'calathea_orbifolia_01', ['calathea_orbifolia_01_c'], (3.25, 11.45, 0), 1.0, 1.6, {'r': 0.18, 'h': 0.42, 'mat': 'PotTerracotta'})
    cc0('potted_plant_01', (8.65, 11.45, 0), 0.6, 1.5, baked=False)
    cc0('potted_plant_02', (13.95, 0.55, 0), 2.0, 1.5, baked=False)
    cc0('potted_plant_02', (6.85, 0.5, 0), 0.0, 1.4, baked=False)
    cc0('potted_plant_01', (17.45, 3.3, 0), 1.1, 1.3, baked=False)
    cc0('potted_plant_02', (16.9, 0.6, 0), 0.7, 1.5, baked=False)   # old bar corner
    cc0('potted_plant_04', (STX[0] + 0.58, STY + 0.25, 0.75), 0.0, 1.0, baked=False)
    cc0('potted_plant_04', (STX[2] + 0.58, STY + 0.25, 0.75), 1.0, 1.0, baked=False)
    potted('calathea_c', 'calathea_orbifolia_01', ['calathea_orbifolia_01_c'], (5.2, 11.45, 0), 2.2, 1.6, {'r': 0.18, 'h': 0.42, 'mat': 'PotStone'})

    # ================================================================== seat anchors
    for i, (x, y, z, d, kind, zone) in enumerate(SEATS):
        empty(f'seat_{i + 1}', (x, y, z), face_rot(d), {'kind': kind, 'zone': zone, 'seat_h': round(z, 3)})
    # web-wall anchor (unchanged position from v1)
    empty('webwall_anchor', (9.2, 0.03, 1.55), math.pi,
          {'width': 4.0, 'height': 2.4, 'wall': 'south', 'note': 'free solid wall x 7.2..11.2, z 0.35..2.75 (Blender); in three.js the anchor local +Z faces into the room'})
    print('SEATS', len(SEATS))
    return SEATS

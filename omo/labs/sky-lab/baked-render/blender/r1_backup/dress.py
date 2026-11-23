# Room dressing (step 3): wool rugs per zone, dining zone, bar, bookshelf, 2 canvases, table lamps, ceiling coffers +
# lounge slat ceiling, and the 'webwall_anchor' empty on the south wall. Textures for rugs/canvases are generated here
# with numpy (deterministic, no downloads) and saved to assets/gen_*.png so the glTF export can embed them.
import bpy, bmesh, math, os, random
import numpy as np
from mathutils import Vector


def _blur(a, r, axis=(0, 1), n=3):
    for _ in range(n):
        for ax in axis:
            c = np.cumsum(np.pad(a, [(r + 1, r) if i == ax else (0, 0) for i in range(a.ndim)], mode='wrap'), axis=ax)
            hi = np.take(c, range(2 * r + 1, c.shape[ax]), axis=ax); lo = np.take(c, range(0, c.shape[ax] - 2 * r - 1), axis=ax)
            a = (hi - lo) / (2 * r + 1)
    return a


def _save(A, name, rgb):
    h, w, _ = rgb.shape
    im = bpy.data.images.new(name, w, h, alpha=False)
    px = np.ones((h, w, 4), np.float32); px[..., :3] = np.clip(rgb[::-1], 0, 1)
    im.pixels.foreach_set(px.ravel()); im.filepath_raw = os.path.join(A, name + '.png'); im.file_format = 'PNG'; im.save()
    bpy.data.images.remove(im)
    return name + '.png'


def rug_texture(A, name, base, border, line, seed, n=1024, bw=0.07):
    rs = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n] / n
    fib = _blur(rs.random((n, n)), 1, n=1) - 0.5                       # wool fibre grain
    mot = _blur(rs.random((n, n)), 24) - 0.5                           # low-frequency mottling
    loops = 0.5 + 0.5 * np.sin(x * n * 0.9 * np.pi) * np.sin(y * n * 0.9 * np.pi)
    d = np.minimum(np.minimum(x, 1 - x), np.minimum(y, 1 - y))
    col = np.where((d < bw)[..., None], np.array(border), np.array(base))
    ln = (np.abs(d - bw * 1.45) < 0.004)[..., None]
    col = np.where(ln, np.array(line), col)
    k = 1 + fib[..., None] * 0.35 + mot[..., None] * 0.5 + (loops[..., None] - 0.5) * 0.06
    return _save(A, name, col * k)


def canvas_texture(A, name, ground, fields, seed, w=1024, h=680):
    rs = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w]; x = x / w; y = y / h
    col = np.ones((h, w, 3)) * np.array(ground)
    for (x0, x1, y0, y1, c, soft) in fields:
        ex = (_blur(rs.random((h, w)), 18) - 0.5) * 0.10
        dx = np.maximum(x0 - x, x - x1); dy = np.maximum(y0 - y, y - y1)
        dd = np.maximum(dx, dy) + ex
        m = np.clip(0.5 - dd / soft, 0, 1)[..., None]
        col = col * (1 - m) + np.array(c) * m
    streak = _blur(rs.random((h, w)), 22, axis=(1,), n=2) - 0.5           # horizontal brush drag
    grain = _blur(rs.random((h, w)), 1, n=1) - 0.5                        # canvas weave
    col = col * (1 + streak[..., None] * 0.9 + grain[..., None] * 0.12)
    return _save(A, name, col)


def uv_fit(ob, x0, x1, a0, a1, axes=(0, 1)):
    """Map UVs 0..1 over the object's extent on two world axes (for rugs/canvases whose texture is not tiling)."""
    me = ob.data; uv = me.uv_layers['UVMap']
    for p in me.polygons:
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = ((co[axes[0]] - x0) / (x1 - x0), (co[axes[1]] - a0) / (a1 - a0))


def dress(B):
    """B: namespace dict from build.py (box, cyl, principled, cc0, MATS, LAMPS, ROOM, RW, RD, RH, A, scene, light helpers)."""
    box, cyl, principled, cc0 = B['box'], B['cyl'], B['principled'], B['cc0']
    LAMPS, ROOM, RH, A = B['LAMPS'], B['ROOM'], B['RH'], B['A']
    rnd = random.Random(11)

    def light(name, kind, loc, energy, color, rt_int, rt_dist, **kw):
        ld = bpy.data.lights.new(name, kind); ld.energy = energy; ld.color = color
        ld.shadow_soft_size = kw.get('soft', 0.08)
        if kind == 'SPOT':
            ld.spot_size = math.radians(kw.get('cone', 100)); ld.spot_blend = 0.7
        lo = bpy.data.objects.new(name, ld); lo.location = loc; ROOM.objects.link(lo)
        LAMPS.append({'name': name, 'pos': [loc[0], loc[2], -loc[1]], 'color': list(color), 'intensity': rt_int, 'distance': rt_dist})

    # ---------------------------------------------------------- generated textures
    principled('RugOat', diff=rug_texture(A, 'gen_rug_oat', (0.60, 0.54, 0.45), (0.16, 0.15, 0.15), (0.60, 0.54, 0.45), 1), rough=1.0)
    principled('RugCharcoal', diff=rug_texture(A, 'gen_rug_charcoal', (0.13, 0.13, 0.14), (0.10, 0.10, 0.105), (0.46, 0.40, 0.32), 2, bw=0.04), rough=1.0)
    principled('RugSlate', diff=rug_texture(A, 'gen_rug_slate', (0.24, 0.27, 0.30), (0.20, 0.22, 0.25), (0.72, 0.68, 0.60), 3, bw=0.05), rough=1.0)
    principled('CanvasA', diff=canvas_texture(A, 'gen_canvas_a', (0.28, 0.07, 0.05),
               [(0.08, 0.92, 0.08, 0.46, (0.78, 0.36, 0.12), 0.05), (0.08, 0.92, 0.56, 0.92, (0.16, 0.05, 0.08), 0.05)], 4), rough=0.85)
    principled('CanvasB', diff=canvas_texture(A, 'gen_canvas_b', (0.80, 0.76, 0.66),
               [(0.10, 0.58, 0.12, 0.88, (0.06, 0.10, 0.20), 0.04), (0.64, 0.90, 0.40, 0.88, (0.74, 0.52, 0.16), 0.04)], 5, w=1024, h=700), rough=0.85)
    principled('Bottle', color=(0.05, 0.09, 0.05), rough=0.12)
    principled('BottleAmber', color=(0.30, 0.12, 0.03), rough=0.12)
    principled('BookD', color=(0.62, 0.58, 0.50), rough=0.8)
    principled('BookE', color=(0.12, 0.20, 0.16), rough=0.8)

    # ---------------------------------------------------------- rugs per zone (UVs fitted, so the border lands on the edge)
    def rug(name, cx, cy, w, d, mat):
        ob = box(name, (cx, cy, 0.007), (w, d, 0.014), mat, bevel=0.004, seg=1)
        uv_fit(ob, cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2)
    rug('RugDesks', 7.6, 4.75, 9.4, 3.0, 'RugCharcoal')
    rug('RugLounge', 15.0, 9.25, 4.4, 3.3, 'RugOat')
    rug('RugDining', 4.5, 9.3, 3.8, 2.8, 'RugSlate')

    # ---------------------------------------------------------- dining zone (NW): walnut table, 6 chairs, two drum pendants
    box('DineTop', (4.5, 9.3, 0.745), (2.4, 1.0, 0.04), 'Walnut', bevel=0.008)
    for sx in (-0.95, 0.95):
        box(f'DineLeg{sx}', (4.5 + sx, 9.3, 0.36), (0.08, 0.80, 0.72), 'BlackMetal', bevel=0.004)
    box('DineStretch', (4.5, 9.3, 0.12), (1.9, 0.06, 0.04), 'BlackMetal')
    for i, x in enumerate((3.8, 4.5, 5.2)):
        cc0('dining_chair_02', (x, 8.62, 0), math.radians(180 + rnd.uniform(-5, 5)))
        cc0('dining_chair_02', (x, 9.98, 0), math.radians(rnd.uniform(-5, 5)))
    for i, x in enumerate((3.9, 5.1)):
        cyl(f'DinePend{i}', (x, 9.3, 1.68), 0.26, 0.20, 'EmitShade', 'EMIT', seg=48, r2=0.24)
        cyl(f'DinePendCap{i}', (x, 9.3, 1.785), 0.25, 0.01, 'BlackMetal', seg=48)
        box(f'DineWire{i}', (x, 9.3, (RH + 1.79) / 2), (0.006, 0.006, RH - 1.79), 'BlackMetal')
        light(f'DinePendLight{i}', 'POINT', (x, 9.3, 1.64), 32, (1.0, 0.72, 0.45), 0.9, 2.6)
    cc0('ceramic_vase_01', (4.5, 9.3, 0.765), 0.0, 0.7)

    # ---------------------------------------------------------- bar (SE corner): counter, back bar, shelves, bottles, pendants
    box('BarBody', (16.0, 1.65, 0.51), (2.8, 0.55, 1.02), 'DarkWood', bevel=0.01)
    box('BarTop', (16.0, 1.62, 1.04), (2.95, 0.68, 0.04), 'Marble', bevel=0.006)
    box('BarKick', (16.0, 1.90, 0.05), (2.8, 0.02, 0.10), 'Bronze')
    box('BackBar', (16.0, 0.27, 0.45), (3.2, 0.52, 0.90), 'DarkWood', bevel=0.008)
    box('BackBarTop', (16.0, 0.28, 0.915), (3.25, 0.56, 0.03), 'Marble', bevel=0.004)
    for j, z in enumerate((1.42, 1.86)):
        box(f'BarShelf{j}', (16.0, 0.14, z), (3.0, 0.26, 0.035), 'Oak', bevel=0.003)
        x = 14.65
        while x < 17.35:
            r = rnd.uniform(0.035, 0.045); hh = rnd.uniform(0.22, 0.32)
            cyl(f'Bottle{j}_{x:.2f}', (x, 0.14, z + 0.018 + hh / 2), r, hh, rnd.choice(['Bottle', 'BottleAmber', 'Ceramic']), seg=16, r2=r * 0.55)
            x += rnd.uniform(0.12, 0.22)
    for x in (14.7, 15.3, 16.7, 17.3):
        cyl(f'Glass{x}', (x, 0.30, 0.93 + 0.05), 0.035, 0.10, 'Ceramic', seg=16)
    for i, a in enumerate((15.15, 16.0, 16.85)):
        cc0('bar_chair_round_01', (a, 2.42, 0), math.radians(rnd.uniform(-10, 10)))
        cyl(f'BarPend{i}', (a, 1.62, 2.15), 0.10, 0.18, 'EmitShade', 'EMIT', seg=32, r2=0.06)
        box(f'BarWire{i}', (a, 1.62, (RH + 2.24) / 2), (0.005, 0.005, RH - 2.24), 'BlackMetal')
        light(f'BarPendLight{i}', 'SPOT', (a, 1.62, 2.06), 22, (1.0, 0.74, 0.48), 0.6, 2.2, cone=95)

    # ---------------------------------------------------------- bookshelf (west wall, north end): steel frame, oak shelves, books
    X0, Y0, Y1 = 0.02, 9.65, 11.85
    for y in (Y0, (Y0 + Y1) / 2, Y1):
        box(f'ShelfPost{y:.2f}', (X0 + 0.19, y, 1.3), (0.38, 0.03, 2.6), 'BlackMetal')
    for k, z in enumerate((0.06, 0.50, 0.94, 1.38, 1.82, 2.26)):
        box(f'Shelf{k}', (X0 + 0.19, (Y0 + Y1) / 2, z), (0.36, Y1 - Y0, 0.03), 'Oak', bevel=0.003)
        if k == 5 and False:
            continue
        for (a0, a1) in ((Y0 + 0.03, (Y0 + Y1) / 2 - 0.03), ((Y0 + Y1) / 2 + 0.03, Y1 - 0.03)):
            y = a0 + rnd.uniform(0.0, 0.15)
            while y < a1 - 0.05:
                if rnd.random() < 0.18:          # gap with an object
                    if rnd.random() < 0.5:
                        cyl(f'ShelfVase{k}_{y:.2f}', (X0 + 0.19, y + 0.08, z + 0.015 + 0.09), 0.06, 0.18, rnd.choice(['Ceramic', 'Stone', 'Bronze']), seg=24, r2=0.04)
                    y += 0.25; continue
                run = rnd.randint(5, 14)
                for _ in range(run):
                    t = rnd.uniform(0.022, 0.045); hh = rnd.uniform(0.20, 0.33); dd = rnd.uniform(0.17, 0.24)
                    if y + t > a1: break
                    box(f'Book{k}_{y:.3f}', (X0 + 0.04 + dd / 2, y + t / 2, z + 0.015 + hh / 2), (dd, t, hh),
                        rnd.choice(['BookA', 'BookB', 'BookC', 'BookD', 'BookE', 'Leather']), bevel=0.002, seg=1)
                    y += t + 0.002
                if rnd.random() < 0.35 and y < a1 - 0.25:   # a short horizontal stack
                    zz = z + 0.015
                    for _ in range(rnd.randint(2, 4)):
                        hh = rnd.uniform(0.03, 0.05)
                        box(f'Stack{k}_{y:.3f}_{zz:.3f}', (X0 + 0.15, y + 0.13, zz + hh / 2), (0.22, 0.24, hh), rnd.choice(['BookA', 'BookD', 'BookB']), bevel=0.002, seg=1)
                        zz += hh
                    y += 0.3
                y += rnd.uniform(0.02, 0.08)

    # ---------------------------------------------------------- canvases (2): over the credenza, and on the south wall
    def canvas(name, c, w, h, mat, face):
        if face == 'E':     # on the west wall, facing +x
            ob = box(name, (c[0] + 0.02, c[1], c[2]), (0.04, w, h), mat, bevel=0.004, seg=1)
            uv_fit(ob, c[1] - w / 2, c[1] + w / 2, c[2] - h / 2, c[2] + h / 2, axes=(1, 2))
            box(name + 'Frame', (c[0] + 0.012, c[1], c[2]), (0.024, w + 0.05, h + 0.05), 'BlackMetal')
        else:               # on the south wall, facing +y
            ob = box(name, (c[0], c[1] + 0.02, c[2]), (w, 0.04, h), mat, bevel=0.004, seg=1)
            uv_fit(ob, c[0] + w / 2, c[0] - w / 2, c[2] - h / 2, c[2] + h / 2, axes=(0, 2))
            box(name + 'Frame', (c[0], c[1] + 0.012, c[2]), (w + 0.05, 0.024, h + 0.05), 'BlackMetal')
    canvas('CanvasA', (0.06, 6.0, 1.80), 1.9, 1.25, 'CanvasA', 'E')
    canvas('CanvasB', (12.65, 0.0, 1.62), 1.55, 1.06, 'CanvasB', 'N')

    # ---------------------------------------------------------- lounge side tables + table lamps
    cc0('side_table_01', (13.3, 7.45, 0), 0.0)
    def table_lamp(k, x, y, z):
        cyl(f'TLampBase{k}', (x, y, z + 0.16), 0.07, 0.32, 'Ceramic', seg=32, r2=0.05)
        cyl(f'TLampShade{k}', (x, y, z + 0.42), 0.17, 0.22, 'EmitShade', 'EMIT', seg=48, r2=0.15)
        light(f'TableLamp{k}', 'POINT', (x, y, z + 0.40), 20, (1.0, 0.70, 0.42), 0.8, 2.4, soft=0.1)
    table_lamp(0, 16.95, 7.45, 0.55)
    table_lamp(1, 13.3, 7.45, 0.55)

    # ---------------------------------------------------------- ceiling: shallow coffers over the desks, oak slats over the lounge
    for x in (2.0, 5.5, 9.5, 13.0):
        box(f'CofferX{x}', (x, 5.1, RH - 0.07), (0.12, 6.4, 0.14), 'Ceiling', 'CEIL')
    for y in (1.9, 5.6, 8.3):
        box(f'CofferY{y}', (7.5, y, RH - 0.07), (11.0, 0.12, 0.14), 'Ceiling', 'CEIL')
    x = 12.95
    while x < 17.45:
        box(f'CeilSlat{x:.2f}', (x, 10.0, RH - 0.045), (0.045, 3.6, 0.07), 'Oak', 'CEIL')
        x += 0.11
    box('CeilSlatBack', (15.2, 10.0, RH - 0.005), (4.6, 3.6, 0.01), 'FabricCharcoal', 'CEIL')

    # ---------------------------------------------------------- web-wall anchor: empty on the free south-wall span x 7.1..11.3
    an = bpy.data.objects.new('webwall_anchor', None)
    an.empty_display_type = 'PLAIN_AXES'; an.location = (9.2, 0.03, 1.55); an.rotation_euler = (0, 0, math.pi)
    an['width'] = 4.0; an['height'] = 2.4; an['wall'] = 'south'; an['note'] = 'free solid wall x 7.2..11.2, z 0.35..2.75 (Blender); in three.js the anchor local +Z faces into the room'
    mk = bpy.data.collections.get('Markers') or bpy.data.collections.new('Markers')
    if mk.name not in B['scene'].collection.children: B['scene'].collection.children.link(mk)
    mk.objects.link(an)
    return an

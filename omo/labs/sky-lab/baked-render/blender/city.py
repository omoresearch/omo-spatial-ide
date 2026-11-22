# Procedural Manhattan at blue hour (Cycles), seen from ~230 m. Called from build.py (and cityprev.py for fast tests).
# Varied archetypes: walk-ups + prewar masonry (setbacks, cornices, rooftop water tanks, bulkheads, HVAC),
# glass curtain-wall towers (rect / chamfered / round, lit mechanical lanterns), Art Deco wedding-cake towers with
# floodlit crowns + spires, supertall pencil towers on Billionaires' Row with lit tops + red beacons.
# Windows: per-building lit fraction, office floors lit/dark in bands, warm/cool mix, storefront glow at street level.
# Streets: one-way avenues/streets with head/tail-light trails, kerb lamps, sidewalks; Central Park; East River + bridge.
import bpy, bmesh, math, random
from mathutils import Vector
from common import NB

AV0, AVS, AVW = 38.0, 262.0, 30.0       # avenues: centre x0, spacing, width (run along y)
ST0, STS, STW = 25.0, 80.0, 18.0        # streets: centre y0, spacing, width (run along x)
R = 2700.0
RIVER = (1150.0, 1600.0)                # East River x-range
HUDSON = (-1950.0, -1450.0)
PARK = (AV0 - 2 * AVS, AV0 + AVS, ST0 + 11 * STS, 4000.0)   # Central Park: x0, x1, y0, y1
BRIDGE_Y = 640.0
(T_WALK, T_PREWAR, T_GLASS, T_DECO, T_SUPER, T_ROOF, T_CROWN, T_BEACON, T_TANK, T_LAMP) = range(10)
FOG_L = 950.0


def rect(x0, x1, y0, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]

def chamfer(x0, x1, y0, y1, c):
    return [(x0 + c, y0), (x1 - c, y0), (x1, y0 + c), (x1, y1 - c), (x1 - c, y1), (x0 + c, y1), (x0, y1 - c), (x0, y0 + c)]

def circle(cx, cy, r, n):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]

def inset(poly, k):
    cx = sum(p[0] for p in poly) / len(poly); cy = sum(p[1] for p in poly) / len(poly)
    return [(cx + (x - cx) * k, cy + (y - cy) * k) for x, y in poly]


class CityMesh:
    def __init__(self):
        self.bm = bmesh.new()
        L = self.bm.faces.layers.float
        self.L = {k: L.new(k) for k in ('bid', 'btype', 'bbot', 'btop')}

    def face(self, vs, a, z0, z1):
        f = self.bm.faces.new(vs)
        f[self.L['bid']] = a['bid']; f[self.L['btype']] = a['t']
        f[self.L['bbot']] = a.get('bbot', z0); f[self.L['btop']] = a.get('btop', z1)
        return f

    def prism(self, poly, z0, z1, a, top=True):
        n = len(poly)
        lo = [self.bm.verts.new((x, y, z0)) for x, y in poly]
        hi = [self.bm.verts.new((x, y, z1)) for x, y in poly]
        for i in range(n):
            j = (i + 1) % n
            self.face((lo[i], lo[j], hi[j], hi[i]), a, z0, z1)
        if top:
            self.face(hi, a, z0, z1)

    def frustum(self, poly, z0, z1, k, a):
        n = len(poly)
        cx = sum(p[0] for p in poly) / n; cy = sum(p[1] for p in poly) / n
        lo = [self.bm.verts.new((x, y, z0)) for x, y in poly]
        if k < 0.01:
            ap = self.bm.verts.new((cx, cy, z1))
            for i in range(n):
                self.face((lo[i], lo[(i + 1) % n], ap), a, z0, z1)
        else:
            hi = [self.bm.verts.new((cx + (x - cx) * k, cy + (y - cy) * k, z1)) for x, y in poly]
            for i in range(n):
                j = (i + 1) % n
                self.face((lo[i], lo[j], hi[j], hi[i]), a, z0, z1)
            self.face(hi, a, z0, z1)

    def ribbon(self, p, q, hgt, a):
        vs = [self.bm.verts.new(v) for v in (p, q, (q[0], q[1], q[2] + hgt), (p[0], p[1], p[2] + hgt))]
        self.face(vs, a, p[2], p[2] + hgt)

    def to_object(self, name, mat, coll):
        me = bpy.data.meshes.new(name); self.bm.to_mesh(me); self.bm.free(); me.materials.append(mat)
        ob = bpy.data.objects.new(name, me); coll.objects.link(ob)
        return ob


# ------------------------------------------------------------------ building archetypes
def roof_clutter(cm, x0, x1, y0, y1, z, bid, rnd, tank_p):
    w, d = x1 - x0, y1 - y0
    if w < 8 or d < 8:
        return
    R_ = {'bid': bid, 't': T_ROOF}
    # stair/elevator bulkhead
    bw, bd = min(5.0, w * 0.3), min(6.0, d * 0.35)
    bx = rnd.uniform(x0 + 1, x1 - bw - 1); by = rnd.uniform(y0 + 1, y1 - bd - 1)
    cm.prism(rect(bx, bx + bw, by, by + bd), z, z + rnd.uniform(2.8, 4.2), R_)
    for _ in range(rnd.randint(1, 5)):      # HVAC units
        hw, hd = rnd.uniform(1.5, 3.5), rnd.uniform(1.5, 4.5)
        hx = rnd.uniform(x0 + 0.8, x1 - hw - 0.8); hy = rnd.uniform(y0 + 0.8, y1 - hd - 0.8)
        cm.prism(rect(hx, hx + hw, hy, hy + hd), z, z + rnd.uniform(1.0, 2.0), R_)
    for _ in range(rnd.choice((0, 0, 1, 1, 2, 3))):    # antenna / radio masts
        mx = rnd.uniform(x0 + 1, x1 - 1); my = rnd.uniform(y0 + 1, y1 - 1); mr = rnd.uniform(0.12, 0.3)
        cm.prism(rect(mx - mr, mx + mr, my - mr, my + mr), z, z + rnd.uniform(4.0, 14.0), R_)
    if rnd.random() < 0.35 and w > 14 and d > 12:      # louvred cooling tower block
        cw, cd = rnd.uniform(3.5, 6.0), rnd.uniform(3.5, 6.0)
        qx = rnd.uniform(x0 + 1, x1 - cw - 1); qy = rnd.uniform(y0 + 1, y1 - cd - 1)
        cm.prism(rect(qx, qx + cw, qy, qy + cd), z, z + rnd.uniform(2.5, 4.0), R_)
    if rnd.random() < tank_p and w > 10 and d > 10:   # the classic NYC timber water tank on a steel stand
        r = rnd.uniform(2.0, 3.0); tx = rnd.uniform(x0 + r + 1, x1 - r - 1); ty = rnd.uniform(y0 + r + 1, y1 - r - 1)
        st = rnd.uniform(2.5, 4.0); th = rnd.uniform(3.5, 5.0)
        for sx, sy in ((-0.6, -0.6), (0.6, -0.6), (0.6, 0.6), (-0.6, 0.6)):
            cm.prism(rect(tx + sx * r - 0.15, tx + sx * r + 0.15, ty + sy * r - 0.15, ty + sy * r + 0.15), z, z + st, R_, top=False)
        T_ = {'bid': bid, 't': T_TANK}
        cm.prism(circle(tx, ty, r, 12), z + st, z + st + th, T_, top=False)
        cm.frustum(circle(tx, ty, r * 1.06, 12), z + st + th, z + st + th + r * 0.55, 0.0, T_)


def cornice(cm, poly, z, a):
    cm.prism(inset(poly, 1.02), z - 0.9, z + 0.35, {'bid': a['bid'], 't': T_ROOF})


def beacon(cm, cx, cy, z, bid):
    cm.prism(rect(cx - 0.8, cx + 0.8, cy - 0.8, cy + 0.8), z, z + 1.4, {'bid': bid, 't': T_BEACON})


def building(cm, x0, x1, y0, y1, h, t, rnd, G):
    bid = rnd.random(); A = {'bid': bid, 't': t}
    w, d = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    zt = G + h
    if t == T_WALK:
        P = rect(x0, x1, y0, y1)
        cm.prism(P, G, zt, A); cornice(cm, P, zt, A)
        roof_clutter(cm, x0, x1, y0, y1, zt + 0.35, bid, rnd, 0.35)
    elif t == T_PREWAR:
        h1 = h * rnd.uniform(0.55, 0.8); P = rect(x0, x1, y0, y1)
        cm.prism(P, G, G + h1, A); cornice(cm, P, G + h1, A)
        s = min(w, d) * rnd.uniform(0.12, 0.22)
        if h - h1 > 8 and w - 2 * s > 9 and d - 2 * s > 9:
            P2 = rect(x0 + s, x1 - s, y0 + s, y1 - s)
            cm.prism(P2, G + h1 + 0.35, zt, A); cornice(cm, P2, zt, A)
            roof_clutter(cm, x0 + s, x1 - s, y0 + s, y1 - s, zt + 0.35, bid, rnd, 0.75)
        else:
            roof_clutter(cm, x0, x1, y0, y1, G + h1 + 0.35, bid, rnd, 0.75)
    elif t == T_GLASS:
        zb = G
        if rnd.random() < 0.45 and min(w, d) > 22:   # masonry podium, tower set back
            ph = rnd.uniform(14, 32)
            cm.prism(rect(x0, x1, y0, y1), G, G + ph, {'bid': bid, 't': T_PREWAR}); zb = G + ph
            s = rnd.uniform(3, 6); x0, x1, y0, y1 = x0 + s, x1 - s, y0 + s, y1 - s
        r = rnd.random()
        if r < 0.15 and abs(w - d) < 8:
            P = circle(cx, cy, min(x1 - x0, y1 - y0) / 2, 20)
        elif r < 0.45:
            P = chamfer(x0, x1, y0, y1, min(x1 - x0, y1 - y0) * rnd.uniform(0.12, 0.22))
        else:
            P = rect(x0, x1, y0, y1)
        cm.prism(P, zb, zt, A)
        lit = rnd.random() < 0.16
        mh = rnd.uniform(5, 10)
        cm.prism(inset(P, 0.82), zt, zt + mh, {'bid': bid, 't': T_CROWN if lit else T_ROOF})
        if not lit:
            Pm = inset(P, 0.82); mx0, mx1 = min(q[0] for q in Pm), max(q[0] for q in Pm); my0, my1 = min(q[1] for q in Pm), max(q[1] for q in Pm)
            k_ = 0.2 * (mx1 - mx0); l_ = 0.2 * (my1 - my0)
            roof_clutter(cm, mx0 + k_, mx1 - k_, my0 + l_, my1 - l_, zt + mh, bid, rnd, 0.0)
        if h > 230:
            beacon(cm, cx, cy, zt + mh, bid)
    elif t == T_DECO:
        n = rnd.randint(3, 5); z = G; P = rect(x0, x1, y0, y1)
        fr = [0.42, 0.22, 0.15, 0.11, 0.10][:n]; tot = sum(fr); fr = [f / tot * h for f in fr]
        k = 1.0
        for i, hh in enumerate(fr):
            Pi = inset(P, k)
            cm.prism(Pi, z, z + hh, A); cornice(cm, Pi, z + hh, A)
            z += hh; k *= rnd.uniform(0.72, 0.84)
        C = {'bid': bid, 't': T_CROWN}
        Pc = inset(P, k)
        if rnd.random() < 0.55:
            ch = rnd.uniform(14, 26); cm.frustum(Pc, z, z + ch, 0.25, C); z += ch
        else:
            for _ in range(3):
                ch = rnd.uniform(4, 7); cm.prism(Pc, z, z + ch, C); z += ch; Pc = inset(Pc, 0.75)
        sp = rnd.uniform(18, 45)
        cm.frustum(circle(cx, cy, 1.6, 8), z, z + sp, 0.0, C)
        beacon(cm, cx, cy, z + sp, bid)
    elif t == T_SUPER:
        s = max(0.0, (min(w, d) - rnd.uniform(18, 26)) / 2)
        P = rect(x0 + s, x1 - s, y0 + s, y1 - s) if rnd.random() < 0.6 else chamfer(x0 + s, x1 - s, y0 + s, y1 - s, 3.0)
        cm.prism(P, G, zt - 12, A)
        cm.prism(inset(P, 0.97), zt - 12, zt, {'bid': bid, 't': T_CROWN})
        beacon(cm, cx, cy, zt, bid)


def pick(d, boro, row, rnd):
    r = rnd.random()
    if boro:
        if r < 0.55: return T_WALK, rnd.uniform(12, 26)
        if r < 0.88: return T_PREWAR, rnd.uniform(25, 60)
        return T_GLASS, rnd.uniform(50, 150)
    core = math.exp(-d / 1700.0)
    if row and r < 0.4:
        return T_SUPER, rnd.uniform(290, 440)
    if r < 0.012 * core: return T_SUPER, rnd.uniform(280, 400)
    if r < 0.06 * core + 0.012: return T_DECO, rnd.uniform(150, 300)
    if r < 0.24 + 0.16 * core: return T_GLASS, 70 + rnd.lognormvariate(4.4, 0.45) * (0.5 + 0.5 * core)
    if r < 0.62: return T_PREWAR, 30 + rnd.lognormvariate(3.6, 0.5)
    return T_WALK, rnd.uniform(14, 30)


def gen_buildings(cm, G, tower, rnd):
    nA = int(R / AVS) + 2; nS = int(R / STS) + 2
    count = 0
    for i in range(-nA, nA):
        xa = AV0 + i * AVS + AVW / 2; xb = AV0 + (i + 1) * AVS - AVW / 2
        if xa < RIVER[0] < xb: xb = RIVER[0] - 10
        if xa < RIVER[1] < xb: xa = RIVER[1] + 10
        if RIVER[0] <= xa and xb <= RIVER[1]: continue
        if HUDSON[0] < (xa + xb) / 2 < HUDSON[1]: continue
        if xb - xa < 20: continue
        for j in range(-nS, nS):
            ya = ST0 + j * STS + STW / 2; yb = ST0 + (j + 1) * STS - STW / 2
            cxm, cym = (xa + xb) / 2, (ya + yb) / 2
            d = math.hypot(cxm, cym)
            if d > R: continue
            if cxm < -200 and cym < -200: continue          # SW quadrant is behind the solid walls
            if PARK[0] < cxm < PARK[1] and cym > PARK[2]: continue
            boro = xa > RIVER[1]
            row = (not boro) and PARK[0] - 200 < cxm < PARK[1] + 300 and PARK[2] - STS < cym < PARK[2]
            x = xa + 3
            while x < xb - 6:
                wlot = rnd.uniform(16, 44) if not row else rnd.uniform(26, 44)
                x2 = min(x + wlot, xb - 3)
                halves = ((ya + 3, cym - 1), (cym + 1, yb - 3)) if rnd.random() < 0.7 else ((ya + 3, yb - 3),)
                for (y0, y1) in halves:
                    if not (x2 < tower[0] - 8 or x > tower[1] + 8 or y1 < tower[2] - 8 or y0 > tower[3] + 8):
                        continue
                    t, h = pick(d, boro, row, rnd)
                    if d < 340:
                        h = min(h, 95 + d * 0.25)
                        if t in (T_SUPER, T_DECO) and h < 150: t = T_GLASS
                    ins = rnd.uniform(0, 1.5)
                    building(cm, x + ins, x2 - ins, y0 + ins, y1 - ins, h, t, rnd, G)
                    count += 1
                x = x2 + rnd.uniform(0.3, 2.0)
    # hero towers that sell the skyline from the N / E glass
    for (x, y, h, t, w) in ((470, 420, 305, T_DECO, 44), (-300, 560, 265, T_DECO, 40), (820, 1450, 250, T_DECO, 40),
                            (130, 820, 425, T_SUPER, 24), (-140, 830, 400, T_SUPER, 22), (-420, 845, 360, T_SUPER, 26),
                            (640, 900, 330, T_GLASS, 46), (980, 260, 270, T_GLASS, 50), (1750, 900, 210, T_GLASS, 44),
                            (1820, 300, 180, T_GLASS, 40)):
        building(cm, x - w / 2, x + w / 2, y - w / 2, y + w / 2, h, t, rnd, G)
    return count


def gen_bridge(cm, G):
    y = BRIDGE_Y; xa, xb = RIVER[0] - 70, RIVER[1] + 70; t1, t2 = RIVER[0] + 45, RIVER[1] - 45
    dz = G + 40; top = dz + 100; bid = 0.5
    cm.prism(rect(xa, xb, y - 14, y + 14), dz - 4, dz, {'bid': bid, 't': T_ROOF})
    for tx in (t1, t2):
        for sy in (-12, 12):
            cm.prism(rect(tx - 3.5, tx + 3.5, y + sy - 3.5, y + sy + 3.5), G, top, {'bid': bid, 't': T_CROWN, 'bbot': dz - 30, 'btop': top + 40})
        for zz in (dz + 45, top - 6):
            cm.prism(rect(tx - 2.5, tx + 2.5, y - 12, y + 12), zz, zz + 5, {'bid': bid, 't': T_ROOF})
    L = {'bid': bid, 't': T_LAMP}
    for sy in (-12, 12):
        pts = []
        for k in range(0, 61):           # main span parabola
            u = k / 60.0; x = t1 + (t2 - t1) * u; z = top - 92 * (1 - (2 * u - 1) ** 2)
            pts.append((x, y + sy, z))
        side = []
        for (x0, x1) in ((xa, t1), (t2, xb)):
            seg = []
            for k in range(0, 13):
                u = k / 12.0; x = x0 + (x1 - x0) * u
                zl = (dz + 2) + (top - dz - 2) * (u if x0 == xa else 1 - u)
                seg.append((x, y + sy, zl - 10 * math.sin(math.pi * u)))
            side.append(seg)
        for seg in [pts] + side:
            for p, q in zip(seg[:-1], seg[1:]):
                cm.ribbon(p, q, 0.9, {'bid': bid, 't': T_ROOF})
            for k, p in enumerate(seg):
                if k % 2 == 0:
                    cm.prism(rect(p[0] - 0.7, p[0] + 0.7, p[1] - 0.7, p[1] + 0.7), p[2] + 0.9, p[2] + 2.3, L)
    x = xa
    while x < xb:                         # deck lamp posts
        for sy in (-13.5, 13.5):
            cm.prism(rect(x - 0.4, x + 0.4, y + sy - 0.4, y + sy + 0.4), dz, dz + 1.2, L)
        x += 22
    cm.prism(rect(xa, xb, y - 4.5, y - 3.5), dz, dz + 0.08, {'bid': bid, 't': T_BEACON})   # tail-light trail
    cm.prism(rect(xa, xb, y + 3.5, y + 4.5), dz, dz + 0.08, L)                           # head-light trail


# ------------------------------------------------------------------ materials
def horizon_col(nb, dx, dy):
    """Sky colour at elevation 0 for direction (dx, dy) -- same formula as sky()."""
    sundir = nb.math('ADD', nb.math('MULTIPLY', dx, -0.92), nb.math('MULTIPLY', dy, 0.38))
    sunf = nb.math('POWER', nb.math('MAXIMUM', nb.math('ADD', nb.math('MULTIPLY', sundir, 0.5), 0.5), 0.0), 3.0)
    glow = nb.math('ADD', 0.18, nb.math('MULTIPLY', sunf, 1.5))
    return nb.vmath('ADD', nb.comb(0.26, 0.27, 0.46), nb.vmath('MULTIPLY', nb.comb(glow, glow, glow), (1.0, 0.44, 0.22)))


def haze_wrap(m, nb, shader_out, G):
    out = m.node_tree.nodes.get('Material Output') or nb.node('ShaderNodeOutputMaterial')
    cam = nb.node('ShaderNodeCameraData'); geo = nb.node('ShaderNodeNewGeometry')
    _, _, pz = nb.sep(geo.outputs['Position'])
    ix, iy, _ = nb.sep(geo.outputs['Incoming'])
    hl = nb.math('MAXIMUM', nb.math('SQRT', nb.math('ADD', nb.math('MULTIPLY', ix, ix), nb.math('MULTIPLY', iy, iy))), 1e-4)
    hor = horizon_col(nb, nb.math('DIVIDE', nb.math('MULTIPLY', ix, -1.0), hl), nb.math('DIVIDE', nb.math('MULTIPLY', iy, -1.0), hl))
    hrel = nb.math('MAXIMUM', nb.math('SUBTRACT', pz, G), 0.0)
    dens = nb.math('ADD', 0.55, nb.math('MULTIPLY', 1.3, nb.math('EXPONENT', nb.math('MULTIPLY', hrel, -1.0 / 70.0))))
    dist = cam.outputs['View Distance']
    od = nb.math('MULTIPLY', nb.math('MAXIMUM', nb.math('SUBTRACT', dist, 90.0), 0.0), nb.math('DIVIDE', dens, FOG_L))
    fac = nb.math('SUBTRACT', 1.0, nb.math('EXPONENT', nb.math('MULTIPLY', od, -1.0)))
    # near haze: warm sodium glow of the streets; far haze: the horizon sky itself (no seam at the ground edge)
    farw = nb.math('MINIMUM', nb.math('DIVIDE', dist, 3200.0), 1.0)
    street = nb.vmath('MULTIPLY', hor, (0.30, 0.26, 0.26))
    street = nb.vmath('ADD', street, nb.comb(0.10, 0.055, 0.03))
    col = nb.mixc(farw, street, nb.vmath('MULTIPLY', hor, (0.62, 0.62, 0.62)))
    em = nb.node('ShaderNodeEmission'); nb.link(col, em.inputs[0]); em.inputs[1].default_value = 1.0
    mix = nb.node('ShaderNodeMixShader'); nb.link(fac, mix.inputs[0]); nb.link(shader_out, mix.inputs[1]); nb.link(em.outputs[0], mix.inputs[2])
    nb.link(mix.outputs[0], out.inputs[0])


def V(nb, c):
    return nb.comb(c[0], c[1], c[2])

def vscale(nb, v, s):
    return nb.vmath('MULTIPLY', v, nb.comb(s, s, s))

def vadd(nb, a, b):
    return nb.vmath('ADD', a, b)


def building_mat(G, WIN=1.0):
    m = bpy.data.materials.new('Building'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); nb = NB(nt)
    nb.node('ShaderNodeOutputMaterial')
    geo = nb.node('ShaderNodeNewGeometry')
    at = lambda k: nb.node('ShaderNodeAttribute', attribute_name=k).outputs['Fac']
    bid, bt, bbot, btop = at('bid'), at('btype'), at('bbot'), at('btop')
    isT = lambda k: nb.math('COMPARE', bt, float(k), 0.2)
    walk, prew, glass, deco, sup, roof, crown, bea, tank, lamp = [isT(k) for k in range(10)]
    res = nb.math('ADD', walk, prew)
    off = nb.math('ADD', nb.math('ADD', glass, deco), sup)
    glassy = nb.math('ADD', glass, sup)
    px, py, pz = nb.sep(geo.outputs['Position']); nx, ny, nz = nb.sep(geo.outputs['Normal'])
    zr = nb.math('SUBTRACT', pz, G)
    facade = nb.math('LESS_THAN', nb.math('ABSOLUTE', nz), 0.5)
    topf = nb.math('GREATER_THAN', nz, 0.5)
    s = nb.mixf(nb.math('GREATER_THAN', nb.math('ABSOLUTE', ny), nb.math('ABSOLUTE', nx)), py, px)
    colw = nb.math('ADD', 1.5, nb.math('ADD', nb.math('MULTIPLY', walk, 0.25), nb.math('ADD', nb.math('MULTIPLY', prew, 0.1), nb.math('MULTIPLY', deco, 0.3))))
    flh = nb.math('SUBTRACT', 3.9, nb.math('MULTIPLY', res, 0.7))
    pat = nb.math('FRACT', nb.math('MULTIPLY', bid, 13.7))
    colw = nb.math('MULTIPLY', colw, nb.math('ADD', 0.75, nb.math('MULTIPLY', pat, 0.9)))
    ribbon = nb.math('MULTIPLY', glassy, nb.math('GREATER_THAN', nb.math('FRACT', nb.math('MULTIPLY', bid, 23.3)), 0.55))
    cs = nb.math('DIVIDE', s, colw); cv = nb.math('DIVIDE', zr, flh)
    fx = nb.math('FRACT', cs); fy = nb.math('FRACT', cv)
    xlo = nb.math('ADD', 0.05, nb.math('ADD', nb.math('MULTIPLY', res, 0.19), nb.math('MULTIPLY', deco, 0.26)))
    ylo = nb.math('ADD', 0.09, nb.math('ADD', nb.math('MULTIPLY', res, 0.17), nb.math('MULTIPLY', deco, 0.06)))
    yhi = nb.math('SUBTRACT', 0.9, nb.math('MULTIPLY', res, 0.08))
    ylo = nb.math('ADD', ylo, nb.math('MULTIPLY', res, nb.math('MULTIPLY', nb.math('SUBTRACT', nb.math('FRACT', nb.math('MULTIPLY', bid, 19.1)), 0.5), 0.14)))
    xlo = nb.mixf(ribbon, xlo, 0.006); ylo = nb.mixf(ribbon, ylo, 0.28); yhi = nb.mixf(ribbon, yhi, 0.86)   # ribbon: continuous glass bands over spandrels
    plain = nb.math('ADD', nb.math('ADD', roof, crown), nb.math('ADD', nb.math('ADD', bea, tank), lamp))
    body = nb.math('SUBTRACT', 1.0, plain)
    win = nb.math('MULTIPLY', nb.math('MULTIPLY', nb.between(fx, xlo, nb.math('SUBTRACT', 1.0, xlo)), nb.between(fy, ylo, yhi)), nb.math('MULTIPLY', facade, body))
    winA = nb.math('MULTIPLY', win, nb.math('GREATER_THAN', zr, 6.5))
    b1k = nb.math('MULTIPLY', bid, 1000.0)
    cell = nb.comb(nb.math('FLOOR', cs), nb.math('FLOOR', cv), b1k)
    n1, _ = nb.noise(cell); n2, _ = nb.noise(nb.vmath('ADD', cell, (17.3, 5.1, 2.7))); n3, _ = nb.noise(nb.vmath('ADD', cell, (3.3, 9.9, 1.1)))
    nf, _ = nb.noise(nb.comb(0.5, nb.math('FLOOR', cv), nb.math('ADD', b1k, 7.0)))
    ns, _ = nb.noise(nb.comb(nb.math('FLOOR', nb.math('DIVIDE', cs, 6.0)), nb.math('FLOOR', cv), nb.math('ADD', b1k, 13.0)))
    thr_res = nb.math('ADD', 0.58, nb.math('MULTIPLY', nb.math('FRACT', nb.math('MULTIPLY', bid, 31.0)), 0.32))
    lit_res = nb.math('GREATER_THAN', n1, thr_res)
    thr_off = nb.math('ADD', 0.45, nb.math('MULTIPLY', nb.math('FRACT', nb.math('MULTIPLY', bid, 17.0)), 0.45))
    lit_off = nb.math('MULTIPLY', nb.math('MULTIPLY', nb.math('GREATER_THAN', nf, thr_off), nb.math('GREATER_THAN', ns, 0.42)), nb.math('GREATER_THAN', n1, 0.12))
    lit = nb.math('MULTIPLY', nb.mixf(off, lit_res, lit_off), winA)
    n2s = nb.math('POWER', n2, 2.0)
    warm = nb.mixc(n2s, (1.0, 0.46, 0.18, 1), (1.0, 0.72, 0.45, 1))
    rescol = nb.mixc(nb.math('GREATER_THAN', n3, 0.9), warm, (0.55, 0.70, 1.0, 1))
    offcol = nb.mixc(nb.math('GREATER_THAN', nb.math('FRACT', nb.math('MULTIPLY', bid, 7.0)), 0.6), (0.74, 0.86, 1.0, 1), (1.0, 0.84, 0.62, 1))
    wcol = nb.mixc(off, rescol, offcol)
    inten = nb.mixf(off, nb.math('ADD', 0.3, nb.math('MULTIPLY', n2s, 1.7)), nb.math('ADD', 0.55, nb.math('MULTIPLY', n2, 0.6)))
    e_win = vscale(nb, wcol, nb.math('MULTIPLY', nb.math('MULTIPLY', lit, inten), WIN))
    # storefronts: the lit street wall of the canyons
    sc = nb.comb(nb.math('FLOOR', nb.math('DIVIDE', s, 4.0)), 0.0, nb.math('ADD', b1k, 3.0))
    sn, _ = nb.noise(sc)
    shop = nb.math('MULTIPLY', nb.math('MULTIPLY', nb.between(zr, 0.7, 4.6), nb.math('MULTIPLY', facade, body)), nb.math('GREATER_THAN', sn, 0.3))
    shop = nb.math('MULTIPLY', shop, nb.math('LESS_THAN', bt, 4.5))
    e_shop = vscale(nb, nb.mixc(sn, (1.0, 0.62, 0.32, 1), (1.0, 0.85, 0.65, 1)), nb.math('MULTIPLY', shop, nb.math('ADD', 1.2, nb.math('MULTIPLY', sn, 2.2))))
    # floodlit crowns (gradient fades upward from the setback lights)
    g = nb.math('DIVIDE', nb.math('SUBTRACT', pz, bbot), nb.math('MAXIMUM', nb.math('SUBTRACT', btop, bbot), 0.5))
    flood = nb.math('MULTIPLY', nb.math('POWER', nb.math('SUBTRACT', 1.0, nb.math('MINIMUM', nb.math('MAXIMUM', g, 0.0), 1.0)), 1.3), crown)
    cb = nb.math('FRACT', nb.math('MULTIPLY', bid, 5.0))
    ccol = nb.mixc(nb.math('GREATER_THAN', cb, 0.82), (1.0, 0.80, 0.55, 1), nb.mixc(nb.math('GREATER_THAN', cb, 0.91), (0.45, 0.70, 1.0, 1), (1.0, 0.92, 0.80, 1)))
    e_crown = vscale(nb, ccol, nb.math('MULTIPLY', flood, 3.0))
    e_bea = vscale(nb, V(nb, (1.0, 0.04, 0.02)), nb.math('MULTIPLY', bea, 40.0))
    e_lamp = vscale(nb, V(nb, (1.0, 0.84, 0.6)), nb.math('MULTIPLY', lamp, 14.0))
    emis = vadd(nb, vadd(nb, vadd(nb, e_win, e_shop), vadd(nb, e_crown, e_bea)), e_lamp)
    # base colours
    nr, _ = nb.noise(nb.vmath('FLOOR', nb.vmath('DIVIDE', geo.outputs['Position'], (3.0, 3.0, 3.0))))
    skin = nb.math('FRACT', nb.math('MULTIPLY', bid, 11.3)); sv = nb.math('FRACT', nb.math('MULTIPLY', bid, 3.7))
    redbrick = nb.mixc(sv, (0.17, 0.06, 0.035, 1), (0.28, 0.12, 0.07, 1))
    brownst = nb.mixc(sv, (0.10, 0.05, 0.035, 1), (0.16, 0.09, 0.06, 1))
    limest = nb.mixc(nb.math('FRACT', nb.math('MULTIPLY', bid, 5.3)), (0.42, 0.37, 0.29, 1), (0.56, 0.51, 0.42, 1))
    greyst = nb.mixc(sv, (0.20, 0.19, 0.18, 1), (0.30, 0.29, 0.27, 1))
    brick = nb.mixc(nb.math('GREATER_THAN', skin, 0.55), redbrick, nb.mixc(nb.math('GREATER_THAN', skin, 0.8), brownst, limest))
    stone = nb.mixc(nb.math('GREATER_THAN', skin, 0.5), limest, nb.mixc(nb.math('GREATER_THAN', skin, 0.78), redbrick, greyst))
    bronzeg = (0.07, 0.045, 0.025, 1); blueg = (0.02, 0.05, 0.10, 1); greyg = (0.035, 0.04, 0.05, 1)
    glassc = nb.mixc(nb.math('GREATER_THAN', skin, 0.34), bronzeg, nb.mixc(nb.math('GREATER_THAN', skin, 0.68), blueg, greyg))
    roofc = nb.mixc(nr, (0.04, 0.04, 0.042, 1), (0.13, 0.12, 0.11, 1))
    col = glassc
    col = nb.mixc(prew, col, stone); col = nb.mixc(walk, col, brick); col = nb.mixc(deco, col, (0.42, 0.38, 0.32, 1))
    col = nb.mixc(roof, col, roofc); col = nb.mixc(tank, col, (0.17, 0.10, 0.06, 1)); col = nb.mixc(crown, col, (0.45, 0.42, 0.38, 1))
    col = nb.mixc(nb.math('MULTIPLY', topf, body), col, roofc)
    col = nb.mixc(win, col, (0.006, 0.008, 0.012, 1))
    bsdf = nb.node('ShaderNodeBsdfPrincipled')
    nb.link(col, bsdf.inputs['Base Color'])
    nb.link(nb.mixf(win, nb.mixf(glassy, 0.85, 0.3), 0.05), bsdf.inputs['Roughness'])
    nb.link(nb.math('MULTIPLY', nb.math('MULTIPLY', glassy, nb.math('SUBTRACT', 1.0, win)), nb.math('MULTIPLY', facade, 0.6)), bsdf.inputs['Metallic'])
    nb.link(emis, bsdf.inputs['Emission Color']); bsdf.inputs['Emission Strength'].default_value = 1.0
    haze_wrap(m, nb, bsdf.outputs[0], G)
    return m


def road_mat(G):
    m = bpy.data.materials.new('Road'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); nb = NB(nt)
    nb.node('ShaderNodeOutputMaterial')
    geo = nb.node('ShaderNodeNewGeometry'); px, py, pz = nb.sep(geo.outputs['Position'])
    at = lambda k: nb.node('ShaderNodeAttribute', attribute_name=k).outputs['Fac']
    c, hw, dirv, alx = at('across'), at('halfw'), at('dirv'), at('alongx')
    a = nb.mixf(alx, py, px)
    cm = nb.math('MULTIPLY', c, hw); acm = nb.math('ABSOLUTE', cm)
    ch = nb.math('SUBTRACT', hw, 4.5)                    # carriageway half width (4.5 m sidewalks)
    walk = nb.math('GREATER_THAN', acm, ch)
    lane = nb.math('FLOOR', nb.math('DIVIDE', nb.math('ADD', cm, ch), 3.25))
    lanec = nb.math('ADD', nb.math('MULTIPLY', nb.math('ADD', lane, 0.5), 3.25), nb.math('MULTIPLY', ch, -1.0))
    dl = nb.math('ABSOLUTE', nb.math('SUBTRACT', cm, lanec))
    seg = nb.math('FLOOR', nb.math('DIVIDE', a, 11.0))
    nsg, _ = nb.noise(nb.comb(seg, lane, nb.math('ADD', nb.math('MULTIPLY', alx, 5.0), nb.math('FLOOR', nb.math('DIVIDE', nb.mixf(alx, px, py), 50.0)))))
    trail = nb.math('MULTIPLY', nb.math('MULTIPLY', nb.math('LESS_THAN', dl, 0.75), nb.math('SUBTRACT', 1.0, walk)), nb.math('GREATER_THAN', nsg, 0.3))
    dv = nb.mixf(nb.math('GREATER_THAN', dirv, 1.5), dirv, nb.math('GREATER_THAN', cm, 0.0))
    tcol = nb.mixc(dv, (1.0, 0.07, 0.025, 1), (1.0, 0.88, 0.70, 1))
    tint = nb.math('MULTIPLY', trail, nb.math('ADD', 1.2, nb.math('MULTIPLY', nsg, nb.mixf(dv, 2.6, 4.2))))
    e_tr = vscale(nb, tcol, tint)
    # kerb lamps every 30 m + light pools; storefront spill on the sidewalks
    la = nb.math('ABSOLUTE', nb.math('SUBTRACT', nb.math('FRACT', nb.math('DIVIDE', a, 30.0)), 0.5))
    lc = nb.math('ABSOLUTE', nb.math('SUBTRACT', acm, nb.math('SUBTRACT', ch, 0.4)))
    dist = nb.math('SQRT', nb.math('ADD', nb.math('POWER', nb.math('MULTIPLY', la, 30.0), 2.0), nb.math('POWER', lc, 2.0)))
    e_l = nb.math('ADD', nb.math('MULTIPLY', nb.math('LESS_THAN', dist, 0.7), 24.0), nb.math('MULTIPLY', nb.math('EXPONENT', nb.math('MULTIPLY', dist, -0.28)), 0.32))
    spill = nb.math('MULTIPLY', walk, nb.math('ADD', 0.06, nb.math('MULTIPLY', nb.math('GREATER_THAN', acm, nb.math('SUBTRACT', hw, 1.5)), 0.22)))
    e_lamp = vscale(nb, V(nb, (1.0, 0.66, 0.36)), nb.math('ADD', e_l, spill))
    bsdf = nb.node('ShaderNodeBsdfPrincipled')
    nb.link(nb.mixc(walk, (0.022, 0.022, 0.024, 1), (0.09, 0.085, 0.08, 1)), bsdf.inputs['Base Color'])
    nb.link(nb.mixf(walk, 0.32, 0.8), bsdf.inputs['Roughness'])
    nb.link(vadd(nb, e_tr, e_lamp), bsdf.inputs['Emission Color']); bsdf.inputs['Emission Strength'].default_value = 1.0
    haze_wrap(m, nb, bsdf.outputs[0], G)
    return m


def simple_mat(name, G, color, rough, emis=None, bump=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; nb = NB(nt)
    b = nt.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*color, 1); b.inputs['Roughness'].default_value = rough
    if emis is not None:
        nb.link(emis(nb), b.inputs['Emission Color']); b.inputs['Emission Strength'].default_value = 1.0
    if bump is not None:
        bump(nb, b)
    haze_wrap(m, nb, b.outputs[0], G)
    return m


def park_emis(nb):
    tc = nb.node('ShaderNodeNewGeometry')
    vo = nb.node('ShaderNodeTexVoronoi'); vo.inputs['Scale'].default_value = 1.0 / 28.0
    nb.link(tc.outputs['Position'], vo.inputs['Vector'])
    dot = nb.math('LESS_THAN', vo.outputs['Distance'], 0.025)
    return vscale(nb, V(nb, (1.0, 0.75, 0.45)), nb.math('MULTIPLY', dot, 9.0))


def water_bump(nb, b):
    geo = nb.node('ShaderNodeNewGeometry')
    sc = nb.vmath('MULTIPLY', geo.outputs['Position'], (0.05, 0.4, 0.0))
    nz = nb.node('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 1.0; nz.inputs['Detail'].default_value = 4.0
    nb.link(sc, nz.inputs['Vector'])
    bp = nb.node('ShaderNodeBump'); bp.inputs['Strength'].default_value = 0.35
    nb.link(nz.outputs['Fac'], bp.inputs['Height']); nb.link(bp.outputs['Normal'], b.inputs['Normal'])


# ------------------------------------------------------------------ roads
def subtract(lo, hi, holes):
    segs = [(lo, hi)]
    for a, b in holes:
        out = []
        for s0, s1 in segs:
            if b <= s0 or a >= s1: out.append((s0, s1)); continue
            if a > s0: out.append((s0, a))
            if b < s1: out.append((b, s1))
        segs = out
    return segs


def roads(coll, G, mat):
    verts, faces, A = [], [], {'across': [], 'halfw': [], 'dirv': [], 'alongx': []}
    def quad(p, across, hw, dv, ax):
        b = len(verts); verts.extend(p); faces.append((b, b + 1, b + 2, b + 3))
        A['across'].extend(across); A['halfw'].extend([hw] * 4); A['dirv'].extend([dv] * 4); A['alongx'].extend([ax] * 4)
    nA = int(R / AVS) + 2; nS = int(R / STS) + 2
    for j in range(-nS, nS + 1):                     # streets (along x)
        yc = ST0 + j * STS; hw = STW / 2
        if abs(yc) > R: continue
        holes = [RIVER, HUDSON] + ([(PARK[0] + AVW / 2, PARK[1] - AVW / 2)] if yc > PARK[2] + 1 else [])
        for x0, x1 in subtract(-R, R, holes):
            quad([(x0, yc - hw, G + 0.05), (x1, yc - hw, G + 0.05), (x1, yc + hw, G + 0.05), (x0, yc + hw, G + 0.05)], [-1, -1, 1, 1], hw, float(j % 2), 1.0)
    for i in range(-nA, nA + 1):                     # avenues (along y)
        xc = AV0 + i * AVS; hw = AVW / 2
        if abs(xc) > R or RIVER[0] - 10 < xc < RIVER[1] + 10 or HUDSON[0] < xc < HUDSON[1]: continue
        holes = [(PARK[2] + STW / 2, R)] if PARK[0] + 1 < xc < PARK[1] - 1 else []
        for y0, y1 in subtract(-R, R, holes):
            quad([(xc - hw, y0, G + 0.06), (xc + hw, y0, G + 0.06), (xc + hw, y1, G + 0.06), (xc - hw, y1, G + 0.06)], [-1, 1, 1, -1], hw, 2.0 if i % 3 == 0 else float(i % 2), 0.0)
    me = bpy.data.meshes.new('Roads'); me.from_pydata(verts, [], faces)
    for k, v in A.items():
        at = me.attributes.new(k, 'FLOAT', 'POINT')
        for n, x in enumerate(v): at.data[n].value = x
    me.materials.append(mat)
    ob = bpy.data.objects.new('Roads', me); coll.objects.link(ob)


def flat(coll, name, x0, x1, y0, y1, z, mat):
    me = bpy.data.meshes.new(name); me.from_pydata([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], [], [(0, 1, 2, 3)]); me.materials.append(mat)
    ob = bpy.data.objects.new(name, me); coll.objects.link(ob); return ob


# ------------------------------------------------------------------ sky (blue hour, sun just set to the WNW)
def sky(scene):
    from common import NB as _NB
    w = bpy.data.worlds.new('Dusk'); scene.world = w; w.use_nodes = True; nt = w.node_tree; nt.nodes.clear(); nb = _NB(nt)
    out = nb.node('ShaderNodeOutputWorld')
    tc = nb.node('ShaderNodeTexCoord'); dx, dy, dz = nb.sep(tc.outputs['Generated'])
    elev = nb.math('ARCSINE', nb.math('MINIMUM', nb.math('MAXIMUM', dz, -1.0), 1.0))
    sundir = nb.math('ADD', nb.math('MULTIPLY', dx, -0.92), nb.math('MULTIPLY', dy, 0.38))
    sunf = nb.math('POWER', nb.math('MAXIMUM', nb.math('ADD', nb.math('MULTIPLY', sundir, 0.5), 0.5), 0.0), 3.0)
    t = nb.math('POWER', nb.math('MAXIMUM', elev, 0.0), 0.5)
    grad = nb.mixc(nb.math('MINIMUM', nb.math('MULTIPLY', t, 1.3), 1.0), (0.26, 0.27, 0.46, 1), (0.018, 0.032, 0.10, 1))
    glow = nb.math('MULTIPLY', nb.math('EXPONENT', nb.math('MULTIPLY', nb.math('MAXIMUM', elev, 0.0), -11.0)), nb.math('ADD', 0.18, nb.math('MULTIPLY', sunf, 1.5)))
    sky_ = nb.vmath('ADD', grad, nb.vmath('MULTIPLY', nb.comb(glow, glow, glow), (1.0, 0.44, 0.22)))
    sky_ = nb.mixc(nb.math('LESS_THAN', elev, 0.0), sky_, (0.24, 0.19, 0.22, 1))
    bg = nb.node('ShaderNodeBackground'); nb.link(sky_, bg.inputs[0]); bg.inputs[1].default_value = 1.0
    nb.link(bg.outputs[0], out.inputs[0])


# ------------------------------------------------------------------ entry point
def build(scene, coll, H, tower, seed=42):
    G = -H
    rnd = random.Random(seed)
    MB = building_mat(G); MR = road_mat(G)
    MG = simple_mat('Ground', G, (0.03, 0.03, 0.032), 0.9)
    MP = simple_mat('Park', G, (0.012, 0.02, 0.01), 0.95, emis=park_emis)
    MW = simple_mat('Water', G, (0.004, 0.006, 0.01), 0.05, bump=water_bump)
    cm = CityMesh(); n = gen_buildings(cm, G, tower, rnd); gen_bridge(cm, G)
    city = cm.to_object('City', MB, coll)
    cmT = CityMesh(); cmT.prism(rect(*tower), G, G + H - 0.6, {'bid': 0.31, 't': T_GLASS})
    cmT.to_object('OwnTower', MB, coll)
    roads(coll, G, MR)
    flat(coll, 'Ground', -R * 8, R * 8, -R * 8, R * 8, G, MG)
    flat(coll, 'Park', PARK[0] + AVW / 2, PARK[1] - AVW / 2, PARK[2] + STW / 2, R * 1.2, G + 0.1, MP)
    for nm, (xa, xb) in (('RiverE', RIVER), ('RiverW', HUDSON)):
        flat(coll, nm, xa, xb, -R * 8, R * 8, G + 0.12, MW)
    sky(scene)
    return n, len(city.data.polygons)

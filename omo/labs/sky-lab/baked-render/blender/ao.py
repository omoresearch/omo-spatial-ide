# Bake ambient occlusion on the SAME lightmap UVs (uses baked.blend saved by bake.py). Used as aoMap (specular occlusion) in three.js.
# Run: blender -b blender/baked.blend -P blender/ao.py -- [samples] [size]
import bpy, os, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import gpu_setup
a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
S = int(a[0]) if a else 64; N = int(a[1]) if len(a) > 1 else 2048
LANE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..')); OUT = os.environ.get('BAKED_OUT') or os.path.join(LANE, 'baked', 'next')
sc = bpy.context.scene; gpu_setup(sc, S); t0 = time.time()
sc.render.bake.margin = 8; sc.render.bake.margin_type = 'EXTEND'
sc.world.light_settings.distance = 0.6
for g, n in (('FLOOR', N // 2), ('ARCH', N), ('FURN', N)):
    ob = bpy.data.objects['LM_' + g]
    im = bpy.data.images.new('ao_' + g, n, n, float_buffer=False, alpha=False)
    nodes = []
    for slot in ob.material_slots:
        m = slot.material; nd = m.node_tree.nodes.new('ShaderNodeTexImage'); nd.image = im
        m.node_tree.nodes.active = nd; nodes.append((m, nd))
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.object.bake(type='AO', uv_layer='LM', margin=8)
    px = np.array(im.pixels[:]).reshape(n, n, 4)
    im.filepath_raw = os.path.join(OUT, f'ao_{g.lower()}.png'); im.file_format = 'PNG'; im.save()
    print('AO', g, n, 'mean', px[..., 0].mean().round(3), round(time.time() - t0, 1), 's', flush=True)
    for m, nd in nodes: m.node_tree.nodes.remove(nd)

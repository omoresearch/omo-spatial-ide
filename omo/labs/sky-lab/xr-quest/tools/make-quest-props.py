# Blender: decimated copies of the CC0 props for ?quest=1 -> quest/cc0/<id>/<id>.glb (textures kept, embedded at 512 px).
# Run: blender -b --python tools/make-quest-props.py
import bpy, os, json
LANE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
props = json.load(open(os.path.join(LANE, 'baked', 'props.json')))
TARGET = 12000   # triangles per prop
for pid in sorted({p['id'] for p in props}):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(LANE, 'vendor', 'cc0', pid, pid + '.gltf'))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    before = sum(len(o.data.polygons) and sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    ratio = min(1.0, TARGET / max(1, before))
    for o in meshes:
        if ratio < 1.0:
            m = o.modifiers.new('dec', 'DECIMATE'); m.ratio = ratio; m.use_collapse_triangulate = True
            bpy.context.view_layer.objects.active = o; bpy.ops.object.modifier_apply(modifier=m.name)
    after = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    for im in bpy.data.images:
        if im.size[0] > 512: im.scale(512, 512)
    out = os.path.join(LANE, 'quest', 'cc0', pid); os.makedirs(out, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(out, pid + '.glb'), export_format='GLB', export_image_format='JPEG', export_jpeg_quality=88)
    print('QPROP', pid, before, '->', after)

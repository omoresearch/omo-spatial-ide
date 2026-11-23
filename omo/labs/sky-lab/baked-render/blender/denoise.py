# Denoise baked lightmap EXRs with Blender's compositor (OpenImageDenoise). Usage: blender -b -P denoise.py -- in.exr out.exr
import bpy, sys, time
a = sys.argv[sys.argv.index('--') + 1:]
t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
im = bpy.data.images.load(a[0]); w, h = im.size
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
sc.use_nodes = True; nt = sc.node_tree; nt.nodes.clear()
src = nt.nodes.new('CompositorNodeImage'); src.image = im
dn = nt.nodes.new('CompositorNodeDenoise'); dn.use_hdr = True
try: dn.prefilter = 'NONE'
except Exception: pass
comp = nt.nodes.new('CompositorNodeComposite')
nt.links.new(src.outputs[0], dn.inputs['Image']); nt.links.new(dn.outputs[0], comp.inputs[0])
sc.view_settings.view_transform = 'Standard'
s = sc.render.image_settings; s.file_format = 'OPEN_EXR'; s.color_depth = '16'; s.exr_codec = 'DWAA'; s.color_mode = 'RGB'
sc.render.filepath = a[1]
bpy.ops.render.render(write_still=True)
print('DENOISED', a[1], w, h, round(time.time() - t0, 1), 's')

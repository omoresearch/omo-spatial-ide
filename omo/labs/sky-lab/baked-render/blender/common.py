import bpy, math

def gpu_setup(scene, samples):
    p = bpy.context.preferences.addons['cycles'].preferences
    p.compute_device_type = 'OPTIX'
    p.get_devices()
    for d in p.devices:
        d.use = d.type == 'OPTIX'
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'GPU'
    scene.cycles.samples = samples
    scene.cycles.use_light_tree = True


class NB:
    """Tiny node-graph builder."""
    def __init__(self, tree):
        self.t = tree; self.n = tree.nodes; self.l = tree.links

    def node(self, kind, **props):
        nd = self.n.new(kind)
        for k, v in props.items():
            setattr(nd, k, v)
        return nd

    def link(self, a, b):
        self.l.new(a, b)

    def _in(self, sock, v):
        if isinstance(v, (int, float)):
            sock.default_value = v
        elif isinstance(v, tuple):
            sock.default_value = v
        else:
            self.link(v, sock)

    def math(self, op, a, b=0.0, c=None, clamp=False):
        nd = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self._in(nd.inputs[0], a); self._in(nd.inputs[1], b)
        if c is not None:
            self._in(nd.inputs[2], c)
        return nd.outputs[0]

    def vmath(self, op, a, b=None, out=0):
        nd = self.node('ShaderNodeVectorMath', operation=op)
        self._in(nd.inputs[0], a)
        if b is not None:
            self._in(nd.inputs[1], b)
        return nd.outputs[out]

    def sep(self, v):
        nd = self.node('ShaderNodeSeparateXYZ'); self._in(nd.inputs[0], v)
        return nd.outputs[0], nd.outputs[1], nd.outputs[2]

    def comb(self, x, y, z):
        nd = self.node('ShaderNodeCombineXYZ')
        self._in(nd.inputs[0], x); self._in(nd.inputs[1], y); self._in(nd.inputs[2], z)
        return nd.outputs[0]

    def mixc(self, fac, a, b):
        nd = self.node('ShaderNodeMix', data_type='RGBA')
        self._in(nd.inputs[0], fac); self._in(nd.inputs[6], a); self._in(nd.inputs[7], b)
        return nd.outputs[2]

    def mixf(self, fac, a, b):
        nd = self.node('ShaderNodeMix', data_type='FLOAT')
        self._in(nd.inputs[0], fac); self._in(nd.inputs[2], a); self._in(nd.inputs[3], b)
        return nd.outputs[0]

    def noise(self, vec):
        nd = self.node('ShaderNodeTexWhiteNoise', noise_dimensions='3D')
        self._in(nd.inputs['Vector'], vec)
        return nd.outputs['Value'], nd.outputs['Color']

    def between(self, x, lo, hi):
        return self.math('MULTIPLY', self.math('GREATER_THAN', x, lo), self.math('LESS_THAN', x, hi))

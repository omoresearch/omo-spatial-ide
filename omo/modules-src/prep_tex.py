# Texture prep for the room modules (system python + PIL, run once; outputs are committed):
# - parquet_desat_2k.jpg: the penthouse herringbone, saturation x0.6 (calmer honey-grey oak)
# - CC0 wood atlases re-toned to the walnut veneer (ONE wood tone per room), desk lamp to charcoal
import numpy as np, os
from PIL import Image
H = os.path.dirname(os.path.abspath(__file__)); M = os.path.expanduser('~/dev/omo-sky-lab/cc0-assets/assets/models')
def load(p): return np.asarray(Image.open(p).convert('RGB')).astype(float)
def save(a, p): Image.fromarray(np.clip(a, 0, 255).astype('uint8')).save(p, quality=92); print('TEX', p, a.reshape(-1, 3).mean(0).round())
a = load(f'{H}/assets/herringbone_parquet_diff_2k.jpg'); l = (a * [0.299, 0.587, 0.114]).sum(2, keepdims=True)
save((l + (a - l) * 0.6) * [0.985, 1.0, 1.02], f'{H}/assets/parquet_desat_2k.jpg')
save(load(f'{H}/assets/walnut_veneer_diff_1k.jpg') * [0.60, 0.58, 0.56], f'{H}/assets/walnut_dark_1k.jpg')   # the room's one wood: dark walnut
wal = load(f'{H}/assets/walnut_dark_1k.jpg').reshape(-1, 3).mean(0)
def retone(src, dst, target, gain=1.0):
    a = load(src); l = (a * [0.299, 0.587, 0.114]).sum(2, keepdims=True); k = l / l.mean()
    save(np.asarray(target) * gain * (1 + (k - 1) * 0.8), dst)
retone(f'{M}/side_table_01/textures/side_table_01_diff_1k.jpg', f'{H}/gen/side_table_01_walnut.jpg', wal, 1.0)
retone(f'{M}/modern_arm_chair_01/textures/modern_arm_chair_01_legs_diff_1k.jpg', f'{H}/gen/arm_chair_legs_walnut.jpg', wal, 1.0)
retone(f'{M}/desk_lamp_arm_01/textures/desk_lamp_arm_01_diff_1k.jpg', f'{H}/gen/desk_lamp_black.jpg', (22, 21, 20))
# mid-century lounge chair atlas (wood + leather) darkened toward the walnut
save(load(f'{M}/mid_century_lounge_chair/textures/mid_century_lounge_chair_diff_1k.jpg') * [0.80, 0.78, 0.76], f'{H}/gen/lounge_chair_walnut.jpg')

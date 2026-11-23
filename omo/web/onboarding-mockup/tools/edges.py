import sys, glob
from PIL import Image, ImageStat
for f in sorted(sys.argv[1:]):
    im = Image.open(f).convert("RGB"); w, h = im.size; b = max(4, w//60)
    strips = {"top": im.crop((0,0,w,b)), "bot": im.crop((0,h-b,w,h)), "left": im.crop((0,0,b,h)), "right": im.crop((w-b,0,w,h))}
    s = {k: round(max(ImageStat.Stat(v).mean),1) for k, v in strips.items()}
    mx = {k: max(c[1] for c in v.getextrema()) for k, v in strips.items()}
    print(f.split('/')[-1], f"{w}x{h}", Image.open(f).mode, "edge-mean", s, "edge-max", mx)

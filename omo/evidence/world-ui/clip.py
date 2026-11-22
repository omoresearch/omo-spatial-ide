import sys
from PIL import Image
for p in sys.argv[1:]:
    im = Image.open(p).convert('RGB'); w, h = im.size; px = im.load()
    n = 0; tot = 0
    for y in range(60, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]; tot += 1
            if r >= 250 and g >= 250 and b >= 250: n += 1
    print(f"{p}: clipped {100*n/tot:.2f}%")

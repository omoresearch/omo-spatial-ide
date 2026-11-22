#!/usr/bin/env python3
"""Store art from the REAL captures (listing/assets/raw/*). No invented UI: the only thing added is the title text
(Meta rule: branded assets carry the exact app title, nothing else; no taglines, badges, prices or corner text).
  python3 tools/make-store-art.py
Writes listing/assets/: screenshot-1..5.png (2560x1440 24-bit), cover-hero 3000x900, cover-landscape 2560x1440,
cover-square 1440x1440, cover-portrait 1008x1440, cover-mini 1080x360, icon 512x512, logo (transparent),
trailer-cover 2560x1440, and art-check.json (sizes, modes, title box inside the safe area).
TITLE is the WORKING name; if Harry picks another name, change TITLE and re-run (the art must match the Store title)."""
import json, os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

LANE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW, OUT = os.path.join(LANE, 'listing/assets/raw'), os.path.join(LANE, 'listing/assets')
TITLE = os.environ.get('OMO_TITLE', 'Omo Space')
FONT = '/usr/share/fonts/truetype/ubuntu/UbuntuSans[wdth,wght].ttf'
MINT = (124, 242, 208)

def font(px, weight=700):
    f = ImageFont.truetype(FONT, px)
    try: f.set_variation_by_axes([100, weight])
    except Exception: pass
    return f

def rgb(im): return im.convert('RGB')

def shade(im, top=0.0, mid=0.35, bottom=0.0):
    """darken the band behind the title so it reads on any frame (a soft vertical gradient, no shapes)."""
    w, h = im.size; g = Image.new('L', (1, h))
    for y in range(h):
        t = y / (h - 1); a = mid * max(0.0, 1 - abs(t - 0.5) / 0.5) ** 0.7 + top * (1 - t) ** 3 + bottom * t ** 3
        g.putpixel((0, y), int(255 * min(0.9, a)))
    g = g.resize((w, h)); dark = Image.new('RGB', (w, h), (6, 8, 12))
    return Image.composite(dark, rgb(im), g)

def title(im, frac, y_frac=0.5, weight=700):
    """centre the title; height of the cap line = frac of the image height (clamped to 70% width)."""
    w, h = im.size; d = ImageDraw.Draw(im)
    px = int(h * frac)
    while True:
        f = font(px, weight); bb = d.textbbox((0, 0), TITLE, font=f)
        if bb[2] - bb[0] <= 0.70 * w or px < 20: break
        px -= 4
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    x, y = (w - tw) // 2 - bb[0], int(h * y_frac - th / 2) - bb[1]
    glow = Image.new('L', im.size, 0); ImageDraw.Draw(glow).text((x, y), TITLE, font=f, fill=200)
    glow = glow.filter(ImageFilter.GaussianBlur(max(4, px // 10)))
    im.paste(Image.new('RGB', im.size, (0, 0, 0)), (0, 0), glow.point(lambda v: int(v * 0.6)))
    d.text((x, y), TITLE, font=f, fill=(244, 247, 250))
    # thin mint rule under the title: brand colour, not text
    ry = y + bb[3] + max(6, px // 9); rw = int(tw * 0.18)
    d.rounded_rectangle([w // 2 - rw // 2, ry, w // 2 + rw // 2, ry + max(3, px // 22)], radius=4, fill=MINT)
    return [x + bb[0], y + bb[1], x + bb[2], ry + max(3, px // 22)]

def fit(src, w, h, cx=0.5, cy=0.5):
    """scale + crop a capture to w x h around (cx, cy)."""
    s = max(w / src.width, h / src.height); im = src.resize((round(src.width * s), round(src.height * s)), Image.Resampling.LANCZOS)
    x = int(min(max(0, im.width * cx - w / 2), im.width - w)); y = int(min(max(0, im.height * cy - h / 2), im.height - h))
    return im.crop((x, y, x + w, y + h))

def main():
    chk = {'title': TITLE, 'assets': {}}
    def save(name, im, box=None, safe=None):
        p = os.path.join(OUT, name); rgb(im).save(p, optimize=True) if im.mode != 'RGBA' else im.save(p, optimize=True)
        r = {'size': list(Image.open(p).size), 'mode': Image.open(p).mode}
        if box: r['title_box'] = box
        if safe and box: r['title_in_safe_area'] = box[0] >= safe[0] and box[1] >= safe[1] and box[2] <= safe[2] and box[3] <= safe[3]; r['safe'] = safe
        chk['assets'][name] = r
    # screenshots: the real frames, untouched apart from 24-bit PNG (Meta: 5 required, no text or banners)
    # shot-3-place (panel moved aside) is kept in raw/ only: its terminal text duplicates shot-2 (Meta: no duplicates)
    order = ['shot-2-panel', 'shot-1-arrive', 'shot-4-desks', 'shot-6-teleport', 'shot-5-lounge']
    for i, n in enumerate(order, 1):
        im = Image.open(os.path.join(RAW, n + '.png')); assert im.size == (2560, 1440), (n, im.size)
        save(f'screenshot-{i}.png', rgb(im))
    # branded covers: each one from its own native-aspect clean render (cover-*.png), same design on all
    spec = [('cover-landscape.png', 'cover-landscape', 0.16, 0.42), ('cover-hero.png', 'cover-hero', 0.22, 0.5),
            ('cover-square.png', 'cover-square', 0.12, 0.42), ('cover-portrait.png', 'cover-portrait', 0.075, 0.40),
            ('cover-mini.png', 'cover-mini', 0.26, 0.5)]
    for out, src, frac, yf in spec:
        im = Image.open(os.path.join(RAW, src + '.png'))
        im = shade(im, mid=0.42)
        w, h = im.size
        box = title(im, frac, yf)
        # safe area: Meta's templates keep focal content away from the edges; we use the central 80% x 60% band
        safe = [int(w * 0.1), int(h * 0.2), int(w * 0.9), int(h * 0.7)]
        save(out, im, box, safe)
    # trailer cover: same design as the landscape cover
    lc = Image.open(os.path.join(OUT, 'cover-landscape.png')); save('trailer-cover.png', lc)
    # icon 512: the real desk-row render, the title initial, no other text
    base = fit(Image.open(os.path.join(RAW, 'cover-square.png')), 512, 512, 0.5, 0.55)
    base = shade(base, mid=0.55); d = ImageDraw.Draw(base); f = font(300, 760)
    bb = d.textbbox((0, 0), 'O', font=f); x, y = (512 - (bb[2] - bb[0])) // 2 - bb[0], (512 - (bb[3] - bb[1])) // 2 - bb[1] - 10
    d.text((x, y), 'O', font=f, fill=(244, 247, 250)); oy = y + bb[3] + 26; d.rounded_rectangle([216, oy, 296, oy + 12], radius=6, fill=MINT)
    save('icon.png', base)
    # transparent logo: title in white on alpha (for Meta's logo slot)
    f = font(560, 700); tmp = ImageDraw.Draw(Image.new('L', (10, 10))); bb = tmp.textbbox((0, 0), TITLE, font=f)
    lw, lh = int(bb[2] - bb[0] + 400), int(bb[3] - bb[1] + 400)
    logo = Image.new('RGBA', (lw, lh), (0, 0, 0, 0)); dl = ImageDraw.Draw(logo)
    dl.text((200 - bb[0], 150 - bb[1]), TITLE, font=f, fill=(244, 247, 250, 255))
    rw = int((bb[2] - bb[0]) * 0.18); dl.rounded_rectangle([lw // 2 - rw // 2, lh - 170, lw // 2 + rw // 2, lh - 146], radius=10, fill=MINT + (255,))
    save('logo.png', logo)
    with open(os.path.join(OUT, 'art-check.json'), 'w') as fh: json.dump(chk, fh, indent=1)
    want = {'cover-hero.png': (3000, 900), 'cover-landscape.png': (2560, 1440), 'cover-square.png': (1440, 1440), 'cover-portrait.png': (1008, 1440),
            'cover-mini.png': (1080, 360), 'icon.png': (512, 512), 'trailer-cover.png': (2560, 1440), **{f'screenshot-{i}.png': (2560, 1440) for i in range(1, 6)}}
    bad = [k for k, v in want.items() if tuple(chk['assets'][k]['size']) != v or chk['assets'][k]['mode'] != 'RGB']
    bad += [k for k, v in chk['assets'].items() if v.get('title_in_safe_area') is False]
    bad += [] if chk['assets']['logo.png']['mode'] == 'RGBA' and chk['assets']['logo.png']['size'][0] <= 9000 else ['logo.png']
    print(json.dumps(chk, indent=1)); print('ART', 'OK' if not bad else 'BAD ' + ', '.join(bad)); sys.exit(1 if bad else 0)

if __name__ == '__main__': main()

#!/usr/bin/env python3
"""Step 7: draw listing/why-better.png from the claims in listing/WHY-BETTER.md (rows kept short).
The header strip is a real app capture (listing/assets/screenshot-3.png). No invented UI."""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "listing", "why-better.png")
F = "/usr/share/fonts/truetype/dejavu/"
font = lambda n, s: ImageFont.truetype(F + n, s)
H1, B, R, S = font("DejaVuSans-Bold.ttf", 54), font("DejaVuSans-Bold.ttf", 26), font("DejaVuSans.ttf", 24), font("DejaVuSans.ttf", 20)

cols = ["Omo Space", "Immersed", "Virtual Desktop", "OVERAY DESK", "Fluid", "Windows App"]
# (row, cells) ; cell kinds: Y = good for user, N = bad for user, - = not checked / n/a, text = note
rows = [
    ("Live terminals are part of the room", ["Y Yes, 3 desks", "N PC stream", "N PC stream", "N PC stream", "N Browser", "N PC stream"]),
    ("Agents keep running, screen kept", ["Y Tested", "- n/a", "- n/a", "- n/a", "- not checked", "- n/a"]),
    ("No account or sign-in", ["Y None", "N Account", "- Meta ID only", "N Email", "N Email", "N Microsoft"]),
    ("No analytics code", ["Y None found", "- not checked", "- not checked", "- not checked", "- not checked", "- not checked"]),
    ("No remote switch-off", ["Y None in code", "- not checked", "N Reviews: yes", "- not checked", "N Lost purchases", "N Update broke it"]),
    ("Comfort: vignette, teleport, seated", ["Y All tested", "- not checked", "- not checked", "N Sitting only", "- not checked", "- not checked"]),
    ("Streams your Windows/Mac desktop", ["N No", "Y Yes", "Y Yes", "Y Yes", "N No", "Y Yes"]),
    ("On a real headset, with Store ratings", ["N Emulator only", "Y 4.3 (4.3K)", "Y 4.3 (10K)", "Y 4.1 (14)", "Y 4.5 (1.1K)", "Y 2.9 (202)"]),
    ("People in the same room", ["N Not built", "Y Cafe", "- not checked", "- not checked", "Y Watch together", "- not checked"]),
]
W = 2560
# screenshot-2: arrival view, three live desks, pointer on Desk 2. Crop right of the black corner at top-left.
shot = Image.open(os.path.join(ROOT, "listing", "assets", "screenshot-2.png")).convert("RGB")
strip_h = 360
x0, y0 = 520, 470
strip = shot.crop((x0, y0, 2560, y0 + round((2560 - x0) * strip_h / W))).resize((W, strip_h), Image.LANCZOS)
row_h, head_h, pad = 84, 80, 40
first_w = 560
col_w = (W - 2 * pad - first_w) // len(cols)
H = strip_h + 40 + head_h + row_h * len(rows) + 150
img = Image.new("RGB", (W, H), (10, 12, 18))
img.paste(strip, (0, 0))
d = ImageDraw.Draw(img, "RGBA")
d.rectangle([0, strip_h - 130, W, strip_h], fill=(10, 12, 18, 235))
d.text((pad, strip_h - 110), "Omo Space vs Quest desk apps: only claims we can prove", font=H1, fill=(245, 245, 250))
y = strip_h + 40
for i, c in enumerate(cols):
    x = pad + first_w + i * col_w
    if i == 0:
        d.rounded_rectangle([x + 4, y - 6, x + col_w - 4, y + head_h + row_h * len(rows)], 14, fill=(40, 70, 120, 120))
    d.text((x + col_w // 2, y + head_h // 2), c, font=B, fill=(255, 255, 255), anchor="mm")
y += head_h
COL = {"Y": (110, 220, 140), "N": (240, 120, 110), "-": (175, 180, 195)}
MARK = {"Y": "\u2713", "N": "\u2717", "-": "?"}
for r, (label, cells) in enumerate(rows):
    if r % 2 == 0:
        d.rectangle([pad, y, W - pad, y + row_h], fill=(255, 255, 255, 12))
    d.text((pad + 16, y + row_h // 2), label, font=R, fill=(230, 232, 240), anchor="lm")
    for i, cell in enumerate(cells):
        k, txt = cell[0], cell[2:]
        cx = pad + first_w + i * col_w + col_w // 2
        d.text((cx, y + row_h // 2), MARK[k] + " " + txt, font=S, fill=COL[k], anchor="mm")
    y += row_h
y += 30
d.text((pad, y), "\u2713 good for the user   \u2717 not good / missing   ? not checked or not applicable.  "
       "Rival cells: live Store pages and quoted reviews, 22 Nov 2026 (research/competitors.md).", font=S, fill=(195, 200, 212))
d.text((pad, y + 36), "Omo cells: listing/WHY-BETTER.md names the test log or file for each one. "
       "Omo Space is Early Access and has not run on a real Quest yet. Top image: a real capture of the app.",
       font=S, fill=(195, 200, 212))
img.save(OUT)
print(OUT, img.size)

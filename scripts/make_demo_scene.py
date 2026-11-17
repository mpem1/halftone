#!/usr/bin/env python3
"""Generate a neutral, non-personal demo scene for the halftone app.

Replaces the performer photo as public/sample.jpg. Deliberately abstract:
smooth tonal gradients, a shaded sphere, soft shadows and dune-like curves
— good highlight/midtone/shadow range for testing halftone screens.
"""
from PIL import Image, ImageDraw, ImageFilter
import math

W, H = 2048, 1152
img = Image.new("RGB", (W, H))
px = img.load()

# --- sky gradient: cool light top -> warm bottom
top = (214, 226, 236)
bot = (238, 228, 212)
for y in range(H):
    t = y / (H - 1)
    r = int(top[0] + (bot[0] - top[0]) * t)
    g = int(top[1] + (bot[1] - top[1]) * t)
    b = int(top[2] + (bot[2] - top[2]) * t)
    for x in range(W):
        px[x, y] = (r, g, b)

draw = ImageDraw.Draw(img)

# --- soft cloud bands (elliptical blurs, later blurred)
clouds = Image.new("L", (W, H), 0)
cdraw = ImageDraw.Draw(clouds)
import random
random.seed(7)
for i in range(26):
    cx = random.randint(-200, W + 200)
    cy = random.randint(int(H * 0.06), int(H * 0.62))
    rw = random.randint(160, 520)
    rh = max(18, rw // random.randint(5, 8))
    shade = random.randint(16, 60)
    cdraw.ellipse([cx - rw, cy - rh, cx + rw, cy + rh], fill=shade)
clouds = clouds.filter(ImageFilter.GaussianBlur(46))
img = Image.composite(Image.new("RGB", (W, H), (255, 255, 255)), img, clouds)
draw = ImageDraw.Draw(img)

# --- dune curves at the bottom (three layered ridges)
def ridge(base_y, amp, phase, color):
    pts = []
    for x in range(0, W + 16, 16):
        y = base_y + amp * math.sin(phase + x / W * math.pi * 2.2) \
                     + (amp // 3) * math.sin(phase * 1.7 + x / W * math.pi * 5.0)
        pts.append((x, y))
    poly = pts + [(W, H), (0, H)]
    draw.polygon(poly, fill=color)

ridge(int(H * 0.78), 46, 0.4, (176, 168, 152))
ridge(int(H * 0.85), 60, 2.1, (132, 124, 110))
ridge(int(H * 0.93), 52, 4.4, (84, 78, 70))

# --- main sphere with radial shading + soft ground shadow
scx, scy, sr = int(W * 0.40), int(H * 0.46), int(H * 0.27)

# soft ground shadow
sh = Image.new("L", (W, H), 0)
shdraw = ImageDraw.Draw(sh)
shdraw.ellipse([scx - int(sr * 1.15), scy + int(sr * 0.82),
                scx + int(sr * 1.15), scy + int(sr * 1.02)], fill=150)
sh = sh.filter(ImageFilter.GaussianBlur(38))
img = Image.composite(Image.new("RGB", (W, H), (52, 48, 44)), img, sh)
draw = ImageDraw.Draw(img)

# sphere body
light = (250, 250, 248)
mid = (140, 138, 134)
dark = (26, 26, 28)
lx, ly = scx - int(sr * 0.38), scy - int(sr * 0.42)   # light source dir
maxd = math.hypot(2 * sr, 2 * sr)
sph = Image.new("RGB", (W, H), (0, 0, 0))
spx = sph.load()
for y in range(scy - sr, scy + sr):
    for x in range(scx - sr, scx + sr):
        dx, dy = x - scx, y - scy
        if dx * dx + dy * dy <= sr * sr:
            d = math.hypot(x - lx, y - ly) / maxd
            d = min(1.0, d)
            if d < 0.55:
                t = d / 0.55
                c = tuple(int(light[i] + (mid[i] - light[i]) * t) for i in range(3))
            else:
                t = (d - 0.55) / 0.45
                t = t * t  # ease into deep shadow
                c = tuple(int(mid[i] + (dark[i] - mid[i]) * t) for i in range(3))
            spx[x, y] = c
mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).ellipse([scx - sr, scy - sr, scx + sr, scy + sr], fill=255)
img.paste(sph, (0, 0), mask)

# --- small companion sphere (mid tone) right side
s2x, s2y, s2r = int(W * 0.68), int(H * 0.70), int(H * 0.115)
sh2 = Image.new("L", (W, H), 0)
ImageDraw.Draw(sh2).ellipse([s2x - int(s2r * 1.2), s2y + int(s2r * 0.85),
                             s2x + int(s2r * 1.2), s2y + int(s2r * 1.05)], fill=140)
sh2 = sh2.filter(ImageFilter.GaussianBlur(22))
img = Image.composite(Image.new("RGB", (W, H), (52, 48, 44)), img, sh2)
draw = ImageDraw.Draw(img)
spx2 = sph.load()
sph2 = Image.new("RGB", (W, H), (0, 0, 0))
spx2 = sph2.load()
l2x, l2y = s2x - int(s2r * 0.4), s2y - int(s2r * 0.45)
maxd2 = math.hypot(2 * s2r, 2 * s2r)
c_light = (246, 244, 238)
c_mid = (168, 150, 126)
c_dark = (48, 40, 34)
for y in range(s2y - s2r, s2y + s2r):
    for x in range(s2x - s2r, s2x + s2r):
        dx, dy = x - s2x, y - s2y
        if dx * dx + dy * dy <= s2r * s2r:
            d = min(1.0, math.hypot(x - l2x, y - l2y) / maxd2)
            if d < 0.5:
                t = d / 0.5
                c = tuple(int(c_light[i] + (c_mid[i] - c_light[i]) * t) for i in range(3))
            else:
                t = (d - 0.5) / 0.5
                c = tuple(int(c_mid[i] + (c_dark[i] - c_mid[i]) * t) for i in range(3))
            spx2[x, y] = c
mask2 = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask2).ellipse([s2x - s2r, s2y - s2r, s2x + s2r, s2y + s2r], fill=255)
img.paste(sph2, (0, 0), mask2)

# --- tall gradient monolith (left) for a hard-edged tonal ramp
mx0, my0 = int(W * 0.12), int(H * 0.30)
mw, mh = int(W * 0.075), int(H * 0.56)
ramp = Image.new("RGB", (mw, mh))
rpx = ramp.load()
for y in range(mh):
    t = y / (mh - 1)
    c = (int(238 - 210 * t), int(234 - 205 * t), int(226 - 198 * t))
    for x in range(mw):
        rpx[x, y] = c
img.paste(ramp, (mx0, my0))

out = img.filter(ImageFilter.GaussianBlur(0.4))
import os
out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "new-sample.jpg")
out.save(out_path, "JPEG", quality=88, optimize=True)
print("saved", out_path, out.size)

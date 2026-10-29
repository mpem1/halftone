#!/usr/bin/env python3
"""Animate clouds in a static photo -> seamless looping GIF (cinemagraph style).

Technique:
  1. Build a "cloud motion" mask = whole scene minus a feathered protected zone
     around the performer (so she stays perfectly still).
  2. Per frame, warp the image with cv2.remap using a displacement field:
        dx(t) = A * sin(2*pi*t),  dy(t) = B * sin(2*pi*t + phase)
     Sinusoidal in time => frame N == frame 0 => perfect loop.
  3. Amplitude ramps with row depth: lower (nearer) clouds drift a bit more.
  4. Pre-zoom the source slightly so border reveal never happens.
"""

import os
import cv2
import numpy as np
from PIL import Image

SRC = "/home/z/my-project/upload/Performer_wearing_metallic_leota\u2026_2a5360c8_2K.jpg"
OUT_DIR = "/home/z/my-project/download"
OUT_GIF = os.path.join(OUT_DIR, "performer_clouds_loop.gif")
PREVIEW = "/home/z/my-project/scripts/preview_frame.png"
os.makedirs(OUT_DIR, exist_ok=True)

# ---------------- load & scale ----------------
img = cv2.imread(SRC, cv2.IMREAD_COLOR)
if img is None:
    raise FileNotFoundError(SRC)
H0, W0 = img.shape[:2]
print(f"source: {W0} x {H0}")

PROC_W = 1100
scale = PROC_W / W0
img = cv2.resize(img, (PROC_W, round(H0 * scale)), interpolation=cv2.INTER_AREA)
h, w = img.shape[:2]

# ---------------- pre-zoom so drift never reveals borders ----------------
ZOOM = 1.06
zw, zh = round(w * ZOOM), round(h * ZOOM)
img = cv2.resize(img, (zw, zh), interpolation=cv2.INTER_CUBIC)
x0, y0 = (zw - w) // 2, (zh - h) // 2
img = img[y0:y0 + h, x0:x0 + w]

# ---------------- cloud motion mask ----------------
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
S = hsv[..., 1].astype(np.float32)
V = hsv[..., 2].astype(np.float32)

# clouds = colorful sky pixels or very bright ones
cloud = np.clip(((S > 40) & (V > 90)) | (V > 200), 0, 1).astype(np.float32)
cloud = cv2.GaussianBlur(cloud, (0, 0), 12)

# protected zone: feathered ellipse around the performer (left-of-center)
protect = np.zeros((h, w), np.float32)
cv2.ellipse(
    protect,
    (int(0.255 * w), int(0.52 * h)),          # center
    (int(0.155 * w), int(0.415 * h)),         # radii
    0, 0, 360, 1.0, -1,
)
protect = cv2.GaussianBlur(protect, (0, 0), 22)

mask = np.clip(cloud * (1.0 - protect), 0, 1)
mask = cv2.GaussianBlur(mask, (0, 0), 8)

# amplitude ramp: nearer (lower) clouds drift slightly more than far sky
ys = np.linspace(0, 1, h, dtype=np.float32)[:, None]
amp_y = 0.75 + 0.5 * ys

field_base = (mask * amp_y).astype(np.float32)

# ---------------- render frames ----------------
N_FRAMES = 36
A = 11.0   # horizontal drift amplitude (px)
B = 3.5    # vertical drift amplitude (px)

base_x = np.tile(np.arange(w, dtype=np.float32), (h, 1))
base_y = np.tile(np.arange(h, dtype=np.float32)[:, None], (1, w))

frames = []
for i in range(N_FRAMES):
    ph = 2 * np.pi * i / N_FRAMES
    dx = A * np.sin(ph)
    dy = B * np.sin(ph + 0.9)
    map_x = (base_x - field_base * dx).astype(np.float32)
    map_y = (base_y - field_base * dy).astype(np.float32)
    frame = cv2.remap(img, map_x, map_y, cv2.INTER_LINEAR,
                      borderMode=cv2.BORDER_REFLECT)
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    frames.append(rgb)

# QA preview frame (quarter-phase = max displacement)
Image.fromarray(frames[9]).save(PREVIEW)

# ---------------- save looping GIF ----------------
GIF_W = 800
gih = round(frames[0].shape[0] * GIF_W / frames[0].shape[1])
pil_frames = [
    Image.fromarray(f).resize((GIF_W, gih), Image.LANCZOS)
        .quantize(colors=256, method=Image.MEDIANCUT,
                  dither=Image.Dither.FLOYDSTEINBERG)
    for f in frames
]
pil_frames[0].save(
    OUT_GIF, save_all=True, append_images=pil_frames[1:],
    loop=0, duration=55, disposal=1, optimize=False,
)
print(f"saved: {OUT_GIF}  ({os.path.getsize(OUT_GIF)/1e6:.2f} MB, "
      f"{GIF_W}x{gih}, {N_FRAMES} frames, ~{N_FRAMES*55/1000:.2f}s loop)")

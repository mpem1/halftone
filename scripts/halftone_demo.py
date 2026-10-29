#!/usr/bin/env python3
"""High-resolution halftone (fine screen): mono newspaper + CMYK offset print.

Vectorized screen renderer: rotates the ink map into screen space via
warpAffine, computes per-cell coverage analytically (area-proportional dots
with 1px AA band), rotates the layer back and multi-composites.
Runs at full source resolution with a 3px cell.
"""

import os
import time
import cv2
import numpy as np

SRC = "/home/z/my-project/upload/Performer_wearing_metallic_leota\u2026_2a5360c8_2K.jpg"
OUT = "/home/z/my-project/download"
os.makedirs(OUT, exist_ok=True)

t0 = time.time()
img = cv2.imread(SRC, cv2.IMREAD_COLOR)
H, W = img.shape[:2]
print(f"full res: {W}x{H}")

CELL = 4      # halftone cell (px) - fine screen at full 2K resolution
R_FAC = 0.50  # dot radius factor


def screen_layer(ink, cell, angle, color01_bgr):
    """One ink layer as float32 (H, W, 3) in 0..1 (white background = 1)."""
    a = np.deg2rad(angle)
    ca, sa = np.cos(a), np.sin(a)
    Rw = int(np.ceil(W * abs(ca) + H * abs(sa))) + 2 * cell
    Rh = int(np.ceil(W * abs(sa) + H * abs(ca))) + 2 * cell
    c_o = np.array([W / 2, H / 2])
    c_s = np.array([Rw / 2, Rh / 2])

    # M1: dst(screen) -> src(orig)   p_o = R(-a) (p_s - c_s) + c_o
    Rm = np.array([[ca, sa], [-sa, ca]])          # R(-a)
    M1 = np.zeros((2, 3), np.float32)
    M1[:, :2] = Rm
    M1[:, 2] = c_o - Rm @ c_s

    # M2: dst(orig) -> src(screen)   p_s = R(a) (p_o - c_o) + c_s
    Rp = np.array([[ca, -sa], [sa, ca]])          # R(a)
    M2 = np.zeros((2, 3), np.float32)
    M2[:, :2] = Rp
    M2[:, 2] = c_s - Rp @ c_o

    # ink in screen space, per-cell average (pad to whole cells)
    ink_s = cv2.warpAffine(ink, M1, (Rw, Rh), flags=cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_REFLECT)
    # validity mask: 1 only where screen space sees the real image,
    # 0 in mirrored/empty canvas regions -> clean paper, no ghost dots
    valid_s = cv2.warpAffine(np.ones((H, W), np.float32), M1, (Rw, Rh),
                             flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=0.0)
    ink_s *= valid_s
    pad_h = (cell - Rh % cell) % cell
    pad_w = (cell - Rw % cell) % cell
    if pad_h or pad_w:
        ink_s = cv2.copyMakeBorder(ink_s, 0, pad_h, 0, pad_w,
                                   cv2.BORDER_CONSTANT, value=0.0)
    nr, nc = ink_s.shape[0] // cell, ink_s.shape[1] // cell
    means = ink_s[:nr * cell, :nc * cell] \
        .reshape(nr, cell, nc, cell).mean(axis=(1, 3))
    r_cell = cell * np.sqrt(np.clip(means, 0, 1)) * R_FAC
    r_cell[means <= 0.015] = -1.0  # no dot

    # per-pixel distance to own cell centre (screen space, axis-aligned)
    # per-pixel distance to own cell centre (pixel centres at +0.5)
    xs = np.arange(Rw, dtype=np.float32) + 0.5
    ys = np.arange(Rh, dtype=np.float32) + 0.5
    cx = (np.arange(nc, dtype=np.float32) + 0.5) * cell
    cy = (np.arange(nr, dtype=np.float32) + 0.5) * cell
    dx2 = (xs - cx[xs.astype(int) // cell]) ** 2
    dy2 = (ys - cy[ys.astype(int) // cell]) ** 2
    dist = np.sqrt(dy2[:, None] + dx2[None, :])

    # radius lookup per pixel: repeat cell radii to pixel grid
    r_map = np.repeat(np.repeat(r_cell, cell, axis=0), cell, axis=1)[:Rh, :Rw]

    alpha = np.clip(0.5 + r_map - dist, 0.0, 1.0)  # 1px AA band
    layer_s = 1.0 - alpha[..., None] * (1.0 - np.array(color01_bgr, np.float32))

    layer_o = cv2.warpAffine(layer_s, M2, (W, H), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT,
                             borderValue=(1.0, 1.0, 1.0))
    return np.clip(layer_o, 0.0, 1.0)


# ---------------- 1) mono newspaper halftone ----------------
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
k_ink = (1.0 - gray) ** 1.18

mono = screen_layer(k_ink, CELL, 45, (0.0, 0.0, 0.0))
paper = np.array([0.945, 0.965, 0.976], np.float32)  # warm white paper
mono *= paper
cv2.imwrite(os.path.join(OUT, "performer_halftone_mono.png"),
            (mono * 255 + 0.5).astype(np.uint8))
# 1:1 QA crop (performer region) to inspect actual dot rendering
crop = mono[560:1160, 300:1500]
cv2.imwrite("/home/z/my-project/scripts/qa_crop_mono.png",
            (crop * 255 + 0.5).astype(np.uint8))
print(f"mono done  ({time.time()-t0:.1f}s)")

# ---------------- 2) CMYK offset-print halftone ----------------
b, g, r = [img[..., i].astype(np.float32) / 255.0 for i in range(3)]
C = (1.0 - r) ** 1.10
M = (1.0 - g) ** 1.10
Y = (1.0 - b) ** 1.10
K = (1.0 - np.max(img, axis=2).astype(np.float32) / 255.0) ** 1.25 * 0.55

cmyk = np.ones((H, W, 3), np.float32)
for ink, ang, col in [
    (C, 15, (1.0, 1.0, 0.0)),   # cyan    BGR
    (M, 75, (1.0, 0.0, 1.0)),   # magenta BGR
    (Y, 0,  (0.0, 1.0, 1.0)),   # yellow  BGR
    (K, 45, (0.0, 0.0, 0.0)),   # black   BGR
]:
    cmyk *= screen_layer(ink, CELL, ang, col)
    print(f"  layer {ang:3d}deg done ({time.time()-t0:.1f}s)")

cv2.imwrite(os.path.join(OUT, "performer_halftone_cmyk.png"),
            (np.clip(cmyk, 0, 1) * 255 + 0.5).astype(np.uint8))
crop = cmyk[560:1160, 300:1500]
cv2.imwrite("/home/z/my-project/scripts/qa_crop_cmyk.png",
            (np.clip(crop, 0, 1) * 255 + 0.5).astype(np.uint8))
print(f"cmyk done ({time.time()-t0:.1f}s)")

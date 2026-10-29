#!/usr/bin/env python3
"""Halftone demos for the performer image: mono newspaper + CMYK offset print."""

import os
import cv2
import numpy as np

SRC = "/home/z/my-project/upload/Performer_wearing_metallic_leota\u2026_2a5360c8_2K.jpg"
OUT = "/home/z/my-project/download"
os.makedirs(OUT, exist_ok=True)

img = cv2.imread(SRC, cv2.IMREAD_COLOR)
H0, W0 = img.shape[:2]
W = 1100
img = cv2.resize(img, (W, round(H0 * W / W0)), interpolation=cv2.INTER_AREA)
h, w = img.shape[:2]
print(f"working at {w}x{h}")

CELL = 6          # halftone cell size (px)
SS = 2            # supersample factor for smooth dot edges
R_FAC = 0.50      # dot radius factor (lower = lighter print)


def build_screen(h, w, ink, cell, angle, color_f32):
    """One ink layer: white canvas, area-proportional solid-color dots.

    ink      : float32 [0..1] ink coverage map (h, w)
    angle    : screen angle in degrees
    color_f32: ink color in BGR, 0..1
    Returns float32 layer (h, w, 3), values 0..1 (white = 1).
    """
    ss_h, ss_w = h * SS, w * SS
    layer = np.ones((ss_h, ss_w, 3), np.float32)
    a = np.deg2rad(angle)
    ca, sa = np.cos(a), np.sin(a)
    R = int(np.hypot(ss_h, ss_w)) // 2 + cell
    ny, nx = R // cell, R // cell
    c_ss = cell * SS
    color255 = tuple(float(v) for v in (np.clip(color_f32, 0, 1) * 255))
    for iy in range(-ny, ny + 1):
        for ix in range(-nx, nx + 1):
            xr, yr = (ix + 0.5) * c_ss, (iy + 0.5) * c_ss
            x = ca * xr - sa * yr + ss_w / 2
            y = sa * xr + ca * yr + ss_h / 2
            xi, yi = int(x), int(y)
            if xi < 2 or yi < 2 or xi >= ss_w - 2 or yi >= ss_h - 2:
                continue
            # sample ink coverage around the cell center (in full-res coords)
            fx, fy = xi // SS, yi // SS
            x0, x1 = max(0, fx - cell // 2), min(w, fx - cell // 2 + cell)
            y0, y1 = max(0, fy - cell // 2), min(h, fy - cell // 2 + cell)
            amt = float(ink[y0:y1, x0:x1].mean())
            if amt <= 0.015:
                continue
            r = c_ss * np.sqrt(amt) * R_FAC
            if r < 0.8:
                continue
            cv2.circle(layer, (xi, yi), int(round(r)), color255, -1,
                       lineType=cv2.LINE_AA)
    out = cv2.resize(layer, (w, h), interpolation=cv2.INTER_AREA)
    return np.clip(out, 0, 1)


# ---------------- 1) mono newspaper halftone ----------------
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
k_ink = (1.0 - gray) ** 1.18  # black ink coverage, gamma-opened shadows

mono_layer = build_screen(h, w, k_ink, CELL, 45, (0.0, 0.0, 0.0))
# warm paper instead of pure white
paper = np.array([0.945, 0.965, 0.976], np.float32)  # BGR warm white
mono = mono_layer * paper  # multiply: dots are near-black on warm paper
mono_out = (mono * 255 + 0.5).astype(np.uint8)
cv2.imwrite(os.path.join(OUT, "performer_halftone_mono.png"), mono_out)
print("saved mono")

# ---------------- 2) CMYK offset-print halftone ----------------
b, g, r = [img[..., i].astype(np.float32) / 255.0 for i in range(3)]
C = (1.0 - r) ** 1.10           # cyan absorbs red
M = (1.0 - g) ** 1.10           # magenta absorbs green
Y = (1.0 - b) ** 1.10           # yellow absorbs blue
K = (1.0 - np.max(img, axis=2).astype(np.float32) / 255.0) ** 1.25 * 0.55

layers = [
    (C, 15,  (1.0, 1.0, 0.0)),   # cyan    BGR
    (M, 75,  (1.0, 0.0, 1.0)),   # magenta BGR
    (Y, 0,   (0.0, 1.0, 1.0)),   # yellow  BGR
    (K, 45,  (0.0, 0.0, 0.0)),   # black   BGR
]
cmyk = np.ones((h, w, 3), np.float32)
for ink, ang, col in layers:
    cmyk *= build_screen(h, w, ink, CELL, ang, col)
cmyk_out = (np.clip(cmyk, 0, 1) * 255 + 0.5).astype(np.uint8)
cv2.imwrite(os.path.join(OUT, "performer_halftone_cmyk.png"), cmyk_out)
print("saved cmyk")
print("done")

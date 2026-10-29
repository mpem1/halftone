#!/usr/bin/env python3
"""Dump every stage of screen_layer for the mono screen to localize the bug."""
import cv2
import numpy as np

SRC = "/home/z/my-project/upload/Performer_wearing_metallic_leota\u2026_2a5360c8_2K.jpg"
DBG = "/home/z/my-project/scripts"
img = cv2.imread(SRC, cv2.IMREAD_COLOR)
H, W = img.shape[:2]

cell, angle, R_FAC = 3, 45, 0.50
a = np.deg2rad(angle)
ca, sa = np.cos(a), np.sin(a)
Rw = int(np.ceil(W * abs(ca) + H * abs(sa))) + 2 * cell
Rh = int(np.ceil(W * abs(sa) + H * abs(ca))) + 2 * cell
c_o = np.array([W / 2, H / 2])
c_s = np.array([Rw / 2, Rh / 2])

Rm = np.array([[ca, sa], [-sa, ca]])
Rp = np.array([[ca, -sa], [sa, ca]])
M1 = np.zeros((2, 3), np.float32); M1[:, :2] = Rm; M1[:, 2] = c_o - Rm @ c_s
M2 = np.zeros((2, 3), np.float32); M2[:, :2] = Rp; M2[:, 2] = c_s - Rp @ c_o

gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
ink = (1.0 - gray) ** 1.18
print("ink stats:", ink.min(), ink.mean(), ink.max())

ink_s = cv2.warpAffine(ink, M1, (Rw, Rh), flags=cv2.INTER_LINEAR,
                       borderMode=cv2.BORDER_REFLECT)
cv2.imwrite(f"{DBG}/dbg_ink_s.png", (ink_s * 255).astype(np.uint8))
print("ink_s stats:", ink_s.min(), ink_s.mean(), ink_s.max())

pad_h = (cell - Rh % cell) % cell
pad_w = (cell - Rw % cell) % cell
if pad_h or pad_w:
    ink_s = cv2.copyMakeBorder(ink_s, 0, pad_h, 0, pad_w,
                               cv2.BORDER_CONSTANT, value=0.0)
nr, nc = ink_s.shape[0] // cell, ink_s.shape[1] // cell
means = ink_s[:nr * cell, :nc * cell].reshape(nr, cell, nc, cell).mean(axis=(1, 3))
print("means stats:", means.min(), means.mean(), means.max())
r_cell = cell * np.sqrt(np.clip(means, 0, 1)) * R_FAC
r_cell[means <= 0.015] = -1.0
print("r_cell stats:", r_cell.min(), r_cell.mean(), r_cell.max())

xs = np.arange(Rw, dtype=np.float32)
ys = np.arange(Rh, dtype=np.float32)
cx = (np.arange(nc, dtype=np.float32) + 0.5) * cell
cy = (np.arange(nr, dtype=np.float32) + 0.5) * cell
dx2 = (xs - cx[xs.astype(int) // cell]) ** 2
dy2 = (ys - cy[ys.astype(int) // cell]) ** 2
dist = np.sqrt(dy2[:, None] + dx2[None, :])
print("dist stats:", dist.min(), dist.mean(), dist.max())

r_map = np.repeat(np.repeat(r_cell, cell, axis=0), cell, axis=1)
print("r_map shape:", r_map.shape, " vs dist:", dist.shape)
r_map = r_map[:Rh, :Rw]

alpha = np.clip(0.5 + r_map - dist, 0.0, 1.0)
cv2.imwrite(f"{DBG}/dbg_alpha.png", (alpha * 255).astype(np.uint8))
print("alpha stats:", alpha.min(), alpha.mean(), alpha.max())

layer_s = (1.0 - alpha[..., None]).repeat(3, axis=2) if alpha.ndim == 2 else 1.0 - alpha[..., None]
layer_s = np.dstack([alpha, alpha, alpha])  # black dots: rgb = 1-alpha
layer_s = 1.0 - layer_s * 0  # noop, keep clarity
layer_o = cv2.warpAffine(layer_s, M2, (W, H), flags=cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_CONSTANT,
                         borderValue=(1.0, 1.0, 1.0))
cv2.imwrite(f"{DBG}/dbg_layer_o.png", (np.clip(layer_o, 0, 1) * 255).astype(np.uint8))
print("layer_o stats:", layer_o.min(), layer_o.mean(), layer_o.max())

#!/usr/bin/env python3
"""Diagnose the screen_layer warp math: round-trip a point and dump stats."""
import numpy as np
import cv2

W, H = 2752, 1536
cell, angle = 3, 45
a = np.deg2rad(angle)
ca, sa = np.cos(a), np.sin(a)
Rw = int(np.ceil(W * abs(ca) + H * abs(sa))) + 2 * cell
Rh = int(np.ceil(W * abs(sa) + H * abs(ca))) + 2 * cell
c_o = np.array([W / 2, H / 2])
c_s = np.array([Rw / 2, Rh / 2])
print(f"Rw,Rh = {Rw},{Rh}   c_o={c_o}  c_s={c_s}")

Rm = np.array([[ca, sa], [-sa, ca]])   # R(-a)
Rp = np.array([[ca, -sa], [sa, ca]])   # R(+a)

M1 = np.zeros((2, 3), np.float32)
M1[:, :2] = Rm
M1[:, 2] = c_o - Rm @ c_s
M2 = np.zeros((2, 3), np.float32)
M2[:, :2] = Rp
M2[:, 2] = c_s - Rp @ c_o
print("M1=\n", M1, "\nM2=\n", M2)

# round trip: orig -> screen -> orig
p = np.array([100.0, 100.0])
q = M2[:, :2] @ p + M2[:, 2]
p2 = M1[:, :2] @ q + M1[:, 2]
print(f"p={p} -> screen q={q} (canvas 0..{Rw},{Rh}) -> back p2={p2}")

# empirical cv2 check: warp a marker image orig->screen with M1,
# find where a white pixel at p=(100,100) lands
src = np.zeros((H, W), np.float32)
src[100, 100] = 1.0
scr = cv2.warpAffine(src, M1, (Rw, Rh))
ys, xs = np.nonzero(scr > 0.5)
print(f"marker orig(100,100) appears in screen at ~({xs.mean():.0f},{ys.mean():.0f})"
      f"  | M2*row_vec check: q={q}")

# and back
back = cv2.warpAffine(scr, M2, (W, H))
ys2, xs2 = np.nonzero(back > 0.5)
print(f"warped back to orig at ~({xs2.mean():.0f},{ys2.mean():.0f}) (expect 100,100)")

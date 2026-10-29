"""Generate a test image: horizontal white->black ramp + uniform 25/50/75% patches."""
from PIL import Image
import numpy as np

w, h = 800, 400
im = np.zeros((h, w, 3), dtype=np.uint8)
# top half: horizontal ramp white (left) -> black (right)
ramp = np.linspace(255, 0, w).astype(np.uint8)
im[: h // 2, :, 0] = ramp
im[: h // 2, :, 1] = ramp
im[: h // 2, :, 2] = ramp
# bottom half: three uniform patches 25% 50% 75% ink (i.e. gray 191/128/64)
vals = [191, 128, 64]
for k, v in enumerate(vals):
    x0, x1 = k * w // 3, (k + 1) * w // 3
    im[h // 2 :, x0:x1, :] = v
Image.fromarray(im).save("/home/z/my-project/scripts/ramp_test.png")
print("saved ramp_test.png")

#!/usr/bin/env python3
"""Apply the user's per-section card colors in src/app/page.tsx."""
import sys

PATH = '/home/z/my-project/src/app/page.tsx'
COLORS = {
    'Output mode': '2D222F',
    'Mark fill': '2D222F',
    'Print ruling (ppi \\u00d7 lpi)': '2D222F',
    'Screen': '4B2138',
    'Image adjustments': '6D3C52',
    'Background': '765D67',
    'Edge fade': '2D222F',
    'Target area': '2D222F',
}

s = open(PATH).read()
for title, hexcode in COLORS.items():
    t = title.encode().decode('unicode_escape')
    old = f'<Section title="{t}">'
    new = f'<Section title="{t}"\n                bg="#{hexcode}">'
    if s.count(old) != 1:
        sys.exit(f'expected exactly 1 occurrence of {old!r}, found {s.count(old)}')
    s = s.replace(old, new, 1)
open(PATH, 'w').write(s)
print('applied', len(COLORS), 'section colors')

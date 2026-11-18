#!/usr/bin/env python3
"""Reorder the sidebar sections in src/app/page.tsx.

Blocks are [start, end] 1-indexed inclusive, each covering the section's
preceding comment line through its closing tag plus the blank separator.
Order (top to bottom): Output mode, Mark fill, Print ruling, Screen,
Image adjustments, Background, Edge fade, Target area.
"""
import sys

PATH = '/home/z/my-project/src/app/page.tsx'
lines = open(PATH).readlines()

BLOCKS = {
    'A: output mode': (856, 955),
    'B: screen': (956, 1103),
    'C: print ruling': (1104, 1146),
    'D: mark fill': (1147, 1197),
    'E: background': (1198, 1373),
    'F: edge fade': (1374, 1477),
    'G: adjustments': (1478, 1601),
    'H: target area': (1602, 1661),
}
NEW_ORDER = ['A', 'D', 'C', 'B', 'G', 'E', 'F', 'H']

# sanity: blocks must tile the range 856..1661 with no gaps or overlaps
tiles = sorted(BLOCKS.values())
expect_start = 856
for (s, e) in tiles:
    if s != expect_start:
        sys.exit(f'gap/overlap: expected start {expect_start}, got {s}')
    expect_start = e + 1
if expect_start - 1 != 1661:
    sys.exit(f'last block ends at {expect_start - 1}, expected 1661')

# sanity: one balanced <Section> per block (mark fill adds a wrapper line)
extracted = {}
for key, (s, e) in BLOCKS.items():
    chunk = lines[s - 1:e]
    opens = sum(c.count('<Section ') for c in chunk)
    closes = sum(c.count('</Section>') for c in chunk)
    if opens != 1 or closes != 1:
        sys.exit(f'block {key}: {opens} <Section> / {closes} </Section>')
    extracted[key[0]] = chunk

head = lines[:855]        # everything before the first comment (incl. container div)
tail = lines[1661:]       # from </div> closing the scroll container onward

out = head + [ln for k in NEW_ORDER for ln in extracted[k]] + tail
open(PATH, 'w').writelines(out)

whole = ''.join(out)
print('sections:', whole.count('<Section '), 'open,', whole.count('</Section>'), 'close')
print('order now:')
for i, name in enumerate(['Output mode', 'Mark fill', 'Print ruling', 'Screen',
                          'Image adjustments', 'Background', 'Edge fade', 'Target area'], 1):
    print(f'  {i}. {name}')

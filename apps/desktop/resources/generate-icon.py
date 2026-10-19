# Generates apps/desktop/resources/icon.png from a hard-coded version of the
# Curator brand mark. Pure stdlib (zlib + struct) so it runs anywhere Python
# is installed without needing Pillow / Cairo / Inkscape.
#
# Run: `python apps/desktop/resources/generate-icon.py`
# Output: icon.png (256x256, RGB) in the same folder.

import zlib, struct, os, sys

W = H = 256
BG = (0x0a, 0x0a, 0x0b)
FG = (0xef, 0xef, 0xf2)

pixels = [[BG] * W for _ in range(H)]

def rect(x0, y0, x1, y1, color):
    for y in range(max(0, y0), min(H, y1)):
        row = pixels[y]
        for x in range(max(0, x0), min(W, x1)):
            row[x] = color

# Three horizontal bars (mirroring the SVG rects at y=4,10.9,17.8 in 24u space)
rect(109, 69,  219, 85,  FG)
rect(109, 120, 219, 136, FG)
rect(109, 171, 219, 187, FG)

# Play-triangle pointer (▶). Apex at (52,128); base from (15,110) to (15,146).
# Scanline fill — at each y, the right edge moves linearly inward by |y-128|.
for y in range(110, 147):
    t = abs(y - 128) / 18.0
    x_right = int(52 - (52 - 15) * t)
    rect(15, y, x_right, y + 1, FG)

# PNG encode (8-bit RGB, single IDAT chunk).
raw = bytearray()
for row in pixels:
    raw.append(0)  # filter type 0 (None)
    for r, g, b in row:
        raw.extend((r, g, b))

def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

sig = b'\x89PNG\r\n\x1a\n'
ihdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)
idat = zlib.compress(bytes(raw), 9)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon.png')
with open(out, 'wb') as f:
    f.write(sig)
    f.write(chunk(b'IHDR', ihdr))
    f.write(chunk(b'IDAT', idat))
    f.write(chunk(b'IEND', b''))

print(f'wrote {out} ({os.path.getsize(out)} bytes)', file=sys.stderr)

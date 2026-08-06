#!/usr/bin/env python3
"""Generate Thumbview brand icons.

- media/icon-store.svg + media/icon.png (128x128, extension store icon)
- media/icon.svg (24x24, activity bar / sidebar icon)

Design: a symmetric spanning-grid mark — one tall tile in the left
column, two equally sized tiles in the right column — drawn in
Thumbview's own neutral UI palette (tile text #e1e1e6 on editor
background #18181c/#1e1e24).
"""
import cairosvg

# Thumbview webview neutrals (see media/overview.js)
INK = "#e1e1e6"        # primary text / active
BG_TOP = "#1e1e24"     # tile background
BG_BOTTOM = "#18181c"  # editor background

# 24-unit grid geometry: margin 2, gap 2.5, two 8.75-wide columns,
# left tile full height 20, right tiles (20 - 2.5) / 2 = 8.75 each
M, G, H = 2.0, 2.5, 20.0
CW = (H - G) / 2.0  # 8.75
RH = (H - G) / 2.0  # 8.75
R = 1.8


def grid_mark(x, y, w, h):
    """The symmetric spanning grid, scaled into the given box."""
    s = w / 24.0
    u = lambda v: v * s
    t = []

    def rect(cx, cy, ch, op):
        t.append(
            f'<rect x="{cx:.2f}" y="{cy:.2f}" width="{u(CW):.2f}" height="{u(ch):.2f}" '
            f'rx="{u(R):.2f}" fill="{INK}" fill-opacity="{op}"/>'
        )

    lx, rx = x + u(M), x + u(M + CW + G)
    ty = y + u(M)
    rect(lx, ty, H, 1.0)                    # left: one tall tile
    rect(rx, ty, RH, 0.8)                   # right: two equal tiles
    rect(rx, ty + u(RH + G), RH, 0.45)
    return "".join(t)


def store_svg():
    mark = grid_mark(26, 26, 76, 76)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{BG_TOP}"/>
      <stop offset="1" stop-color="{BG_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="26" fill="url(#bg)"/>
  {mark}
</svg>
"""


def sidebar_svg():
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <g fill="{INK}">
    <rect x="2" y="2" width="8.75" height="20" rx="1.8"/>
    <rect x="13.25" y="2" width="8.75" height="8.75" rx="1.8" fill-opacity="0.8"/>
    <rect x="13.25" y="13.25" width="8.75" height="8.75" rx="1.8" fill-opacity="0.45"/>
  </g>
</svg>
"""


with open("media/icon-store.svg", "w") as f:
    f.write(store_svg())
with open("media/icon.svg", "w") as f:
    f.write(sidebar_svg())

cairosvg.svg2png(bytestring=store_svg().encode(), write_to="media/icon.png",
                 output_width=128, output_height=128)
print("wrote media/icon-store.svg, media/icon.png, media/icon.svg")

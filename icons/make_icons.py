# アイコン生成スクリプト: python3 make_icons.py で全サイズのPNGを書き出します。
# デザインを変えたいときは下の SVG テンプレートを編集してください。
import cairosvg, pathlib

here = pathlib.Path(__file__).parent

def svg(rounded: bool, scale: float = 1.0) -> str:
    # scale<1 でマークを中央に縮小(Androidの丸型マスク用の余白)
    rx = 112 if rounded else 0
    t = 256 * (1 - scale)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ee8b6c"/>
      <stop offset="1" stop-color="#b94a31"/>
    </linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#6b2412" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="{rx}" fill="url(#bg)"/>
  <g transform="translate({t} {t}) scale({scale})">
  <path filter="url(#sh)" fill="#ffffff"
    d="M256 400 C120 300 100 220 100 180 C100 130 140 100 185 100 C220 100 245 120 256 145 C267 120 292 100 327 100 C372 100 412 130 412 180 C412 220 392 300 256 400 Z"/>
  <path fill="#ffe3a3" d="M388 78 C391 108 400 117 430 120 C400 123 391 132 388 162 C385 132 376 123 346 120 C376 117 385 108 388 78 Z"/>
  </g>
</svg>'''

def render(name, rounded, size, scale=1.0):
    cairosvg.svg2png(bytestring=svg(rounded, scale).encode(), write_to=str(here / name),
                     output_width=size, output_height=size)

render("icon-192.png", True, 192)
render("icon-512.png", True, 512)
render("icon-maskable-512.png", False, 512, 0.78)
render("apple-touch-icon.png", False, 180)
(here / "favicon.svg").write_text(svg(True), encoding="utf-8")
print("done")

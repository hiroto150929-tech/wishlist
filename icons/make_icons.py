# アイコン生成スクリプト: python3 make_icons.py で全サイズのPNGを書き出します。
# 黒背景に白字で「list」。文字・色・太さは下の定数で変更できます。
# 要: pip install cairosvg / フォント Inter(なければ Helvetica / Arial で代用)
import cairosvg, pathlib

here = pathlib.Path(__file__).parent
TEXT, BG, FG = "list", "#111111", "#ffffff"
FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"

def svg(scale: float = 1.0) -> str:
    # scale<1 で文字を小さくする(Androidの丸型マスク用の余白)
    size = 150 * scale
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="{BG}"/>
  <text x="256" y="256" dy="0.35em" text-anchor="middle" fill="{FG}"
        font-family="{FONT}" font-weight="500" font-size="{size:.0f}" letter-spacing="{-2*scale:.1f}">{TEXT}</text>
</svg>'''

def render(name, size, scale=1.0):
    cairosvg.svg2png(bytestring=svg(scale).encode(), write_to=str(here / name), output_width=size, output_height=size)

render("icon-192.png", 192)
render("icon-512.png", 512)
render("icon-maskable-512.png", 512, 0.8)
render("apple-touch-icon.png", 180)
(here / "favicon.svg").write_text(svg(), encoding="utf-8")
print("done")

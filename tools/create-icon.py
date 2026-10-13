"""生成客户端自有的几何图标；不使用第三方游戏素材。"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
out = root / "desktop" / "icons"
out.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (256, 256), (15, 24, 34, 255))
draw = ImageDraw.Draw(image)
draw.polygon([(128, 28), (226, 210), (188, 210), (128, 93), (68, 210), (30, 210)], fill=(98, 197, 228, 255))
draw.rectangle((90, 161, 166, 182), fill=(245, 172, 68, 255))
image.save(out / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

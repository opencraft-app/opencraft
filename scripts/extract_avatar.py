import re
import base64
import os
import sys
from PIL import Image, ImageDraw
from io import BytesIO

src_name = sys.argv[1]
dst_name = sys.argv[2]
SRC_DIR = "/Users/erichu/work/code/mono/frontend/public/assets/CodeBuddyAssets/1_702"
DST_DIR = "/Users/erichu/work/code/mono/frontend/public/assets/landing/hero/avatars"
SIZE = 88

os.makedirs(DST_DIR, exist_ok=True)

with open(os.path.join(SRC_DIR, src_name), "r", encoding="utf-8") as f:
    svg = f.read()

m = re.search(r"data:image/png;base64,([A-Za-z0-9+/=]+)", svg)
if not m:
    print(f"{src_name}: 未找到 base64 PNG")
    sys.exit(1)

png = base64.b64decode(m.group(1))
img = Image.open(BytesIO(png)).convert("RGBA")
print(f"{src_name}: 原图 {img.width}x{img.height}, {len(png)/1024/1024:.2f}MB")

# 中心正方形裁剪
s = min(img.width, img.height)
left = (img.width - s) // 2
top = (img.height - s) // 2
img = img.crop((left, top, left + s, top + s))
img = img.resize((SIZE, SIZE), Image.Resampling.LANCZOS)

# 圆形遮罩
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).ellipse((0, 0, SIZE, SIZE), fill=255)
out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
out.paste(img, (0, 0), mask)

dst = os.path.join(DST_DIR, dst_name)
out.save(dst, format="WEBP", quality=85, method=6)
print(f"  -> {dst_name}  {os.path.getsize(dst)/1024:.1f}KB")

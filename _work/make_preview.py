# -*- coding: utf-8 -*-
"""
从 assets/ 的 PNG 序列生成 README 预览图。

产物：

    docs/images/preview.gif   动图（待机动作循环）
    docs/images/preview.png   静态图（透明背景，可另作他用）

## 几个处理决定

1. **裁掉四周透明边距**。素材画布是 906×704，而角色实际只占中间一块
   （实测待机包围盒 x=142..591、y=141..665），直接缩放会让角色很小、
   四周全是空的。这里按**整段动画的并集包围盒**裁剪，保证动作过程中
   不会被裁到。

2. **放到深色底板**。GIF 的透明只有 1 位，直接透出背景会让边缘毛糙；
   而 GitHub 有浅色/深色两套主题，纯透明图在某一侧往往不好看。
   底板用 rgba(30,32,38) —— 与程序内气泡同色，观感统一。

3. **圆角**。底板带圆角，圆角外保持透明。

## 用法

    python _work/make_preview.py
"""

import glob
import os

from PIL import Image, ImageDraw

WORK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(WORK, "..")
SRC = os.path.join(ROOT, "assets", "idle")
OUT_DIR = os.path.join(ROOT, "docs", "images")

# 每隔几帧取一帧（源 30fps，取 3 约等于 10fps，动图够顺且体积可控）
STEP = 3
TARGET_W = 360          # 底板宽度
MARGIN = 12             # 裁剪时角色四周留白
PANEL = (30, 32, 38)    # 底板颜色，同程序气泡 rgba(30,32,38)
RADIUS = 14             # 圆角半径


def union_bbox(frames):
    """整段动画的并集包围盒（含 alpha）。"""
    bbox = None
    for im in frames:
        b = im.getbbox()
        if b is None:
            continue
        bbox = b if bbox is None else (
            min(bbox[0], b[0]), min(bbox[1], b[1]),
            max(bbox[2], b[2]), max(bbox[3], b[3]),
        )
    return bbox


def rounded_panel(size, radius, color):
    """圆角底板，四角透明。"""
    w, h = size
    # 4 倍超采样后缩小，边缘更平滑
    ss = 4
    mask = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, w * ss - 1, h * ss - 1), radius=radius * ss, fill=255
    )
    mask = mask.resize((w, h), Image.LANCZOS)

    panel = Image.new("RGBA", (w, h), color + (255,))
    panel.putalpha(mask)
    return panel


def main() -> int:
    files = sorted(glob.glob(os.path.join(SRC, "*.png")))
    if not files:
        print(f"找不到帧: {SRC}")
        return 1

    picked = files[::STEP]
    print(f"源帧 {len(files)} 张，取 {len(picked)} 张（每 {STEP} 帧一张）")

    frames = [Image.open(f).convert("RGBA") for f in picked]

    bbox = union_bbox(frames)
    print(f"并集包围盒: {bbox}  (画布 {frames[0].size})")

    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - MARGIN); y0 = max(0, y0 - MARGIN)
    x1 = min(frames[0].width, x1 + MARGIN); y1 = min(frames[0].height, y1 + MARGIN)
    cw, ch = x1 - x0, y1 - y0
    print(f"裁剪后: {cw}x{ch}")

    # 统一按目标宽度缩放
    scale = TARGET_W / cw
    tw, th = TARGET_W, max(1, round(ch * scale))

    panel = rounded_panel((tw, th), RADIUS, PANEL)

    composited = []
    for im in frames:
        crop = im.crop((x0, y0, x1, y1)).resize((tw, th), Image.LANCZOS)
        base = panel.copy()
        base.alpha_composite(crop)
        composited.append(base.convert("RGBA"))

    os.makedirs(OUT_DIR, exist_ok=True)

    # ---- 动图 ----
    gif_path = os.path.join(OUT_DIR, "preview.gif")
    # GIF 调色板：先量化到 255 色，留 1 个索引给透明
    pal_frames = []
    for im in composited:
        alpha = im.getchannel("A")
        p = im.convert("RGB").quantize(colors=255, method=Image.MEDIANCUT)
        # 全透明像素设为透明索引
        mask = alpha.point(lambda a: 255 if a < 128 else 0)
        p.paste(255, mask)
        pal_frames.append(p)

    pal_frames[0].save(
        gif_path,
        save_all=True,
        append_images=pal_frames[1:],
        duration=int(1000 * STEP / 30),   # 源 30fps
        loop=0,
        transparency=255,
        disposal=2,
        optimize=True,
    )
    print(f"\n动图: {gif_path}  ({os.path.getsize(gif_path)/1024:.0f} KB)  {tw}x{th}")

    # ---- 静态图（取中间帧，透明背景，不叠底板）----
    mid = frames[len(frames) // 2]
    static = mid.crop((x0, y0, x1, y1)).resize((tw, th), Image.LANCZOS)
    png_path = os.path.join(OUT_DIR, "preview.png")
    static.save(png_path)
    print(f"静态: {png_path}  ({os.path.getsize(png_path)/1024:.0f} KB)  {tw}x{th}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

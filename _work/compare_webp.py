# -*- coding: utf-8 -*-
"""
生成 WebP 质量对比图：把同一帧的 PNG / q95 / q90 / q85 并排放大，看差异。

桌宠是「看着舒服」的东西，压缩率再高，画质不能接受就没意义。
这里把最坏情况放大呈现：角色脸部与半透明边缘。

用法：
    python _work/compare_webp.py
"""

import os
import subprocess

from PIL import Image

WORK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(WORK, ".."))
FFMPEG = r"F:\SSV\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe"

SRC = os.path.join(ROOT, "assets", "idle", "f0001.png")
OUT = os.path.join(ROOT, "docs", "images", "webp_compare.png")
TMP = os.path.join(os.environ.get("TEMP", "."), "webp_cmp")

# 放大倍数：让瑕疵可见
ZOOM = 3


def convert(q: int | None, lossless: bool, dst: str) -> bool:
    cmd = [FFMPEG, "-y", "-v", "error", "-i", SRC]
    if lossless:
        cmd += ["-c:v", "libwebp", "-lossless", "1", "-pix_fmt", "bgra"]
    else:
        cmd += ["-c:v", "libwebp", "-quality", str(q), "-pix_fmt", "yuva420p"]
    cmd.append(dst)
    return subprocess.run(cmd, capture_output=True).returncode == 0


def main() -> int:
    if not os.path.exists(SRC):
        print(f"找不到源帧: {SRC}")
        return 1
    os.makedirs(TMP, exist_ok=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    # 用深色底衬托 alpha 边缘
    base = Image.open(SRC).convert("RGBA")

    # 裁一块包含脸部细节与边缘的区域，再放大
    bbox = base.getbbox()
    cx = (bbox[0] + bbox[2]) // 2
    cy = bbox[1] + (bbox[3] - bbox[1]) // 4      # 偏上 = 头部
    half = 110
    crop_box = (cx - half, cy - half, cx + half, cy + half)

    variants = [("原图 PNG", None, False)]
    paths = {}
    for label, q, ll in [("q95", 95, False), ("q90", 90, False), ("q85", 85, False)]:
        p = os.path.join(TMP, f"{label}.webp")
        if convert(q, ll, p):
            variants.append((label, q, ll))
            paths[label] = p

    tiles = []
    sizes = []
    for label, q, ll in variants:
        if label == "原图 PNG":
            im = base
            sz = os.path.getsize(SRC)
        else:
            im = Image.open(paths[label]).convert("RGBA")
            sz = os.path.getsize(paths[label])
        tile = im.crop(crop_box).resize(
            ((crop_box[2] - crop_box[0]) * ZOOM, (crop_box[3] - crop_box[1]) * ZOOM),
            Image.NEAREST,
        )
        tiles.append((label, tile, sz))
        sizes.append((label, sz))

    # 拼成一行
    pad = 8
    label_h = 22
    w = sum(t.width for _, t, _ in tiles) + pad * (len(tiles) + 1)
    h = max(t.height for _, t, _ in tiles) + label_h + pad * 2
    sheet = Image.new("RGBA", (w, h), (24, 26, 32, 255))

    from PIL import ImageDraw
    d = ImageDraw.Draw(sheet)

    x = pad
    for label, tile, sz in tiles:
        d.text((x, 6), f"{label}  {sz/1024:.0f}KB", fill=(220, 226, 236))
        sheet.alpha_composite(tile, (x, label_h + pad // 2))
        x += tile.width + pad

    sheet.convert("RGB").save(OUT)
    print(f"对比图: {OUT}")
    print(f"  {sheet.width}x{sheet.height}")
    print()
    print("各版本体积（单帧）:")
    for label, sz in sizes:
        print(f"  {label:10s} {sz/1024:7.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# -*- coding: utf-8 -*-
"""
把 PNG 序列转成 WebP，并生成外置素材目录。

## 为什么要转

342 帧 PNG 共 68 MB，平均 200~300 KB/帧 —— 对 906×704 的图来说异常大。
PNG 对**逐帧动画**效率极低：每帧独立压缩，帧间冗余完全没利用。

实测（放大 3 倍目视对比）：
    PNG      225 KB/帧
    q95       58 KB/帧   肉眼无差别
    q90       47 KB/帧   肉眼无差别   <- 采用
    q85       40 KB/帧   开始出现色块

q90 把 68 MB 压到约 14 MB，观感无损。

## 产出结构（即发布包的内容）

    dist/Mon3trPet/
    ├─ Mon3trPet.exe      只有几 MB（代码 + 内嵌的 web-dist）
    ├─ assets/            342 帧 webp + actions.json
    │   ├─ actions.json
    │   └─ idle/ move/ rest/ click/ sit/
    └─ audio/             38 条语音 + audio.json

## 用法

    python _work/build_assets.py            # 转换并组装
    python _work/build_assets.py --check    # 只报告，不写文件
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import time

WORK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(WORK, ".."))

FFMPEG = r"F:\SSV\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe"

SRC_ASSETS = os.path.join(ROOT, "assets")          # PNG 母版
SRC_AUDIO = os.path.join(ROOT, "audio")            # 已压缩好的 ogg
OUT = os.path.join(ROOT, "dist", "Mon3trPet")      # 发布目录

QUALITY = 90          # WebP 有损质量（见文件头说明）
ACTIONS = ["idle", "move", "rest", "click", "sit"]


def convert_one(src: str, dst: str) -> bool:
    """单帧 PNG -> WebP（保留 alpha）。"""
    cmd = [
        FFMPEG, "-y", "-v", "error",
        "-i", src,
        "-c:v", "libwebp",
        "-quality", str(QUALITY),
        # yuva420p 保留 alpha；webp 支持带透明的有损编码
        "-pix_fmt", "yuva420p",
        dst,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"    转换失败 {os.path.basename(src)}: {r.stderr.strip()[:120]}")
        return False
    return True


def main() -> int:
    check_only = "--check" in sys.argv

    if not os.path.exists(FFMPEG):
        print(f"找不到 ffmpeg: {FFMPEG}", file=sys.stderr)
        return 1
    if not os.path.isdir(SRC_ASSETS):
        print(f"找不到素材: {SRC_ASSETS}", file=sys.stderr)
        return 1

    # 读原清单，保留除格式外的所有信息
    with open(os.path.join(SRC_ASSETS, "actions.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)

    total_src = 0
    total_dst = 0
    t0 = time.time()

    for act in ACTIONS:
        src_dir = os.path.join(SRC_ASSETS, act)
        if not os.path.isdir(src_dir):
            print(f"  跳过（不存在）: {act}")
            continue
        pngs = sorted(glob.glob(os.path.join(src_dir, "*.png")))
        if not pngs:
            continue

        dst_dir = os.path.join(OUT, "assets", act)
        if not check_only:
            os.makedirs(dst_dir, exist_ok=True)

        act_src = 0
        act_dst = 0
        for p in pngs:
            name = os.path.splitext(os.path.basename(p))[0] + ".webp"
            d = os.path.join(dst_dir, name)
            act_src += os.path.getsize(p)
            if check_only:
                # 估算：用已知比率
                act_dst += int(os.path.getsize(p) * 0.207)
                continue
            if os.path.exists(d) and os.path.getmtime(d) > os.path.getmtime(p):
                act_dst += os.path.getsize(d)
                continue
            if convert_one(p, d):
                act_dst += os.path.getsize(d)

        total_src += act_src
        total_dst += act_dst
        print(f"  {act:6s} {len(pngs):3d} 帧  "
              f"{act_src/1024/1024:6.2f} MB -> {act_dst/1024/1024:5.2f} MB  "
              f"({act_dst/act_src*100:4.1f}%)")

    print(f"\n  合计   {total_src/1024/1024:6.2f} MB -> {total_dst/1024/1024:5.2f} MB  "
          f"({total_dst/total_src*100:4.1f}%)   耗时 {time.time()-t0:.0f}s")

    if check_only:
        print("\n--check：未写任何文件")
        return 0

    # 写清单：标 format=webp、每动作 ext=webp
    manifest["format"] = "webp-sequence"
    manifest["quality"] = QUALITY
    for key, val in manifest.get("actions", {}).items():
        val["ext"] = "webp"
    with open(os.path.join(OUT, "assets", "actions.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # 语音直接复制（已是 Opus，无需再压）
    if os.path.isdir(SRC_AUDIO):
        dst_audio = os.path.join(OUT, "audio")
        if os.path.isdir(dst_audio):
            shutil.rmtree(dst_audio)
        shutil.copytree(SRC_AUDIO, dst_audio)
        n = len(glob.glob(os.path.join(dst_audio, "**", "*.ogg"), recursive=True))
        sz = sum(os.path.getsize(p) for p in
                 glob.glob(os.path.join(dst_audio, "**", "*"), recursive=True)
                 if os.path.isfile(p))
        print(f"\n  语音 {n} 条  {sz/1024/1024:.2f} MB（Opus，无需再压）")

    print(f"\n素材已就绪: {os.path.join(OUT, 'assets')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

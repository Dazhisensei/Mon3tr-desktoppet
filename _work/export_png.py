# -*- coding: utf-8 -*-
"""
导出 PNG 序列（运行时资源）。

策略：
- 四个动作在同一坐标系裁切同一区域，保留彼此的相对位置。
- 裁切框 = 四动作全帧并集 + 安全边距，保证不裁掉任何像素（尤其「点击」的冰晶翅膀）。
- 输出 RGBA PNG，alpha 100% 保留。
- 同时生成 actions.json 供运行时读取。

体积控制：
- PNG 用最高压缩（-compression_level 100）。
- 只做无损优化，不降质（后续如需减体积可再评估）。
"""
import json
import os
import shutil
import subprocess

FFMPEG = r"F:\SSV\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe"
ROOT = r"E:\work\deskpet\M3"
SRC = os.path.join(ROOT, "src")
ASSETS = os.path.join(ROOT, "assets")
# 坐姿动画的源文件不在 src/，单独放在这里
EXTRA_SRC = r"F:\SSV\m3"

# 全分辨率(1500x1000)下各动作的全帧并集（已实测）
UNION = {"x0": 329, "y0": 78, "x1": 1225, "y1": 773}
SAFETY = 4
CANVAS_W, CANVAS_H = 1500, 1000

# (key, 文件名, 是否循环, 中文名)
# 「坐」是持续性状态：动画自身循环，何时退出由状态机决定
# （菜单里可切换，见 main.js 的 toggle-sit）。
ACTIONS = [
    ("idle", "待机.mov", True, "待机"),
    ("move", "移动.mov", True, "移动"),
    ("rest", "休息.mov", True, "休息"),
    ("click", "点击.mov", False, "点击"),
    ("sit", "sit.mov", True, "坐"),
]

# 这些文件从 EXTRA_SRC 取，其余在 src/
EXTRA_FILES = {"sit.mov"}


def src_path(fname):
    """动作源文件的完整路径。"""
    if fname in EXTRA_FILES:
        return os.path.join(EXTRA_SRC, fname)
    return os.path.join(SRC, fname)


def even(n):
    return n if n % 2 == 0 else n + 1


def main():
    cx0 = max(0, UNION["x0"] - SAFETY)
    cy0 = max(0, UNION["y0"] - SAFETY)
    cw = even(min(CANVAS_W, UNION["x1"] + 1 + SAFETY) - cx0)
    ch = even(min(CANVAS_H, UNION["y1"] + 1 + SAFETY) - cy0)
    if cx0 + cw > CANVAS_W:
        cx0 = CANVAS_W - cw
    if cy0 + ch > CANVAS_H:
        cy0 = CANVAS_H - ch

    print(f"crop box: x={cx0} y={cy0} w={cw} h={ch}")

    # 清空旧资源（保留 actions.json 会在最后重写）
    if os.path.isdir(ASSETS):
        for item in os.listdir(ASSETS):
            p = os.path.join(ASSETS, item)
            if os.path.isdir(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
    os.makedirs(ASSETS, exist_ok=True)

    manifest = {
        "canvas": {"w": cw, "h": ch},
        "sourceCanvas": {"w": CANVAS_W, "h": CANVAS_H},
        "crop": {"x": cx0, "y": cy0, "w": cw, "h": ch},
        "fps": 30,
        "format": "png-sequence",
        "note": "同一坐标系裁切，各动作相对位置保持不变",
        "actions": {},
    }

    for key, fname, loop, cn in ACTIONS:
        src = src_path(fname)
        if not os.path.exists(src):
            print(f"[skip] 源文件不存在: {src}")
            continue
        outdir = os.path.join(ASSETS, key)
        os.makedirs(outdir, exist_ok=True)
        pattern = os.path.join(outdir, "f%04d.png")

        cmd = [
            FFMPEG, "-y", "-v", "error",
            "-i", src,
            "-vf", f"crop={cw}:{ch}:{cx0}:{cy0}",
            "-pix_fmt", "rgba",
            "-compression_level", "100",
            pattern,
        ]
        print(f"[export] {fname} -> assets/{key}/")
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print("  FAILED:", (r.stderr or "")[-500:])
            continue

        frames = sorted(f for f in os.listdir(outdir) if f.endswith(".png"))
        total = sum(os.path.getsize(os.path.join(outdir, f)) for f in frames)
        print(f"  frames={len(frames)} size={total/1024/1024:.2f} MB")

        manifest["actions"][key] = {
            "name": cn,
            "dir": key,
            "frameCount": len(frames),
            "loop": loop,
            "fps": 30,
            "durationMs": round(len(frames) / 30 * 1000),
            "bytes": total,
        }

    # 顶层汇总
    manifest["totalBytes"] = sum(a["bytes"] for a in manifest["actions"].values())
    manifest["totalFrames"] = sum(a["frameCount"] for a in manifest["actions"].values())

    with open(os.path.join(ASSETS, "actions.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print(f"\ntotal: {manifest['totalFrames']} frames, "
          f"{manifest['totalBytes']/1024/1024:.2f} MB")
    print("wrote assets/actions.json")


if __name__ == "__main__":
    main()

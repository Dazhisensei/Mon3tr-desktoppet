# -*- coding: utf-8 -*-
"""
压缩语音素材：PCM WAV -> Opus(OGG)

- 输入：F:\\videos\\{JP,ZH}\\*.wav（只读，绝不修改）
- 输出：M3\\audio\\{jp,zh}\\*.ogg
- 语音用 48kbps 单声道 Opus，体积可降到约 1/14，听感基本无损

同时生成 audio.json 清单，记录每个音频的时长与对应关系，
后续运行时可直接读取，不必重新探测。
"""
import json
import os
import subprocess
import sys

FFMPEG = r"F:\SSV\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe"
FFPROBE = r"F:\SSV\ffmpeg-9.0.2-essentials_build\bin\ffprobe.exe"

SRC_ROOT = r"F:\videos"
DST_ROOT = r"E:\work\deskpet\M3\audio"

LANGS = [("JP", "jp"), ("ZH", "zh")]

# 语音编码参数：Opus / 48kbps / 单声道 / voip 模式（针对人声优化）
OPUS_ARGS = [
    "-c:a", "libopus",
    "-b:a", "48k",
    "-ac", "1",
    "-ar", "48000",
    "-application", "voip",
    "-vbr", "on",
]


def probe(path):
    r = subprocess.run([
        FFPROBE, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "format=duration,size",
        "-of", "json", path,
    ], capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        d = json.loads(r.stdout)["format"]
        return float(d.get("duration", 0)), int(d.get("size", 0))
    except Exception:
        return 0.0, 0


def main():
    manifest = {"format": "opus", "bitrate": "48k", "sampleRate": 48000,
                "channels": 1, "languages": {}}
    total_in = total_out = 0
    failures = []

    for src_lang, dst_lang in LANGS:
        src_dir = os.path.join(SRC_ROOT, src_lang)
        dst_dir = os.path.join(DST_ROOT, dst_lang)
        os.makedirs(dst_dir, exist_ok=True)

        if not os.path.isdir(src_dir):
            print(f"[跳过] 源目录不存在: {src_dir}")
            continue

        entries = {}
        files = sorted(f for f in os.listdir(src_dir)
                       if f.lower().endswith(".wav"))
        print(f"\n=== {src_lang} -> {dst_lang} ({len(files)} 个) ===")

        for name in files:
            src = os.path.join(src_dir, name)
            stem = os.path.splitext(name)[0]
            dst = os.path.join(dst_dir, stem + ".ogg")

            in_dur, in_size = probe(src)
            cmd = [FFMPEG, "-y", "-v", "error", "-i", src] + OPUS_ARGS + [dst]
            r = subprocess.run(cmd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace")
            if r.returncode != 0 or not os.path.exists(dst):
                failures.append((src_lang, name, (r.stderr or "")[-200:]))
                print(f"  失败: {name}")
                continue

            out_dur, out_size = probe(dst)
            total_in += in_size
            total_out += out_size

            # 时长误差超过 0.15s 视为异常（编码不应改变时长）
            drift = abs(out_dur - in_dur)
            flag = "" if drift < 0.15 else f"  ⚠ 时长偏差 {drift:.2f}s"

            entries[stem] = {
                "file": f"{dst_lang}/{stem}.ogg",
                "durationMs": round(out_dur * 1000),
                "bytes": out_size,
            }
            print(f"  {stem:<22} {in_dur:>6.2f}s  "
                  f"{in_size/1024:>8.0f}KB -> {out_size/1024:>6.0f}KB"
                  f"  ({in_size/max(1,out_size):.1f}x){flag}")

        manifest["languages"][dst_lang] = {
            "label": {"jp": "日本語", "zh": "中文"}[dst_lang],
            "count": len(entries),
            "items": entries,
        }

    manifest["totalBytes"] = total_out

    os.makedirs(DST_ROOT, exist_ok=True)
    with open(os.path.join(DST_ROOT, "audio.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print("\n" + "=" * 56)
    print(f"输入总计 {total_in/1024/1024:.1f} MB")
    print(f"输出总计 {total_out/1024/1024:.1f} MB")
    if total_out:
        print(f"压缩比 {total_in/total_out:.1f}x")
    if failures:
        print(f"\n失败 {len(failures)} 个:")
        for lang, name, err in failures:
            print(f"  [{lang}] {name}: {err}")
    print(f"\n已写入 {os.path.join(DST_ROOT, 'audio.json')}")


if __name__ == "__main__":
    main()

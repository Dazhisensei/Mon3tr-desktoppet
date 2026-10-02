# -*- coding: utf-8 -*-
"""
把过长的 README 拆成「精简首页 + 三个 docs」。

## 为什么用脚本而不是手抄

原 README 有 1381 行，手工搬运极易漏段或错位。这里按**行号区间**
机械切分，保证内容一字不差地转移过去。

## 切分方案

    README.md            门面：简介、下载、操作、菜单、版权（另外手写）
    docs/DESIGN.md       功能与实现细节
    docs/TROUBLESHOOTING.md  踩坑记录与排查方法
    docs/BUILD.md        构建、打包、目录结构、扩展

## 用法

    python _work/split_readme.py
"""

import os
import sys

WORK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(WORK, "..")
README = os.path.join(ROOT, "README.md")
DOCS = os.path.join(ROOT, "docs")


def lines_of(path: str) -> list:
    with open(path, "r", encoding="utf-8") as f:
        return f.read().split("\n")


def take(all_lines: list, start: int, end: int) -> str:
    """取 1-based 闭区间 [start, end] 的行。"""
    return "\n".join(all_lines[start - 1:end])


# (目标文件, 标题, [(起, 止), ...])
PLAN = [
    (
        "DESIGN.md",
        "实现细节",
        "各功能的实现方式与取舍理由。用户不需要读这个，"
        "面向想改代码或理解设计的人。",
        [(46, 87), (453, 1130)],
    ),
    (
        "TROUBLESHOOTING.md",
        "踩坑记录与排查方法",
        "开发过程中遇到并修掉的问题。同一个现象往往对应完全不同的原因，"
        "这里记录了判据与教训——排查类似问题时最有用的一章。",
        [(88, 446)],
    ),
    (
        "BUILD.md",
        "构建与打包",
        "构建环境、离线构建、打包成安装程序、目录结构、如何扩充新动作。",
        [(447, 452), (1160, 1360)],
    ),
]


def main() -> int:
    if not os.path.exists(README):
        print(f"找不到 {README}", file=sys.stderr)
        return 1

    all_lines = lines_of(README)
    total = len(all_lines)
    print(f"源 README: {total} 行\n")

    os.makedirs(DOCS, exist_ok=True)

    for fname, title, intro, ranges in PLAN:
        chunks = []
        for start, end in ranges:
            if end > total:
                print(f"  警告: {fname} 区间 {start}-{end} 超出总行数", file=sys.stderr)
                end = total
            chunks.append(take(all_lines, start, end).strip("\n"))

        body = "\n\n".join(c for c in chunks if c)

        # 不做标题降级：原 README 是 `#` 标题 + `##` 章节，
        # 拆到 docs 后 `#` 正好作文档标题、`##` 仍是章节，层级天然吻合。
        #
        # 曾经想「整体降一级」，但那会连**代码块里的 `#` 注释**一起改掉
        # （构建命令里有 `# 1. 构建` 这类行），属于会静默损坏内容的操作。

        header = (
            f"# {title}\n\n"
            f"> 本文由原 README 拆出，内容未改动。\n"
            f"> 返回 [项目首页](../README.md)。\n\n"
            f"{intro}\n\n"
            f"---\n\n"
        )
        out = os.path.join(DOCS, fname)
        with open(out, "w", encoding="utf-8") as f:
            f.write(header + body + "\n")
        print(f"  {fname:24s} {len(body.split(chr(10))):5d} 行")

    print("\n完成。README 需另行手写精简版。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

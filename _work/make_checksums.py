# -*- coding: utf-8 -*-
"""
为已解压的 vendored crate 生成 `.cargo-checksum.json`。

## 为什么需要

`cargo` 使用 `directory` source（vendored 模式）时，会校验每个包的
`.cargo-checksum.json`。而 registry 的 `src/` 解压目录里**没有**这个文件
——它只存在于 `.crate` 归档和 registry 索引中。

于是离线构建会失败：

    failed to load checksum `.cargo-checksum.json` of adler2 v2.0.1

## 做法

`.crate` 就是 tar.gz。逐包读取归档成员，对**每个文件**算 sha256，
汇总成 cargo 期望的结构：

    {
      "files": { "Cargo.toml": "<sha256>", "src/lib.rs": "<sha256>", ... },
      "package": "<.crate 文件自身的 sha256>"
    }

这样 cargo 既能校验单文件，也能校验整包，与真实 registry 行为一致。

注意：`files` 的键用**正斜杠**，且不含顶层 `名字-版本/` 前缀
——这正是 cargo 的期望格式。

## 用法

    python _work/make_checksums.py
"""

import hashlib
import json
import os
import tarfile
import sys

ROOT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "rust", "cargo", "registry",
)
SRC = os.path.join(ROOT, "src", "127.0.0.1-add83a09cf6a85ff")
CACHE = os.path.join(ROOT, "cache", "127.0.0.1-add83a09cf6a85ff")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    if not os.path.isdir(SRC):
        print(f"缺少目录: {SRC}", file=sys.stderr)
        return 1

    done = 0
    skipped = 0
    failed = []

    for name in sorted(os.listdir(SRC)):
        pkg_dir = os.path.join(SRC, name)
        if not os.path.isdir(pkg_dir):
            continue

        out_path = os.path.join(pkg_dir, ".cargo-checksum.json")
        if os.path.exists(out_path):
            skipped += 1
            continue

        crate_file = os.path.join(CACHE, name + ".crate")
        if not os.path.exists(crate_file):
            failed.append((name, "缺少 .crate 归档"))
            continue

        # package 字段 = 归档文件本身的 sha256
        with open(crate_file, "rb") as f:
            pkg_sum = sha256_bytes(f.read())

        files = {}
        try:
            with tarfile.open(crate_file, "r:gz") as tf:
                for m in tf.getmembers():
                    if not m.isfile():
                        continue
                    # 去掉顶层 `名字-版本/` 前缀
                    rel = m.name.split("/", 1)
                    if len(rel) < 2:
                        continue
                    key = rel[1]
                    fh = tf.extractfile(m)
                    if fh is None:
                        continue
                    files[key] = sha256_bytes(fh.read())
        except Exception as e:  # noqa: BLE001
            failed.append((name, f"解包失败: {e}"))
            continue

        # sort_keys 让输出稳定，便于 diff 与复现
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"files": files, "package": pkg_sum}, f, sort_keys=True)

        done += 1

    print(f"生成 {done} 个，跳过 {skipped} 个（已存在）")
    if failed:
        print(f"失败 {len(failed)} 个：", file=sys.stderr)
        for n, why in failed:
            print(f"  {n}: {why}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

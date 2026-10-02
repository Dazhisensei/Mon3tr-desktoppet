# -*- coding: utf-8 -*-
"""
预取 Tauri 打包所需的外部工具（NSIS 3.11 + nsis_tauri_utils.dll）。

## 为什么需要

`cargo tauri build` 会自动下载这些工具，但本机 cargo 的内置 schannel
在受控网络下无法完成 TLS 凭证交换（SEC_E_NO_CREDENTIALS），下载必失败。

因此这里用 Python 的 OpenSSL 栈（走本地代理）预先取回并解包，
放到 Tauri 期望的位置，让 `cargo tauri build` 直接复用、不再联网。

## 放到哪里

`tauri.conf.json` 里设了 `bundle.useLocalToolsDir: true`，
此时 tauri-bundler 会把工具放在 **cargo 的 target 目录**下：

    desktop-pet/src-tauri/target/<profile>/.tauri/

（见 tauri-cli 的 src/interface/mod.rs：use_local_tools_dir 为真时
 local_tools_directory = cargo metadata 的 target_directory）

于是 NSIS 落在：

    desktop-pet/src-tauri/target/release/.tauri/NSIS/

选中 target 目录而不是 %LOCALAPPDATA%，是因为后者在受限沙箱下
**不可写**（WinError 5）。

## 版本必须与 tauri-bundler 内置的常量一致

见 tauri-bundler 的 src/bundle/windows/nsis/mod.rs：

    NSIS_URL        = .../nsis-3.11/nsis-3.11.zip
    NSIS_SHA1       = EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D
    NSIS_TAURI_UTILS_URL = .../nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll
    NSIS_REQUIRED_FILES  = [
        "makensis.exe",
        "Bin/makensis.exe",
        "Plugins/x86-unicode/additional/nsis_tauri_utils.dll",
    ]

本脚本会校验 SHA1，确保取到的正是 Tauri 期望的那份。

## 用法

    set UPSTREAM_PROXY=http://127.0.0.1:7897
    python _work/fetch_nsis.py
"""

import hashlib
import io
import os
import shutil
import sys
import urllib.request
import zipfile

PROXY = os.environ.get("UPSTREAM_PROXY", "http://127.0.0.1:7897")

# 与 tauri-bundler 2.10.1 的常量保持一致
NSIS_URL = (
    "https://github.com/tauri-apps/binary-releases/releases/download/"
    "nsis-3.11/nsis-3.11.zip"
)
NSIS_SHA1 = "EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D"
NSIS_INNER_DIR = "nsis-3.11"

UTILS_URL = (
    "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/"
    "nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
)
UTILS_SHA1 = "75197FEE3C6A814FE035788D1C34EAD39349B860"
UTILS_REL = os.path.join("Plugins", "x86-unicode", "additional", "nsis_tauri_utils.dll")

# cargo 的 target 目录（useLocalToolsDir 时工具放这里）
#
# 注意：目录**不含 profile**。tauri-cli 取的是
# `cargo metadata` 的 target_directory，实测为
#   <项目>/src-tauri/target
# 而不是 target/release。放错层级会被忽略，Tauri 转而尝试联网下载。
WORK = os.path.dirname(os.path.abspath(__file__))
TARGET_DIR = os.environ.get(
    "TAURI_TARGET_DIR",
    os.path.join(WORK, "..", "desktop-pet", "src-tauri", "target"),
)
DEST = os.path.join(TARGET_DIR, ".tauri", "NSIS")

_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "tauri-tools/1.0"})
    with _opener.open(req, timeout=180) as r:
        return r.read()


def sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest().upper()


def get_zip(url: str, want_sha1: str, inner: str, dest: str) -> bool:
    print(f"[nsis] 下载 {url}")
    try:
        raw = fetch(url)
    except Exception as e:  # noqa: BLE001
        print(f"[nsis] 下载失败: {type(e).__name__}: {e}", file=sys.stderr)
        return False

    got = sha1(raw)
    if got != want_sha1:
        print(f"[nsis] SHA1 不匹配！\n  期望 {want_sha1}\n  实际 {got}", file=sys.stderr)
        return False
    print(f"[nsis] SHA1 校验通过，{len(raw)/1024/1024:.2f} MB")

    # 解包到父目录，再把内层版本目录改名成 NSIS
    parent = os.path.dirname(dest)
    os.makedirs(parent, exist_ok=True)
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            z.extractall(parent)
    except Exception as e:  # noqa: BLE001
        print(f"[nsis] 解包失败: {e}", file=sys.stderr)
        return False

    extracted = os.path.join(parent, inner)
    if not os.path.isdir(extracted):
        print(f"[nsis] 解包后找不到 {inner}", file=sys.stderr)
        return False
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.rename(extracted, dest)
    return True


def get_file(url: str, want_sha1: str, dest_file: str) -> bool:
    print(f"[utils] 下载 {url}")
    try:
        raw = fetch(url)
    except Exception as e:  # noqa: BLE001
        print(f"[utils] 下载失败: {type(e).__name__}: {e}", file=sys.stderr)
        return False

    got = sha1(raw)
    if got != want_sha1:
        print(f"[utils] SHA1 不匹配！\n  期望 {want_sha1}\n  实际 {got}", file=sys.stderr)
        return False
    print(f"[utils] SHA1 校验通过，{len(raw)/1024:.1f} KB")

    os.makedirs(os.path.dirname(dest_file), exist_ok=True)
    with open(dest_file, "wb") as f:
        f.write(raw)
    return True


def main() -> int:
    makensis = os.path.join(DEST, "makensis.exe")
    utils_dll = os.path.join(DEST, UTILS_REL)

    if os.path.exists(makensis) and os.path.exists(utils_dll):
        print(f"已就绪，跳过下载：\n  {makensis}\n  {utils_dll}")
        return 0

    if not os.path.exists(makensis):
        if not get_zip(NSIS_URL, NSIS_SHA1, NSIS_INNER_DIR, DEST):
            return 1

    if not os.path.exists(os.path.join(DEST, "Bin", "makensis.exe")):
        print(f"缺少 Bin/makensis.exe（Tauri 必需）", file=sys.stderr)
        return 1

    if not os.path.exists(utils_dll):
        if not get_file(UTILS_URL, UTILS_SHA1, utils_dll):
            return 1

    print("\n完成，Tauri 所需文件齐全：")
    for rel in ("makensis.exe", os.path.join("Bin", "makensis.exe"), UTILS_REL):
        p = os.path.join(DEST, rel)
        print(f"  [{'OK' if os.path.exists(p) else '缺失'}] {rel}")
    print(f"\n目录: {os.path.normpath(DEST)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

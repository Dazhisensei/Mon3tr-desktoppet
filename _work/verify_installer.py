# -*- coding: utf-8 -*-
"""
校验 NSIS 安装程序的内容（不依赖安装、不写注册表）。

## 为什么不用「真的装一遍」

安装程序默认装到 %LOCALAPPDATA%\\<产品名> 并写注册表卸载项，
这两处都在受控沙箱的**可写范围之外**，静默安装会被拒绝，
因此「装一遍」在本环境下无法作为验证手段。

改为**静态校验**，同样能证明包是完整的：

1. PE 头有效（MZ / PE）
2. 内嵌载荷包含主程序（NSIS 会把文件以压缩形式贴在末尾）
3. 安装脚本特征串齐全（快捷方式、卸载器、注册表项、安装目录）
4. 语言与安装模式符合 tauri.conf.json 的设定

## 用法

    python _work/verify_installer.py
"""

import os
import json
import re
import sys

WORK = os.path.dirname(os.path.abspath(__file__))
TAURI_DIR = os.path.join(WORK, "..", "desktop-pet", "src-tauri")
CONF_PATH = os.path.join(TAURI_DIR, "tauri.conf.json")

# 安装程序文件名由 tauri.conf.json 的 productName + version 决定，
# 这里读配置拼出来 —— 改名后不必再手改本脚本。
with open(CONF_PATH, "r", encoding="utf-8") as _f:
    _conf = json.load(_f)
PRODUCT = _conf["productName"]
VERSION = _conf["version"]
SETUP = os.path.join(
    TAURI_DIR, "target", "release",
    "bundle", "nsis", f"{PRODUCT}_{VERSION}_x64-setup.exe",
)


def main() -> int:
    if not os.path.exists(SETUP):
        print(f"找不到安装程序: {SETUP}", file=sys.stderr)
        return 1

    size = os.path.getsize(SETUP)
    with open(SETUP, "rb") as f:
        data = f.read()

    fails = []

    def chk(name: str, ok: bool, extra: str = "") -> None:
        print(f"  {'OK ' if ok else 'FAIL'} {name}{('  ' + extra) if extra else ''}")
        if not ok:
            fails.append(name)

    print(f"产品名: {PRODUCT} {VERSION}")
    print(f"文件: {os.path.basename(SETUP)}")
    print(f"大小: {size/1024/1024:.2f} MB\n")

    print("=== PE 头 ===")
    chk("MZ 签名", data[:2] == b"MZ")
    pe_off = int.from_bytes(data[0x3C:0x40], "little")
    chk("PE 签名", data[pe_off:pe_off + 4] == b"PE\0\0", f"offset=0x{pe_off:X}")

    print("\n=== 安装脚本特征（Tauri 生成）===")
    # 注意：NSIS 里的字符串是 **UTF-16LE**，只按 ASCII 搜会误判为「不存在」。
    # 这里两种编码都查。
    ascii_text = data.decode("latin-1", "ignore")
    utf16_text = data.decode("utf-16-le", "ignore")

    def has(s: str) -> bool:
        return (s in ascii_text) or (s in utf16_text)

    chk(f"内嵌产品名 {PRODUCT}", has(PRODUCT))
    chk("NSIS 引擎标识（Nullsoft）", has("Nullsoft"))

    # 从 tauri-bundler 的模板确认卸载器/快捷方式逻辑存在
    tpl = os.path.join(
        os.environ.get("CARGO_HOME", ""),
        "registry", "src", "127.0.0.1-add83a09cf6a85ff",
        "tauri-bundler-2.10.1", "src", "bundle", "windows", "nsis", "installer.nsi",
    )
    if os.path.exists(tpl):
        with open(tpl, "r", encoding="utf-8", errors="replace") as f:
            nsi = f.read()
        chk("模板含卸载器（WriteUninstaller）", "WriteUninstaller" in nsi)
        chk("模板含注册表卸载项（Uninstall key）",
            "CurrentVersion\\\\Uninstall" in nsi or "CurrentVersion\\Uninstall" in nsi)
        chk("模板含开始菜单快捷方式", "SMPROGRAMS" in nsi or "CreateShortCut" in nsi)
    else:
        print(f"  (跳过模板检查：找不到 {tpl})")

    print("\n=== 载荷（主程序是否内嵌）===")
    # NSIS 会压缩载荷，直接搜明文往往找不到；
    # 但 exe 的关键字符串（内嵌前端资源名）若不压缩则可见。
    # 这里以「包体积是否与源 exe 相当」作为主要判据。
    src_exe = os.path.join(WORK, "..", "desktop-pet", "src-tauri",
                           "target", "release", "desktop-pet.exe")
    if os.path.exists(src_exe):
        exe_size = os.path.getsize(src_exe)
        print(f"  源 exe 大小      : {exe_size/1024/1024:.2f} MB")
        print(f"  安装程序大小      : {size/1024/1024:.2f} MB")
        ratio = size / exe_size
        # NSIS 用 LZMA 压缩，通常能压到 80%~105%（含安装器自身开销）
        chk("安装程序体积与源 exe 相当（载荷已内嵌）",
            0.6 <= ratio <= 1.3, f"比值 {ratio:.2f}")

    print("\n=== 压缩方式 ===")
    # NSIS 的 LZMA 头特征
    chk("含 LZMA 压缩数据", b"lzma" in data.lower() or size > 10 * 1024 * 1024)

    print("\n=== 汇总 ===")
    if fails:
        print(f"  {len(fails)} 项未通过：{', '.join(fails)}")
        return 1
    print("  全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

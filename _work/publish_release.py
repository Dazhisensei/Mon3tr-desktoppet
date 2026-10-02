# -*- coding: utf-8 -*-
"""
创建 GitHub Release 并上传构建产物。

## 为什么要自己写

本机没装 `gh` CLI，而受限网络下装它不方便。
GitHub 的 Release API 本身很简单，用标准库即可完成，
不必再引入依赖。

## 流程

1. 从 git 凭据助手取 GitHub token（GCM 存在 Windows 凭据管理器里）
2. `POST /repos/{owner}/{repo}/releases` 创建 release（若同 tag 已存在则复用）
3. 对每个产物：以 `Content-Type: application/octet-stream` 流式 PUT 上传
   （70MB 级文件一次性读进内存没必要，这里用分块发送）

## 用法

    set UPSTREAM_PROXY=http://127.0.0.1:7897
    python _work/publish_release.py [--dry-run]
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

WORK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(WORK, ".."))
DIST = os.path.join(ROOT, "dist")

OWNER = "Dazhisensei"
REPO = "Mon3tr-desktoppet"
TAG = "v0.1.0"
NAME = "Mon3trPet v0.1.0"
PROXY = os.environ.get("UPSTREAM_PROXY", "http://127.0.0.1:7897")

ASSETS = [
    os.path.join(DIST, "Mon3trPet_0.1.0_x64-setup.exe"),
    os.path.join(DIST, "Mon3trPet-0.1.0-win64.zip"),
]

BODY = """《明日方舟》干员 Mon3tr（M3）主题的 Windows 桌面宠物。

## 下载

| 文件 | 说明 |
|---|---|
| `Mon3trPet_0.1.0_x64-setup.exe` | 安装程序（推荐），含开始菜单快捷方式与卸载器 |
| `Mon3trPet-0.1.0-win64.zip` | 免安装绿色版，解压即用 |

> 绿色版请解压到**可写目录**（桌面、`D:\\Tools\\` 等）。
> 程序会在 exe 同目录生成配置与 WebView2 缓存，
> 放在 `C:\\Program Files\\` 会因权限不足导致设置存不下来。

## 功能

- 自主行为：待机 / 行走 / 休息 / 坐下 / 跟随鼠标
- 38 条中日双语语音，含节日与生日触发
- 天气查询（Open-Meteo，无需 API Key）
- 随时段加权的 50 条随机关心语句
- 点击穿透、透明无边框窗口、DOM 菜单与设置面板

## 要求

Windows 10/11 64 位，需 WebView2 运行时（Win11 及新版 Win10 已内置）。

## 说明

- 未做代码签名，首次运行 SmartScreen 可能提示，点「仍要运行」即可
- 美术与语音素材版权属《明日方舟》（Hypergryph），仅供学习使用
"""

PROXY_HANDLER = urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})


def get_token() -> str:
    """从 git 凭据助手取 GitHub token。"""
    p = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True, text=True, cwd=ROOT,
    )
    for line in p.stdout.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    raise SystemExit("未能从凭据助手取得 token")


def api(token: str, method: str, path: str, payload=None, allow_404=False):
    """调用 GitHub API。

    allow_404：查询「某 tag 的 release 是否存在」时，404 是**正常结果**
    （表示不存在），不该当致命错误。早期版本没区分，导致创建前就抛异常。
    """
    url = "https://api.github.com" + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "Mon3trPet-release")
    if data:
        req.add_header("Content-Type", "application/json")
    opener = urllib.request.build_opener(PROXY_HANDLER)
    try:
        with opener.open(req, timeout=120) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        if allow_404 and e.code == 404:
            return None
        detail = e.read().decode("utf-8", "replace")
        raise SystemExit(f"API {method} {path} 失败: {e.code}\n{detail}")


def upload(token: str, upload_url: str, path: str) -> None:
    """流式上传一个产物。"""
    name = os.path.basename(path)
    size = os.path.getsize(path)
    # upload_url 形如 https://uploads.github.com/...{?name,label}
    base = upload_url.split("{")[0]
    url = f"{base}?name={urllib.parse.quote(name)}"

    print(f"  上传 {name}  ({size/1024/1024:.2f} MB) ...", flush=True)

    req = urllib.request.Request(url, data=open(path, "rb"), method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/octet-stream")
    req.add_header("Content-Length", str(size))
    req.add_header("User-Agent", "Mon3trPet-release")

    opener = urllib.request.build_opener(PROXY_HANDLER)
    try:
        with opener.open(req, timeout=1800) as r:
            info = json.loads(r.read())
            print(f"    -> {info['browser_download_url']}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise SystemExit(f"上传 {name} 失败: {e.code}\n{detail}")


def main() -> int:
    dry = "--dry-run" in sys.argv

    missing = [p for p in ASSETS if not os.path.exists(p)]
    if missing:
        print("缺少产物:", file=sys.stderr)
        for m in missing:
            print("  " + m, file=sys.stderr)
        return 1

    print("=== 待上传 ===")
    for p in ASSETS:
        print(f"  {os.path.basename(p):40s} {os.path.getsize(p)/1024/1024:7.2f} MB")
    if dry:
        print("\n--dry-run：仅检查，不实际上传")
        return 0

    token = get_token()
    print(f"\ntoken 已取得（{token[:4]}***，长度 {len(token)}）")

    # 已存在同 tag 的 release 就复用，避免重复创建报 422
    existing = api(token, "GET",
                  f"/repos/{OWNER}/{REPO}/releases/tags/{TAG}", allow_404=True)
    if existing and existing.get("id"):
        rel = existing
        print(f"复用已有 release: {rel['tag_name']} (id={rel['id']})")
    else:
        print(f"创建 release {TAG} ...")
        rel = api(token, "POST", f"/repos/{OWNER}/{REPO}/releases", {
            "tag_name": TAG,
            "name": NAME,
            "body": BODY,
            "draft": False,
            "prerelease": False,
        })
        print(f"  已创建 (id={rel['id']})")

    # 已有同名资产先删掉，否则上传会 422
    for a in rel.get("assets", []):
        print(f"  删除同名旧资产: {a['name']}")
        api(token, "DELETE",
            f"/repos/{OWNER}/{REPO}/releases/assets/{a['id']}")

    print("\n=== 上传产物 ===")
    for p in ASSETS:
        upload(token, rel["upload_url"], p)

    print(f"\n完成：https://github.com/{OWNER}/{REPO}/releases/tag/{TAG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

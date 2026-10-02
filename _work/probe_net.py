# -*- coding: utf-8 -*-
"""探测代理出网能力（用 Python 的 OpenSSL 栈，绕开 schannel）。"""
import urllib.request
import ssl

PROXY = "http://127.0.0.1:7897"
opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
)

urls = [
    "https://index.crates.io/config.json",
    "https://rsproxy.cn/index/config.json",
    "https://github.com/tauri-apps/tauri/releases",
    "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3/nsis-3.zip",
]

for u in urls:
    try:
        req = urllib.request.Request(u, headers={"User-Agent": "probe/1.0"})
        r = opener.open(req, timeout=20)
        print(f"  OK   {r.status}  {u}")
    except Exception as e:
        print(f"  FAIL       {u}\n         -> {type(e).__name__}: {e}")

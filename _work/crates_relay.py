# -*- coding: utf-8 -*-
"""
本地 crates registry 代理（纯 HTTP，规避 cargo 的 schannel 问题）。

原理：
- cargo 编译时内置了 schannel，在受限沙箱下无法完成 TLS 凭证交换
  (SEC_E_NO_CREDENTIALS)，因此无法直接访问任何 HTTPS registry。
- 本服务监听 127.0.0.1 的明文 HTTP，用 Python 的 OpenSSL 栈去访问上游
  稀疏索引 (sparse+https://...) 与 crate 下载。
- cargo 配置指向 http://127.0.0.1:<port>/index/ 即可正常工作。

路由：
  GET /index/config.json          -> 上游 index/config.json（并改写 dl 指向本服务）
  GET /index/<path>               -> 上游稀疏索引文件
  GET /crates/<name>/<ver>/download -> 上游 crate tar.gz
"""
import http.server
import json
import os
import socketserver
import sys
import urllib.parse
import urllib.request
import gzip
import io

UPSTREAM_INDEX = "http://127.0.0.1:7897"  # 占位，实际用下面 opener
PROXY = os.environ.get("UPSTREAM_PROXY", "http://127.0.0.1:7897")
INDEX_BASE = "https://rsproxy.cn/index/"
DL_BASE = "https://rsproxy.cn/api/v1/crates/"

_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
)

PORT = int(os.environ.get("RELAY_PORT", "8901"))
HOST = "127.0.0.1"


def fetch(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": "cargo-relay/1.0"})
    return _opener.open(req, timeout=timeout)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("RELAY_VERBOSE"):
            sys.stderr.write("[relay] " + (fmt % args) + "\n")

    def _send(self, code, body=b"", ctype="application/octet-stream"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        path = urllib.parse.urlparse(self.path).path
        try:
            # config.json：改写 dl 指向本服务
            if path in ("/index/config.json", "/config.json"):
                raw = fetch(INDEX_BASE + "config.json").read()
                cfg = json.loads(raw.decode("utf-8"))
                cfg["dl"] = f"http://{HOST}:{PORT}/crates"
                body = json.dumps(cfg).encode("utf-8")
                self._send(200, body, "application/json")
                return

            # 稀疏索引文件
            if path.startswith("/index/"):
                sub = path[len("/index/"):]
                raw = fetch(INDEX_BASE + sub).read()
                self._send(200, raw, "text/plain")
                return

            # crate 下载：/crates/<name>/<version>/download
            if path.startswith("/crates/"):
                parts = path.strip("/").split("/")
                # crates / name / version / download
                if len(parts) >= 4 and parts[-1] == "download":
                    name, ver = parts[1], parts[2]
                    url = f"{DL_BASE}{name}/{ver}/download"
                    raw = fetch(url).read()
                    self._send(200, raw, "application/gzip")
                    return

            self._send(404, b"not found", "text/plain")
        except urllib.error.HTTPError as e:
            self._send(e.code, str(e).encode(), "text/plain")
        except Exception as e:
            self._send(502, f"relay error: {e}".encode(), "text/plain")


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    srv = Server((HOST, PORT), Handler)
    print(f"crates relay on http://{HOST}:{PORT}  (upstream proxy {PROXY})", flush=True)
    srv.serve_forever()

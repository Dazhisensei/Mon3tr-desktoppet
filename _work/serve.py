# -*- coding: utf-8 -*-
"""
极简静态文件服务器，用于在浏览器中预览桌宠素材。

用途：file:// 协议下浏览器会拦截 fetch()，导致 preview.html 读不到
actions.json。通过 http:// 提供同一目录即可正常预览。
"""
import http.server
import os
import socketserver
import sys

ROOT = os.environ.get("SERVE_ROOT", r"E:\work\deskpet\M3\desktop-pet\web")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve] " + (fmt % args) + "\n")

    def end_headers(self):
        # 预览用：避免缓存干扰反复调试
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    srv = Server(("127.0.0.1", PORT), Handler)
    print(f"serving {ROOT} at http://127.0.0.1:{PORT}/preview.html", flush=True)
    srv.serve_forever()

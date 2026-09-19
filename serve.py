#!/usr/bin/env python3
"""本機預覽伺服器。ES module 不能用 file:// 開，所以一定要透過 http。"""
import functools, http.server, os, socketserver, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=ROOT)) as httpd:
    print(f'serving {ROOT} on http://localhost:{PORT}')
    httpd.serve_forever()

"""One-click start on any OS: serve ChessLocal, open it in the browser, show the panel."""
import functools
import http.server
import os
import socketserver
import threading
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8080
URL = f"http://localhost:{PORT}"


def game_dir():
    for d in (os.environ.get("CHESSLOCAL_DIR"), os.path.expanduser("~/chess"), os.path.join(HERE, "game")):
        if d and os.path.isfile(os.path.join(d, "index.html")):
            return d
    raise SystemExit("ChessLocal not found (expected ./game)")


def serving():
    try:
        return b"ChessLocal" in urllib.request.urlopen(URL, timeout=1).read()
    except Exception:
        return False


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=game_dir())
    http.server.SimpleHTTPRequestHandler.extensions_map[".wasm"] = "application/wasm"
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()


def open_browser():
    for name in ("chrome", "google-chrome", "windows-default", "macosx", None):
        try:
            if (webbrowser.get(name) if name else webbrowser).open(URL):
                return
        except webbrowser.Error:
            continue


if __name__ == "__main__":
    if not serving():
        serve()
    open_browser()
    import osutil
    osutil.setup_dpi()
    from app import Overlay
    Overlay().run()

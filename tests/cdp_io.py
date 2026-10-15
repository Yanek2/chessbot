"""Headless-Chrome stand-in for the desktop (screenshots + mouse over DevTools)."""
import base64, io, json, os, subprocess, tempfile, time, urllib.request
import numpy as np
import websocket
from PIL import Image


class CDP:
    def __init__(self, url, port=9333, w=1400, h=900):
        self.prof = tempfile.mkdtemp(prefix="cbtest")
        self.p = subprocess.Popen(["google-chrome", "--headless=new", "--disable-gpu", "--hide-scrollbars",
                                   f"--remote-debugging-port={port}", f"--window-size={w},{h}",
                                   f"--user-data-dir={self.prof}", url],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                break
            except Exception:
                time.sleep(0.2)
        tab = [t for t in tabs if t["type"] == "page"][0]
        self.ws = websocket.create_connection(tab["webSocketDebuggerUrl"], suppress_origin=True)
        self.i = 0
        time.sleep(2)

    def call(self, m, **p):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": m, "params": p}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == self.i:
                return r.get("result")

    def grab_full(self):
        d = self.call("Page.captureScreenshot", format="png")["data"]
        return np.asarray(Image.open(io.BytesIO(base64.b64decode(d))).convert("RGB")), 0, 0

    def grab(self, reg):
        x, y, w, h = map(int, reg)
        return np.ascontiguousarray(self.grab_full()[0][y:y + h, x:x + w])

    def _m(self, t, x, y, **k):
        self.call("Input.dispatchMouseEvent", type=t, x=x, y=y, button="left", **k)

    def move_to(self, x, y, d=0):
        self._m("mouseMoved", x, y)

    def click(self, x, y):
        self._m("mousePressed", x, y, clickCount=1)
        self._m("mouseReleased", x, y, clickCount=1)

    def drag(self, x0, y0, x1, y1):
        self._m("mousePressed", x0, y0, clickCount=1)
        for i in range(1, 9):
            self._m("mouseMoved", x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8, buttons=1)
        self._m("mouseReleased", x1, y1, clickCount=1)

    def close(self):
        self.p.terminate()
        subprocess.run(["pkill", "-f", f"user-data-dir={self.prof}"])

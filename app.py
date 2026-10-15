"""ChessBot overlay: small always-on-top panel.

  Lock  (F9)  - find the board on screen and read the pieces
  Play  (F8)  - start / pause auto-play
  Style       - Solid / Mixed / Aggressive / Human
  Speed       - Fast / Normal / Slow (human-like think times)
"""
import queue
import random
import threading
import time
import tkinter as tk

import numpy as np
from pynput import keyboard, mouse

import vision
from bot import Bot
from brain import STYLES

BG, FG, ACC, MUTED = "#262421", "#ece8e1", "#81b64c", "#9a968f"


class DesktopIO:
    """Real screen + mouse. Moves the cursor in a smooth human-ish curve."""

    def __init__(self, hide_cb=None):
        self.m = mouse.Controller()
        self.hide_cb = hide_cb

    def grab_full(self):
        return vision.grab()

    def grab(self, region):
        return vision.grab(region)[0]

    def move_to(self, x, y, duration=0.3):
        sx, sy = self.m.position
        steps = max(8, int(duration * 90))
        # slight arc: control point offset sideways
        cx = (sx + x) / 2 + random.uniform(-40, 40)
        cy = (sy + y) / 2 + random.uniform(-40, 40)
        for i in range(1, steps + 1):
            t = i / steps
            t = t * t * (3 - 2 * t)                       # ease in/out
            px = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * x
            py = (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * y
            self.m.position = (int(px), int(py))
            time.sleep(duration / steps)
        self.m.position = (int(x), int(y))

    def click(self, x, y):
        self.m.position = (int(x), int(y))
        time.sleep(0.03)
        self.m.press(mouse.Button.left)
        time.sleep(random.uniform(0.04, 0.09))
        self.m.release(mouse.Button.left)

    def drag(self, x0, y0, x1, y1):
        self.move_to(x0, y0, 0.15)
        self.m.press(mouse.Button.left)
        time.sleep(0.08)
        self.move_to(x1, y1, random.uniform(0.25, 0.45))
        time.sleep(0.05)
        self.m.release(mouse.Button.left)


class Overlay:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("ChessBot")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=BG, highlightthickness=1, highlightbackground="#3c3a37")
        sw = self.root.winfo_screenwidth()
        self.root.geometry(f"+{sw - 300}+40")
        self.msgs = queue.Queue()
        self.io = DesktopIO()
        self.bot = Bot(self.io, status=self.msgs.put)
        self.outline = []
        self._build()
        self._hotkeys()
        self.root.after(100, self._pump)

    # ------------------------------------------------------------------ UI
    def _build(self):
        bar = tk.Frame(self.root, bg="#1f1e1b")
        bar.pack(fill="x")
        title = tk.Label(bar, text="♞ ChessBot", bg="#1f1e1b", fg=FG, font=("DejaVu Sans", 11, "bold"), padx=8, pady=5)
        title.pack(side="left")
        tk.Button(bar, text="✕", command=self.quit, bg="#1f1e1b", fg=MUTED, bd=0,
                  activebackground="#b33", activeforeground="white", padx=8).pack(side="right")
        for w in (bar, title):
            w.bind("<ButtonPress-1>", self._drag_start)
            w.bind("<B1-Motion>", self._drag_move)

        body = tk.Frame(self.root, bg=BG, padx=10, pady=8)
        body.pack(fill="both")
        row = tk.Frame(body, bg=BG)
        row.pack(fill="x")
        self.lock_btn = self._btn(row, "⌖ Lock  F9", self.lock, "#3c3a37")
        self.lock_btn.pack(side="left", expand=True, fill="x", padx=(0, 4))
        self.play_btn = self._btn(row, "▶ Play  F8", self.toggle, ACC)
        self.play_btn.pack(side="left", expand=True, fill="x")

        self.style = tk.StringVar(value="Mixed")
        self.speed = tk.StringVar(value="Normal")
        for label, var, opts in (("Style", self.style, list(STYLES)),
                                 ("Speed", self.speed, ["Fast", "Normal", "Slow"])):
            f = tk.Frame(body, bg=BG)
            f.pack(fill="x", pady=(8, 0))
            tk.Label(f, text=label, bg=BG, fg=MUTED, width=6, anchor="w").pack(side="left")
            for o in opts:
                tk.Radiobutton(f, text=o, value=o, variable=var, indicatoron=False, bg="#3c3a37", fg=FG,
                               selectcolor="#5d5a55", activebackground="#4a4743", bd=0, padx=5, pady=2,
                               command=self._apply).pack(side="left", padx=1)

        self.status = tk.Label(body, text="Open your game, then press Lock", bg=BG, fg=FG,
                               wraplength=270, justify="left", anchor="w", pady=8)
        self.status.pack(fill="x")

    def _btn(self, parent, text, cmd, color):
        return tk.Button(parent, text=text, command=cmd, bg=color, fg="white", bd=0,
                         activebackground=color, activeforeground="white",
                         font=("DejaVu Sans", 10, "bold"), pady=6)

    def _drag_start(self, e):
        self._dx, self._dy = e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y()

    def _drag_move(self, e):
        self.root.geometry(f"+{e.x_root - self._dx}+{e.y_root - self._dy}")

    def _apply(self):
        self.bot.style = self.style.get()
        self.bot.speed = self.speed.get()

    # ------------------------------------------------------------- actions
    def lock(self):
        if self.bot.playing:
            self.toggle()
        self._clear_outline()
        self.msgs.put("Looking for the board...")
        self.root.withdraw()                    # don't let the panel hide the board
        self.root.after(250, self._do_lock)

    def _do_lock(self):
        def work():
            ok = self.bot.lock()
            self.root.after(0, lambda: self._after_lock(ok))
        threading.Thread(target=work, daemon=True).start()

    def _after_lock(self, ok):
        self.root.deiconify()
        self.root.attributes("-topmost", True)
        if ok:
            self._draw_outline()

    def toggle(self):
        if self.bot.playing:
            self.bot.stop()
            self.play_btn.config(text="▶ Play  F8", bg=ACC, activebackground=ACC)
            self.msgs.put("Paused")
        else:
            if self.bot.region is None:
                self.msgs.put("Press Lock first")
                return
            self._apply()
            self.bot.start()
            self.play_btn.config(text="❚❚ Pause  F8", bg="#c0603a", activebackground="#c0603a")

    def _draw_outline(self):
        x, y, s = self.bot.region
        t = 3
        for gx, gy, gw, gh in ((x - t - 2, y - t - 2, s + 2 * t + 4, t), (x - t - 2, y + s + 2, s + 2 * t + 4, t),
                               (x - t - 2, y - 2, t, s + 4), (x + s + 2, y - 2, t, s + 4)):
            w = tk.Toplevel(self.root)
            w.overrideredirect(True)
            w.attributes("-topmost", True)
            w.configure(bg=ACC)
            w.geometry(f"{gw}x{gh}+{int(gx)}+{int(gy)}")
            self.outline.append(w)

    def _clear_outline(self):
        for w in self.outline:
            w.destroy()
        self.outline = []

    def _hotkeys(self):
        def on_press(k):
            if k == keyboard.Key.f8:
                self.root.after(0, self.toggle)
            elif k == keyboard.Key.f9:
                self.root.after(0, self.lock)
        self.kl = keyboard.Listener(on_press=on_press)
        self.kl.daemon = True
        self.kl.start()

    def _pump(self):
        try:
            while True:
                text = self.msgs.get_nowait()
                self.status.config(text=text)
                if not self.bot.playing and self.play_btn.cget("text").startswith("❚❚"):
                    self.play_btn.config(text="▶ Play  F8", bg=ACC, activebackground=ACC)
        except queue.Empty:
            pass
        self.root.after(100, self._pump)

    def quit(self):
        self.bot.stop()
        if self.bot.brain:
            self.bot.brain.close()
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    Overlay().run()

"""Per-OS bits: DPI setup, active window title, finding/downloading Stockfish."""
import io
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINES = os.path.join(HERE, "engines")
SYSTEM = platform.system()          # 'Linux', 'Windows', 'Darwin'
GAME_TITLE = "ChessLocal"           # the bot only plays on this window
SF_RELEASE = "https://github.com/official-stockfish/Stockfish/releases/download/sf_17.1/"


def setup_dpi():
    """Windows: make screenshots and mouse use the same (physical) pixels."""
    if SYSTEM == "Windows":
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass


def active_window_title():
    """Title of the focused window, or '' if it can't be read."""
    try:
        if SYSTEM == "Windows":
            import ctypes
            u = ctypes.windll.user32
            h = u.GetForegroundWindow()
            n = u.GetWindowTextLengthW(h)
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, buf, n + 1)
            return buf.value
        if SYSTEM == "Darwin":
            script = ('tell application "System Events" to tell (first application process '
                      'whose frontmost is true) to get name of front window')
            out = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=2)
            return out.stdout.strip()
        from Xlib import display, X
        d = display.Display()
        root = d.screen().root
        atom = d.intern_atom("_NET_ACTIVE_WINDOW")
        win_id = root.get_full_property(atom, X.AnyPropertyType).value[0]
        w = d.create_resource_object("window", win_id)
        name = w.get_full_property(d.intern_atom("_NET_WM_NAME"), 0)
        title = name.value.decode("utf-8", "replace") if name else (w.get_wm_name() or "")
        d.close()
        return title
    except Exception:
        return ""


def on_game_window(own_title="ChessBot"):
    """True if the focused window is ChessLocal (or our own panel)."""
    t = active_window_title()
    return GAME_TITLE in t or t == own_title


# ---------------------------------------------------------------- Stockfish
def _sf_assets():
    m = platform.machine().lower()
    if SYSTEM == "Windows":
        return ["stockfish-windows-x86-64-avx2.zip", "stockfish-windows-x86-64.zip"]
    if SYSTEM == "Darwin":
        if m in ("arm64", "aarch64"):
            return ["stockfish-macos-m1-apple-silicon.tar"]
        return ["stockfish-macos-x86-64-avx2.tar", "stockfish-macos-x86-64.tar"]
    return ["stockfish-ubuntu-x86-64-avx2.tar", "stockfish-ubuntu-x86-64.tar"]


def _installed():
    d = os.path.join(ENGINES, "stockfish")
    if not os.path.isdir(d):
        return []
    found = []
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        if name.startswith("stockfish") and os.path.isfile(p) and \
                (name.endswith(".exe") or "." not in name):
            found.append(p)
    return found


def _download(asset, log):
    log(f"Downloading Stockfish ({asset})...")
    data = urllib.request.urlopen(SF_RELEASE + asset, timeout=120).read()
    os.makedirs(ENGINES, exist_ok=True)
    if asset.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            z.extractall(ENGINES)
    else:
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            t.extractall(ENGINES, filter="data") if sys.version_info >= (3, 12) else t.extractall(ENGINES)
    for p in _installed():
        os.chmod(p, 0o755)


def _works(path):
    try:
        out = subprocess.run([path], input="uci\nquit\n", capture_output=True, text=True, timeout=10)
        return "uciok" in out.stdout
    except Exception:
        return False


def stockfish_path(log=print):
    """Bundled engine, else one on PATH, else download the right build."""
    for p in _installed():
        if _works(p):
            return p
    on_path = shutil.which("stockfish")
    if on_path and _works(on_path):
        return on_path
    for asset in _sf_assets():            # fast build first, generic fallback
        _download(asset, log)
        for p in _installed():
            if asset.split(".")[0] in os.path.basename(p) and _works(p):
                return p
    raise RuntimeError("Couldn't get a working Stockfish - install it and put it on PATH")

"""Screen vision: find a chessboard on screen and read the pieces on it.

Black-box only — works from pixels, knows nothing about the game's code.
Piece templates are learned from the starting position the first time you
lock, then cached in templates.npz so you can lock mid-game later.
"""
import os
import numpy as np
import mss
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_FILE = os.path.join(HERE, "templates.npz")
T = 32          # template side (pixels after resampling)
START_ROWS = ["rnbqkbnr", "pppppppp", "........", "........",
              "........", "........", "PPPPPPPP", "RNBQKBNR"]


def grab(region=None):
    """Screenshot as an RGB uint8 array. region = (left, top, width, height)."""
    with mss.mss() as s:
        mon = s.monitors[0] if region is None else {
            "left": int(region[0]), "top": int(region[1]),
            "width": int(region[2]), "height": int(region[3])}
        img = np.asarray(s.grab(mon))[:, :, :3][:, :, ::-1]
        if img.shape[1] != mon["width"]:
            # macOS Retina: capture is 2x; scale to the points the mouse uses
            img = np.asarray(Image.fromarray(np.ascontiguousarray(img)).resize(
                (mon["width"], mon["height"]), Image.BOX))
        return np.ascontiguousarray(img), mon["left"], mon["top"]


# ---------------------------------------------------------------- board find
def _runs(mask_1d):
    """Contiguous True runs as (start, end_exclusive)."""
    m = np.concatenate([[False], mask_1d, [False]]).astype(np.int8)
    d = np.diff(m)
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def find_board(img):
    """Return (x, y, size) of the biggest 8x8 checkerboard in img, or None."""
    h, w, _ = img.shape
    q = (img // 8).astype(np.int32)
    key = (q[:, :, 0] << 10) | (q[:, :, 1] << 5) | q[:, :, 2]
    vals, counts = np.unique(key[::2, ::2], return_counts=True)
    top = vals[np.argsort(counts)[::-1][:10]]

    best = None
    for i in range(len(top)):
        for j in range(i + 1, len(top)):
            a, b = top[i], top[j]
            ma, mb = key == a, key == b
            cand = _board_from_pair(img, ma, mb)
            if cand and (best is None or cand[2] > best[2]):
                best = cand
    return best


def _board_from_pair(img, ma, mb):
    both = ma | mb
    rows = both.sum(1)
    cols = both.sum(0)
    if rows.max() < 80:
        return None
    rr = _runs(rows > rows.max() * 0.25)
    cc = _runs(cols > cols.max() * 0.25)
    if not rr or not cc:
        return None
    r0, r1 = max(rr, key=lambda r: r[1] - r[0])
    c0, c1 = max(cc, key=lambda r: r[1] - r[0])
    hgt, wid = r1 - r0, c1 - c0
    if hgt < 160 or abs(hgt - wid) > max(6, 0.04 * hgt):
        return None
    size = (hgt + wid) / 2
    if not _is_checker(ma, mb, c0, r0, size):
        return None
    return (int(c0), int(r0), int(round(size)))


def _is_checker(ma, mb, x, y, size):
    """Corners of every square should alternate between the two colours."""
    sq = size / 8
    ok = 0
    for r in range(8):
        for c in range(8):
            px = int(x + c * sq + sq * 0.08)
            py = int(y + r * sq + sq * 0.08)
            want = ma if (r + c) % 2 == 0 else mb
            other = mb if (r + c) % 2 == 0 else ma
            if want[py, px]:
                ok += 1
            elif other[py, px]:
                ok -= 1
    # allow a few highlighted squares (last move, selection)
    return abs(ok) >= 52


# ------------------------------------------------------------ square reading
def square_crops(img, size):
    sq = size / 8
    out = []
    for r in range(8):
        row = []
        for c in range(8):
            y0, x0 = int(r * sq), int(c * sq)
            row.append(img[y0:int((r + 1) * sq), x0:int((c + 1) * sq)])
        out.append(row)
    return out


def _resize(a, n):
    h, w = a.shape[:2]
    ys = (np.arange(n) * h / n + h / (2 * n)).astype(int)
    xs = (np.arange(n) * w / n + w / (2 * n)).astype(int)
    return a[ys][:, xs]


def features(crop):
    """(foreground fraction, feature vector) for one square.

    The piece is cut out from whatever the square colour is (normal, last-move
    highlight, check glow...) so only its shape + fill colour remain.
    """
    s = np.asarray(Image.fromarray(crop).resize((T, T), Image.BOX), dtype=np.float32)
    k = max(2, T // 10)
    corners = np.concatenate([s[:k, :k].reshape(-1, 3), s[:k, -k:].reshape(-1, 3),
                              s[-k:, :k].reshape(-1, 3), s[-k:, -k:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    diff = np.abs(s - bg).sum(2)
    m = max(1, T // 16)
    inner = np.zeros(diff.shape, bool)
    inner[m:-m, m:-m] = True
    fg = (diff > 70) & inner
    gray = s.mean(2)
    # shape channel (0/1) + fill channel (dark/bright) on the piece only
    shape = fg.astype(np.float32) * 255
    fill = np.where(fg, gray, 128.0)
    return fg.mean(), np.concatenate([shape.ravel() * 0.6, fill.ravel()])


EMPTY_FRAC = 0.09


def learn_templates(img, size, white_bottom):
    crops = square_crops(img, size)
    acc = {}
    for r in range(8):
        for c in range(8):
            rr, cc = (r, c) if white_bottom else (7 - r, 7 - c)
            p = START_ROWS[rr][cc]
            if p == "." or features(crops[r][c])[0] < EMPTY_FRAC:
                continue          # piece already moved away from here
            acc.setdefault(p, []).append(features(crops[r][c])[1])
    tpl = {p: np.median(v, axis=0) for p, v in acc.items()}
    np.savez(TEMPLATE_FILE, **tpl)
    return tpl


def load_templates():
    if not os.path.exists(TEMPLATE_FILE):
        return None
    d = np.load(TEMPLATE_FILE)
    return {k: d[k] for k in d.files}


def read_grid(img, size, tpl):
    """8x8 list of piece letters ('.' empty) in SCREEN orientation."""
    crops = square_crops(img, size)
    names = list(tpl)
    mat = np.stack([tpl[n] for n in names])
    grid = []
    for r in range(8):
        row = []
        for c in range(8):
            frac, v = features(crops[r][c])
            if frac < EMPTY_FRAC:
                row.append(".")
                continue
            d = ((mat - v) ** 2).mean(1)
            row.append(names[int(np.argmin(d))])
        grid.append(row)
    return grid


def looks_like_start(img, size):
    """True if the board is at (or within a few moves of) the initial setup."""
    crops = square_crops(img, size)
    occ = [[features(crops[r][c])[0] >= EMPTY_FRAC for c in range(8)] for r in range(8)]
    home = sum(occ[r][c] for r in (0, 1, 6, 7) for c in range(8))
    middle = sum(occ[r][c] for r in range(2, 6) for c in range(8))
    return home >= 28 and middle <= 4


def bottom_is_white(img, size):
    """Bright pieces near the bottom -> white plays from the bottom."""
    crops = square_crops(img, size)

    def bright(r):
        vals = []
        for c in range(8):
            s = np.asarray(Image.fromarray(crops[r][c]).resize((T, T), Image.BOX), dtype=np.float32)
            mid = s[T // 3: 2 * T // 3, T // 3: 2 * T // 3].mean(2)
            vals.append(mid.mean())
        return np.mean(vals)
    return bright(7) + bright(6) > bright(0) + bright(1)


def grid_to_board_rows(grid, white_bottom):
    """Screen grid -> rows from rank 8 down to rank 1 (FEN order)."""
    if white_bottom:
        return ["".join(r) for r in grid]
    return ["".join(reversed(r)) for r in reversed(grid)]


def square_center(sq_index, board, white_bottom):
    """Screen pixel centre of a python-chess square index. board=(x,y,size)."""
    x, y, size = board
    f, rk = sq_index % 8, sq_index // 8
    col, row = (f, 7 - rk) if white_bottom else (7 - f, rk)
    s = size / 8
    return x + col * s + s / 2, y + row * s + s / 2

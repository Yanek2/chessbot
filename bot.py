"""Game controller: watches the locked board, keeps track of the game and
plays our side with human-ish timing. Screen I/O is passed in (`io`), so the
same logic runs against the real desktop or a headless test browser.

io must provide:
    grab_full() -> (rgb array, offset_x, offset_y)
    grab(region) -> rgb array of region (x, y, w, h) in screen coords
    move_to(x, y, duration), click(x, y), drag(x0, y0, x1, y1)
"""
import os
import random
import threading
import time
import chess

import vision
from brain import Brain

SPEEDS = {"Fast": 0.45, "Normal": 1.0, "Slow": 1.7, "Mixed": None}   # Mixed: varies per move


class Bot:
    def __init__(self, io, status=print):
        self.io = io
        self.status = status          # callback(text)
        self.region = None            # (x, y, size) screen coords
        self.tpl = None
        self.white_bottom = True
        self.board = None
        self.playing = False
        self.style = "Mixed"
        self.speed = "Normal"
        self.brain = None
        self._thread = None
        self._stop = threading.Event()
        self.last_rows = None

    # ---------------------------------------------------------------- lock
    def lock(self):
        img, ox, oy = self.io.grab_full()
        found = vision.find_board(img)
        if not found:
            self.status("No board found on screen")
            return False
        x, y, size = found
        crop = img[y:y + size, x:x + size]
        self.region = (x + ox, y + oy, size)
        self.white_bottom = vision.bottom_is_white(crop, size)
        if vision.looks_like_start(crop, size):
            self.tpl = vision.learn_templates(crop, size, self.white_bottom)
            learned = "learned pieces"
        else:
            self.tpl = vision.load_templates()
            if self.tpl is None:
                self.status("Locked board, but lock once on a NEW game first so I can learn the pieces")
                self.region = None
                return False
            learned = "cached pieces"
        rows = self.read_rows()
        self.board = None
        self._sync(rows, prev=None)
        side = "White" if self.white_bottom else "Black"
        self.status(f"Locked {size}px board ({learned}) - you are {side}")
        return True

    @property
    def my_color(self):
        return chess.WHITE if self.white_bottom else chess.BLACK

    def read_rows(self):
        x, y, size = self.region
        img = self.io.grab((x, y, size, size))
        grid = vision.read_grid(img, size, self.tpl)
        return vision.grid_to_board_rows(grid, self.white_bottom)

    # -------------------------------------------------------- game tracking
    @staticmethod
    def rows_of(board):
        rows = []
        for r in range(7, -1, -1):
            s = ""
            for f in range(8):
                p = board.piece_at(chess.square(f, r))
                s += p.symbol() if p else "."
            rows.append(s)
        return rows

    def _sync(self, rows, prev):
        """Rebuild the game from what's on screen."""
        b = chess.Board(None)
        for i, row in enumerate(rows):
            for f, ch in enumerate(row):
                if ch != ".":
                    b.set_piece_at(chess.square(f, 7 - i), chess.Piece.from_symbol(ch))
        if rows == vision.START_ROWS:
            turn = chess.WHITE
        elif prev is not None:
            # whoever's pieces just landed on new squares moved last
            moved = [rows[r][f] for r in range(8) for f in range(8)
                     if rows[r][f] != "." and rows[r][f] != prev[r][f]]
            if moved:
                turn = chess.BLACK if moved[0].isupper() else chess.WHITE
            else:
                turn = self.my_color
        else:
            turn = self.my_color
        b.turn = turn
        cr = ""
        if b.piece_at(chess.E1) == chess.Piece.from_symbol("K"):
            if b.piece_at(chess.H1) == chess.Piece.from_symbol("R"): cr += "K"
            if b.piece_at(chess.A1) == chess.Piece.from_symbol("R"): cr += "Q"
        if b.piece_at(chess.E8) == chess.Piece.from_symbol("k"):
            if b.piece_at(chess.H8) == chess.Piece.from_symbol("r"): cr += "k"
            if b.piece_at(chess.A8) == chess.Piece.from_symbol("r"): cr += "q"
        b.set_castling_fen(cr or "-")
        if not b.is_valid():
            b.clear_stack()
        self.board = b

    def _advance(self, rows):
        """Update self.board to match rows. Returns True if understood."""
        b = self.board
        for m in b.legal_moves:
            b.push(m)
            if self.rows_of(b) == rows:
                return True
            b.pop()
        for m in list(b.legal_moves):        # missed a move pair?
            b.push(m)
            for m2 in b.legal_moves:
                b.push(m2)
                if self.rows_of(b) == rows:
                    return True
                b.pop()
            b.pop()
        return False

    def stable_read(self, n=3, gap=0.12):
        """Same reading n times in a row (skips piece animations)."""
        first = self.read_rows()
        for _ in range(n - 1):
            time.sleep(gap)
            if self.read_rows() != first:
                return None
        return first

    @staticmethod
    def plausible(rows):
        """Could this be a real chess position? (rejects popups/overlays)"""
        s = "".join(rows)
        if s.count("K") != 1 or s.count("k") != 1:
            return False
        if sum(c.isupper() for c in s) > 16 or sum(c.islower() for c in s) > 16:
            return False
        if s.count("P") > 8 or s.count("p") > 8:
            return False
        return not any(c in "Pp" for c in rows[0] + rows[7])

    def observe(self):
        rows = self.stable_read()
        if rows is None or rows == self.rows_of(self.board):
            return
        prev = self.rows_of(self.board)
        if rows == vision.START_ROWS:
            self._sync(rows, None)
            self.status("New game detected")
            return
        if not self.plausible(rows):
            self.status("Board covered (popup?) - waiting")
            return
        if not self._advance(rows):
            # make sure it's not a half-finished animation before trusting it
            time.sleep(0.4)
            if self.stable_read(n=4) != rows:
                return
            if os.environ.get("CHESSBOT_DEBUG"):
                from PIL import Image
                x, y, size = self.region
                Image.fromarray(self.io.grab((x, y, size, size))).save(f"{os.environ['CHESSBOT_DEBUG']}/resync_{time.time():.0f}.png")
                print("RESYNC prev", prev, "\n       now ", rows, flush=True)
            self._sync(rows, prev)
            self.status("Re-synced position from screen")

    # -------------------------------------------------------------- playing
    def start(self):
        if self.region is None or self.playing:
            return
        self.playing = True
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self.playing = False
        self._stop.set()

    def _run(self):
        try:
            if self.brain is None:
                self.brain = Brain(self.style)
            self.status("Playing...")
            while not self._stop.is_set():
                self.brain.style = self.style
                self.observe()
                if self.board.is_game_over():
                    self.status(f"Game over ({self.board.result()}) - start a new game, I'll keep going")
                    self._stop.wait(1.0)
                    continue
                if self.board.turn == self.my_color:
                    self._play_one()
                else:
                    self._stop.wait(0.25)
        except Exception as e:  # keep the overlay alive
            self.status(f"Error: {e}")
            self.playing = False

    def _human_delay(self, board, move, eval_text):
        mult = SPEEDS.get(self.speed, 1.0)
        if mult is None:
            # Mixed: some quick moves, some normal, some long thinks;
            # sharp positions (where we dodged the engine move) get the long ones
            if "human move" in eval_text or "forced" in eval_text:
                mult = random.uniform(1.3, 2.2)
            else:
                mult = random.choices([random.uniform(0.35, 0.6), random.uniform(0.8, 1.2),
                                       random.uniform(1.4, 2.0)], weights=[35, 45, 20])[0]
        n = board.fullmove_number
        if len(list(board.legal_moves)) == 1:
            base = random.uniform(0.6, 1.2)
        elif n <= 6:
            base = random.uniform(0.8, 2.2)
        elif board.is_capture(move) and board.move_stack and \
                board.move_stack[-1].to_square == move.to_square:
            base = random.uniform(0.9, 2.0)            # obvious recapture
        else:
            base = min(12.0, random.lognormvariate(1.15, 0.5))   # ~3s typical
        return base * mult

    def _play_one(self):
        board = self.board.copy()
        t0 = time.time()
        self.brain.think = 0.4 if self.speed == "Fast" else 0.8
        move, info = self.brain.choose(board)
        wait = self._human_delay(board, move, info) - (time.time() - t0)
        self.status(f"Thinking... {board.san(move)}  ({info})")
        if self._stop.wait(max(0.0, wait)):
            return
        # board changed meanwhile (user moved / undo)? start over
        if self.stable_read() != self.rows_of(board):
            return
        san = board.san(move)
        target = board.copy()
        target.push(move)
        want = self.rows_of(target)

        fx, fy = vision.square_center(move.from_square, self.region, self.white_bottom)
        tx, ty = vision.square_center(move.to_square, self.region, self.white_bottom)
        j = self.region[2] / 8 * 0.15
        jit = lambda: random.uniform(-j, j)
        fx, fy, tx, ty = fx + jit(), fy + jit(), tx + jit(), ty + jit()

        for attempt in ("click", "drag"):
            if attempt == "click":
                self.io.move_to(fx, fy, random.uniform(0.18, 0.4))
                self.io.click(fx, fy)
                time.sleep(random.uniform(0.08, 0.2))
                self.io.move_to(tx, ty, random.uniform(0.15, 0.35))
                self.io.click(tx, ty)
            else:
                self.io.drag(fx, fy, tx, ty)
            if self._landed(want, move):
                self.board = target
                self.status(f"Played {san}  ({info})")
                return
            self.io.click(fx, fy)       # clear any half-selection
            if self.stable_read() == self.rows_of(board):
                self.io.click(fx, fy)
        self.status(f"Couldn't play {san} - re-reading board")
        time.sleep(1)

    def _landed(self, want, move):
        deadline = time.time() + 2.0
        promo_clicked = False
        while time.time() < deadline:
            rows = self.stable_read()
            if rows == want:
                return True
            if rows is not None and not self.plausible(rows):
                return True        # game-over popup right after our move
            if rows is not None and move.promotion and not promo_clicked:
                # promotion picker: queen usually sits on the target square
                time.sleep(0.3)
                tx, ty = vision.square_center(move.to_square, self.region, self.white_bottom)
                self.io.click(tx, ty)
                promo_clicked = True
                continue
            if rows is not None and rows != self.rows_of(self.board) and self._matches_after(rows, move):
                return True
        return False

    def _matches_after(self, rows, move):
        """Our move landed and the opponent already replied (fast bots)."""
        b = self.board.copy()
        b.push(move)
        for m in b.legal_moves:
            b.push(m)
            if self.rows_of(b) == rows:
                return True
            b.pop()
        return False

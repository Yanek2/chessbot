"""Move choice: Stockfish's candidate list blended with 'Spark', a small
attacking-style engine written here, so the bot doesn't just play the
Stockfish top move every time.

How the mix works
  1. Stockfish (MultiPV) proposes the top candidates with centipawn scores.
  2. Spark searches each candidate itself (alpha-beta + quiescence, own
     evaluation that loves king attacks, activity and initiative).
  3. Each candidate gets   stockfish_score + style_weight * spark_opinion
     and only moves within `margin` of Stockfish's best are allowed, so the
     blend can't throw the game away.
"""
import math
import os
import random
import chess
import chess.engine

HERE = os.path.dirname(os.path.abspath(__file__))
SF_PATH = os.path.join(HERE, "engines", "stockfish", "stockfish-ubuntu-x86-64-avx2")

#            margin cp, spark weight, randomness (softmax temp), multipv
STYLES = {
    "Solid":      dict(margin=15, weight=0.15, temp=0,  multipv=3),
    "Mixed":      dict(margin=40, weight=0.45, temp=8,  multipv=5),
    "Aggressive": dict(margin=60, weight=0.80, temp=10, multipv=6),
    "Human":      dict(margin=90, weight=0.50, temp=25, multipv=6),
}

# ------------------------------------------------------------------- Spark
VAL = {chess.PAWN: 100, chess.KNIGHT: 320, chess.BISHOP: 335,
       chess.ROOK: 500, chess.QUEEN: 920, chess.KING: 0}
CENTER = [0, 1, 2, 3, 3, 2, 1, 0]


def _pst(piece, sq):
    f, r = chess.square_file(sq), chess.square_rank(sq)
    if piece.color == chess.BLACK:
        r = 7 - r
    c = CENTER[f] + CENTER[r]
    t = piece.piece_type
    if t == chess.PAWN:
        return r * 6 + (8 if f in (3, 4) and r >= 3 else 0)
    if t == chess.KNIGHT:
        return c * 8 - 20
    if t == chess.BISHOP:
        return c * 4 + (6 if r > 0 else -8)
    if t == chess.ROOK:
        return (18 if r == 6 else 0) + CENTER[f]
    if t == chess.QUEEN:
        return c * 2
    return 0


def spark_eval(b):
    """Static eval from side-to-move's view. Attack-happy on purpose."""
    if b.is_checkmate():
        return -100000
    if b.is_stalemate() or b.is_insufficient_material():
        return 0
    score = 0
    phase = 0
    for sq, p in b.piece_map().items():
        s = VAL[p.piece_type] + _pst(p, sq)
        phase += {1: 0, 2: 1, 3: 1, 4: 2, 5: 4, 6: 0}[p.piece_type]
        score += s if p.color == chess.WHITE else -s
    # king safety / king attack: enemy attacks on squares around each king
    for color in (chess.WHITE, chess.BLACK):
        k = b.king(color)
        if k is None:
            continue
        zone = chess.SquareSet(chess.BB_KING_ATTACKS[k]) | chess.SquareSet.from_square(k)
        attacks = sum(len(b.attackers(not color, s)) for s in zone)
        pen = attacks * attacks * 3 * min(phase, 24) // 24
        # castled / tucked king bonus in the middlegame
        kf = chess.square_file(k)
        if phase > 12 and kf in (0, 1, 2, 6, 7):
            pen -= 25
        score += -pen if color == chess.WHITE else pen
    # mobility (cheap: pseudo-legal count for side to move vs. other)
    mob = b.pseudo_legal_moves.count()
    b.push(chess.Move.null())
    mob_o = b.pseudo_legal_moves.count()
    b.pop()
    s2m = 1 if b.turn == chess.WHITE else -1
    return score * s2m + (mob - mob_o) * 3 + 10   # +10 tempo


def _order(b, moves):
    def key(m):
        k = 0
        if b.is_capture(m):
            victim = b.piece_at(m.to_square)
            k += 10 * (VAL[victim.piece_type] if victim else 100) - VAL[b.piece_at(m.from_square).piece_type] // 10
        if m.promotion:
            k += 900
        if b.gives_check(m):
            k += 300
        return -k
    return sorted(moves, key=key)


def _qs(b, alpha, beta, depth=0):
    stand = spark_eval(b)
    if stand >= beta or depth > 6:
        return stand
    alpha = max(alpha, stand)
    for m in _order(b, [m for m in b.legal_moves if b.is_capture(m) or m.promotion]):
        b.push(m)
        v = -_qs(b, -beta, -alpha, depth + 1)
        b.pop()
        if v >= beta:
            return v
        alpha = max(alpha, v)
    return alpha


def _ab(b, depth, alpha, beta):
    if b.is_game_over():
        return spark_eval(b)
    if depth == 0:
        return _qs(b, alpha, beta)
    best = -math.inf
    for m in _order(b, list(b.legal_moves)):
        b.push(m)
        v = -_ab(b, depth - 1, -beta, -alpha)
        b.pop()
        best = max(best, v)
        alpha = max(alpha, v)
        if alpha >= beta:
            break
    return best


def spark_opinion(board, move, depth=2):
    """Spark's score (cp, mover's view) after playing `move`."""
    b = board.copy(stack=False)
    b.push(move)
    return -_ab(b, depth - 1, -math.inf, math.inf)


def style_bonus(board, move):
    """Small flavour: checks, captures, pushing pieces toward the enemy king."""
    bonus = 0
    if board.gives_check(move):
        bonus += 12
    if board.is_capture(move):
        bonus += 6
    ek = board.king(not board.turn)
    if ek is not None:
        before = chess.square_distance(move.from_square, ek)
        after = chess.square_distance(move.to_square, ek)
        bonus += (before - after) * 3
    return bonus


# ------------------------------------------------------------------ Brain
class Brain:
    def __init__(self, style="Mixed", think=1.0, log=print):
        self.style = style
        self.think = think          # stockfish seconds per move
        self.log = log
        self.sf = chess.engine.SimpleEngine.popen_uci(SF_PATH)
        self.sf.configure({"Threads": max(1, (os.cpu_count() or 2) // 2), "Hash": 128})

    def close(self):
        try:
            self.sf.quit()
        except Exception:
            pass

    def choose(self, board):
        """Return (move, info_text)."""
        cfg = STYLES[self.style]
        legal = list(board.legal_moves)
        if len(legal) == 1:
            return legal[0], "only move"
        n = min(max(cfg["multipv"], 6), len(legal))
        deep = self._cands(board, chess.engine.Limit(time=self.think), n)
        best_mv, best_cp = deep[0]

        # --- sharp / deeply calculated position? avoid the engine-only move
        sharp, why = self._is_sharp(board, deep)
        if sharp:
            alt = self._human_alternative(board, deep, cfg)
            if alt:
                m, cp = alt
                return m, f"human move, {why} {self._fmt(cp)}"
            why = why + ", no safe way out"

        if best_cp >= 5000:
            return best_mv, f"SF {self._fmt(best_cp)}"
        allowed = [(m, cp) for m, cp in deep[:cfg["multipv"]] if cp >= best_cp - cfg["margin"]]
        pick = self._blend(board, allowed, cfg)
        tag = "SF+Spark" if pick[0] != best_mv else "SF"
        if sharp:
            tag = f"forced: {why}"
        return pick[0], f"{tag} {self._fmt(pick[1])}"

    # ------------------------------------------------------------ helpers
    def _cands(self, board, limit, n):
        infos = self.sf.analyse(board, limit, multipv=n)
        out = []
        for inf in infos:
            if "pv" in inf:
                out.append((inf["pv"][0], inf["score"].pov(board.turn).score(mate_score=100000)))
        return out

    def _is_sharp(self, board, deep):
        """Is the top move something only an engine would find?"""
        best_mv, best_cp = deep[0]
        shallow = self._cands(board, chess.engine.Limit(depth=5), min(6, len(deep) + 2))
        sh_rank = {m: i for i, (m, _) in enumerate(shallow)}
        sh_score = dict(shallow)
        reasons = []
        gap = deep[0][1] - deep[1][1] if len(deep) > 1 else 0
        # 1. best move is invisible / looks bad at low depth = deep calculation
        if gap < 50:
            pass                      # several moves are fine: nothing sharp
        elif best_mv not in sh_rank or sh_rank[best_mv] >= 2:
            reasons.append("deep line")
        elif shallow[0][1] - sh_score[best_mv] >= 80:
            reasons.append("deep line")
        # 2. sacrifice: gives up material that isn't immediately won back
        if self._is_sacrifice(board, best_mv):
            reasons.append("sacrifice")
        # 3. tactical knife-edge: only one move holds, the rest drop a lot
        if len(deep) > 1 and deep[0][1] - deep[1][1] >= 150 and abs(best_cp) < 5000:
            reasons.append("only-move tactic")
        # 4. long forced mate a human wouldn't see
        if best_cp >= 5000:
            mate = self._mate_len(board)
            if mate is not None and mate > 3:
                reasons.append(f"mate in {mate}")
            else:
                reasons = []          # short mates: any human sees them
        return bool(reasons), "/".join(reasons)

    def _mate_len(self, board):
        info = self.sf.analyse(board, chess.engine.Limit(time=0.1))
        m = info["score"].pov(board.turn).mate()
        return m

    @staticmethod
    def _is_sacrifice(board, move):
        piece = board.piece_at(move.from_square)
        if piece is None or piece.piece_type in (chess.PAWN, chess.KING):
            return False
        gained = 0
        if board.is_capture(move):
            victim = board.piece_at(move.to_square)
            gained = VAL[victim.piece_type] if victim else 100
        b = board.copy(stack=False)
        b.push(move)
        if not b.is_attacked_by(b.turn, move.to_square):
            return False
        defended = b.is_attacked_by(not b.turn, move.to_square)
        cheapest = min((VAL[b.piece_at(s).piece_type] for s in b.attackers(b.turn, move.to_square)), default=0)
        loss = VAL[piece.piece_type] if not defended else max(0, VAL[piece.piece_type] - cheapest)
        return loss - gained >= 200

    def _human_alternative(self, board, deep, cfg):
        """Best natural-looking move that still doesn't lose. None = no way out."""
        best_cp = deep[0][1]
        drop = {"Solid": 80, "Mixed": 130, "Aggressive": 150, "Human": 200}[self.style]
        ok = []
        for m, cp in deep[1:]:
            if best_cp >= 5000:
                good = cp >= 400                  # still clearly winning
            else:
                # a way out = a move that doesn't leave us losing
                good = cp >= -60 or cp >= best_cp - 40
                if self.style == "Solid":
                    good = good and cp >= best_cp - drop
            if good and not self._is_sacrifice(board, m):
                ok.append((m, cp))
        if not ok:
            return None
        return self._blend(board, ok, cfg)

    def _blend(self, board, allowed, cfg):
        if len(allowed) == 1:
            return allowed[0]
        sp_vals = [spark_opinion(board, m) for m, _ in allowed]
        sp_base = max(sp_vals)
        scored = []
        for (m, cp), sp in zip(allowed, sp_vals):
            sp_rel = max(-150, sp - sp_base)
            total = cp + cfg["weight"] * (sp_rel + style_bonus(board, m))
            scored.append((total, m, cp))
        scored.sort(key=lambda t: -t[0])
        if cfg["temp"] > 0:
            top = scored[0][0]
            ws = [math.exp((s - top) / cfg["temp"]) for s, _, _ in scored]
            pick = random.choices(scored, weights=ws)[0]
        else:
            pick = scored[0]
        return pick[1], pick[2]

    @staticmethod
    def _fmt(cp):
        if abs(cp) >= 5000:
            return "mate"
        return f"{cp / 100:+.2f}"

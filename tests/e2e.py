"""End-to-end: bot plays ChessLocal in headless Chrome. Usage: e2e.py [white|black] [seconds]
(needs ChessLocal on localhost:8080 and `pip install websocket-client`)"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cdp_io import CDP
import bot, osutil
osutil.on_game_window = lambda **k: True      # headless window has no focus; test only
side = sys.argv[1] if len(sys.argv) > 1 else "white"
c = CDP("http://localhost:8080")
if side == "black":
    c.click(1258, 407); time.sleep(0.3)
c.click(1128, 747); time.sleep(2)
b = bot.Bot(c, status=lambda s: print("[status]", s, flush=True))
b.speed = "Fast"
print("lock:", b.lock())
b.start()
t = time.time()
while time.time() - t < float(sys.argv[2] if len(sys.argv) > 2 else 60) and b.playing:
    time.sleep(1)
b.stop(); time.sleep(0.5)
print("moves:", len(b.board.move_stack), b.board.fen())
c.close()
if b.brain: b.brain.close()

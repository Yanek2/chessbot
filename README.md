# ChessBot

An always-on-top panel that plays **your own ChessLocal game** for you, by looking at the screen and moving the mouse. It never reads the game's code.

It only plays on a window titled **ChessLocal**. Before locking and before every move it checks the active window, and if it's anything else it pauses.

## Setup

Needs Python 3.10+ (python.org builds include Tk; on Homebrew run `brew install python-tk`).

| OS | Start |
|---|---|
| Windows | double-click `run.bat` |
| macOS | double-click `run.command` (first time: right-click → Open) |
| Linux | `./run.sh` |

The first run creates `.venv`, installs the requirements and downloads the right Stockfish 17.1 build into `engines/`. The launcher serves the bundled game (`game/`) at http://localhost:8080 and opens it.

**macOS permissions:** System Settings → Privacy & Security → allow your terminal/Python under **Screen Recording** (to see the board) and **Accessibility** (to move the mouse, use hotkeys and read the window title).

## Use

1. Start a new game in ChessLocal.
2. **Lock** (F9): finds the board and learns the pieces (green outline).
3. **Play / Pause** (F8).

**Style**
- Solid
- Mixed
- Aggressive
- Human

All styles blend Stockfish's candidate moves with *Spark*, a small built-in attacking engine. In sharp positions (sacrifices, deep lines, long mates) it plays a natural non-losing move instead of the engine-only one, unless every other move loses.

**Speed**
- Fast
- Normal
- Mixed (different every move)
- Slow

While it plays it controls your mouse, so press F8 before using the computer.

## Files
- `vision.py` – board detection + piece reading
- `brain.py` – Stockfish + Spark blend
- `bot.py` – game tracking and moves
- `app.py` – the panel
- `osutil.py` – per-OS bits
- `launch.py` – starter
- `tests/` – headless-Chrome end-to-end test

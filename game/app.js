import { Chess, DEFAULT_POSITION } from './vendor/chess.js';
import { openingName, OPENINGS } from './openings.js';

const $ = (s, r = document) => r.querySelector(s);
const FILES = 'abcdefgh';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// ───────────────────────── settings ─────────────────────────
const settings = Object.assign(
  { theme: 'green', sound: true, legal: true, coords: true, evalPlay: false, autoQ: false, anim: 200 },
  load('cl.settings', {}));

function applySettings() {
  document.body.className = `theme-${settings.theme}` + (settings.coords ? '' : ' no-coords');
  save('cl.settings', settings);
}

// ───────────────────────── sounds (synthesised) ─────────────────────────
let actx, noise;
function ac() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    noise = actx.createBuffer(1, actx.sampleRate * 0.2, actx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function knock(t, f = 1100, vol = 0.55, len = 0.06) {
  const a = ac();
  const src = a.createBufferSource(); src.buffer = noise;
  const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 1.6;
  const g = a.createGain();
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
  src.connect(bp).connect(g).connect(a.destination); src.start(t); src.stop(t + len + 0.02);
  const o = a.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f * 0.19, t); o.frequency.exponentialRampToValueAtTime(f * 0.1, t + len);
  const og = a.createGain();
  og.gain.setValueAtTime(vol * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + len * 1.4);
  o.connect(og).connect(a.destination); o.start(t); o.stop(t + len * 1.5);
}
function tone(t, f, len, vol = 0.12, type = 'sine') {
  const a = ac();
  const o = a.createOscillator(); o.type = type; o.frequency.value = f;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + len + 0.02);
}
const SFX = {
  move: t => knock(t),
  capture: t => { knock(t, 1700, 0.7, 0.05); knock(t + 0.04, 900, 0.55); },
  castle: t => { knock(t); knock(t + 0.1, 950); },
  check: t => { knock(t); tone(t + 0.02, 1046, 0.18, 0.1, 'triangle'); },
  promote: t => { knock(t); tone(t + 0.03, 784, 0.12); tone(t + 0.12, 1175, 0.2); },
  start: t => { tone(t, 523, 0.25); tone(t + 0.1, 659, 0.25); tone(t + 0.2, 784, 0.4); },
  end: t => { tone(t, 784, 0.25); tone(t + 0.12, 659, 0.25); tone(t + 0.24, 523, 0.5); },
  illegal: t => tone(t, 160, 0.15, 0.08, 'square'),
  notify: t => { tone(t, 880, 0.12); tone(t + 0.1, 660, 0.18); },
};
function sfx(name) { if (!settings.sound) return; try { SFX[name](ac().currentTime + 0.005); } catch {} }

// ───────────────────────── engine (Stockfish in a worker) ─────────────────────────
class Engine {
  constructor() {
    this.w = new Worker('vendor/stockfish-19-lite-single.js');
    this.subs = new Set();
    this.w.onmessage = e => { const l = String(e.data); for (const f of [...this.subs]) f(l); };
    this.chain = Promise.resolve();
    this.opts = {};
    this.epoch = 0;
    this.ready = (async () => {
      const ok = this.wait(l => l === 'uciok'); this.send('uci'); await ok;
      const rd = this.wait(l => l === 'readyok'); this.send('isready'); await rd;
    })();
  }
  send(c) { this.w.postMessage(c); }
  wait(pred) {
    return new Promise(res => {
      const f = l => { if (pred(l)) { this.subs.delete(f); res(l); } };
      this.subs.add(f);
    });
  }
  setOptions(o) {
    for (const [k, v] of Object.entries(o)) {
      if (this.opts[k] !== String(v)) { this.send(`setoption name ${k} value ${v}`); this.opts[k] = String(v); }
    }
  }
  cancel() { this.epoch++; this.send('stop'); }
  // Resolves with { bestmove, lines, depth } or null if cancelled before starting.
  search(fen, { go = 'depth 12', multipv = 1, options = {}, onInfo } = {}) {
    const ep = this.epoch;
    const job = this.chain.then(async () => {
      await this.ready;
      if (ep !== this.epoch) return null;
      this.setOptions({ ...options, MultiPV: multipv });
      const turn = fen.split(' ')[1];
      const lines = []; let depth = 0;
      const f = l => {
        if (!l.startsWith('info ') || !l.includes(' pv ') || l.includes('bound')) return;
        const info = parseInfo(l, turn); if (!info) return;
        lines[info.multipv - 1] = info; depth = info.depth;
        onInfo && ep === this.epoch && onInfo(lines.filter(Boolean), depth);
      };
      this.subs.add(f);
      const bm = this.wait(l => l.startsWith('bestmove'));
      this.send('position fen ' + fen);
      this.send('go ' + go);
      const line = await bm;
      this.subs.delete(f);
      return { bestmove: line.split(' ')[1], lines: lines.filter(Boolean), depth };
    });
    this.chain = job.catch(() => {});
    return job;
  }
}
// Score is converted to White's point of view.
function parseInfo(l, turn) {
  const t = l.split(' ');
  const get = k => { const i = t.indexOf(k); return i >= 0 ? t[i + 1] : null; };
  const si = t.indexOf('score'); if (si < 0) return null;
  const sgn = turn === 'w' ? 1 : -1;
  const kind = t[si + 1], val = +t[si + 2];
  const pvi = t.indexOf('pv');
  return {
    depth: +get('depth'), multipv: +(get('multipv') || 1),
    cp: kind === 'cp' ? val * sgn : null, mate: kind === 'mate' ? val * sgn : null,
    pv: t.slice(pvi + 1),
  };
}
const scoreNum = s => s.mate != null ? (s.mate > 0 ? 10000 - s.mate * 10 : -10000 - s.mate * 10) : s.cp;
const winChance = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
// Finished positions: checkmate is stored as a huge cp value.
const terminalEval = pc => ({ cp: pc.isCheckmate() ? (pc.turn() === 'w' ? -100000 : 100000) : 0, mate: null, pv: [] });
function scoreText(s, signed = true) {
  if (Math.abs(s.cp) >= 100000) return s.cp > 0 ? '1-0' : '0-1';
  if (s.mate != null) return (s.mate > 0 ? '' : '-') + 'M' + Math.abs(s.mate);
  const v = (s.cp / 100).toFixed(Math.abs(s.cp) >= 1000 ? 0 : (Math.abs(s.cp) >= 100 ? 1 : 2));
  return signed && s.cp > 0 ? '+' + v : v;
}

const botEngine = new Engine();
const anaEngine = new Engine();

// ───────────────────────── bots & time controls ─────────────────────────
const BOTS = [
  { id: 'pip', name: 'Pip', elo: 250, glyph: 'wP', color: '#8bc34a', hi: "Hi! I just learned how the horsey moves. Go easy on me!", cfg: { skill: 0, depth: 1, blunder: 0.5 } },
  { id: 'mila', name: 'Mila', elo: 400, glyph: 'bP', color: '#4db6ac', hi: "I play chess with my grandpa every Sunday.", cfg: { skill: 0, depth: 1, blunder: 0.35 } },
  { id: 'otto', name: 'Otto', elo: 600, glyph: 'wN', color: '#ffb74d', hi: "Knights are my favorite. Watch out for forks!", cfg: { skill: 0, depth: 2, blunder: 0.22 } },
  { id: 'luna', name: 'Luna', elo: 800, glyph: 'bN', color: '#9575cd', hi: "I'm in the school chess club. Let's have fun!", cfg: { skill: 1, depth: 3, blunder: 0.14 } },
  { id: 'theo', name: 'Theo', elo: 1000, glyph: 'wB', color: '#64b5f6', hi: "I know a few openings. Let's see what you've got.", cfg: { skill: 3, depth: 4, blunder: 0.08 } },
  { id: 'ines', name: 'Ines', elo: 1200, glyph: 'bB', color: '#f06292', hi: "Club player here. I don't give pieces away for free.", cfg: { skill: 5, depth: 6, blunder: 0.04 } },
  { id: 'rook', name: 'Rocco', elo: 1500, glyph: 'wR', color: '#a1887f', hi: "Solid and patient. Make one slip and I'll take it.", cfg: { elo: 1500 } },
  { id: 'vera', name: 'Vera', elo: 1800, glyph: 'bR', color: '#e57373', hi: "Tournament player. I hope you've studied your endgames.", cfg: { elo: 1800 } },
  { id: 'kasp', name: 'Viktor', elo: 2200, glyph: 'wQ', color: '#7986cb', hi: "Master level. Every move counts.", cfg: { elo: 2200 } },
  { id: 'fish', name: 'Stockfish', elo: 3200, glyph: 'bK', color: '#455a64', hi: "Maximum strength. Good luck — you'll need it.", cfg: { full: true } },
];
const TCS = [
  { id: 'none', label: 'No timer', sub: 'Casual', base: 0, inc: 0 },
  { id: '1', label: '1 min', sub: 'Bullet', base: 60, inc: 0 },
  { id: '2+1', label: '2 | 1', sub: 'Bullet', base: 120, inc: 1 },
  { id: '3+2', label: '3 | 2', sub: 'Blitz', base: 180, inc: 2 },
  { id: '5', label: '5 min', sub: 'Blitz', base: 300, inc: 0 },
  { id: '10', label: '10 min', sub: 'Rapid', base: 600, inc: 0 },
  { id: '15+10', label: '15 | 10', sub: 'Rapid', base: 900, inc: 10 },
  { id: '30', label: '30 min', sub: 'Classical', base: 1800, inc: 0 },
  { id: '60', label: '60 min', sub: 'Classical', base: 3600, inc: 0 },
];
const avatarStyle = (glyph, color) => `background-color:${color};background-image:url(pieces/${glyph}.svg)`;
const YOU = { name: 'You', glyph: 'wK', color: '#7f7c78' };

const CLS = {
  book: { c: '#a88865', i: '≡', t: 'Book' },
  best: { c: '#81b64c', i: '★', t: 'Best' },
  excellent: { c: '#96bc4b', i: '!', t: 'Excellent' },
  good: { c: '#77915f', i: '✓', t: 'Good' },
  inaccuracy: { c: '#f7c631', i: '?!', t: 'Inaccuracy' },
  mistake: { c: '#ffa459', i: '?', t: 'Mistake' },
  miss: { c: '#ff7769', i: '✕', t: 'Miss' },
  blunder: { c: '#fa412d', i: '??', t: 'Blunder' },
};

// ───────────────────────── state ─────────────────────────
const prefs = load('cl.prefs', { botId: 'rook', color: 'w', tcBot: 'none', tcFriend: '10' });
const S = {
  mode: 'bot',            // bot | friend | analysis
  phase: 'setup',         // setup | play | over | review | analysis
  bot: BOTS.find(b => b.id === prefs.botId) || BOTS[6],
  colorChoice: prefs.color,
  tcBot: prefs.tcBot, tcFriend: prefs.tcFriend,
  playerColor: 'w',
  tc: TCS[0],
  startFen: DEFAULT_POSITION,
  history: [], ply: 0,
  flipped: false,
  clocks: { w: 0, b: 0 }, clockStarted: false, lastTick: 0,
  result: null, review: null,
  selected: null, legal: [], hover: null,
  arrows: [], marks: new Set(), hint: null,
  ana: { lines: [], depth: 0 }, anaToken: 0,
  thinking: false, gameId: 0, botScore: 0,
  botSay: '', confirm: null,
};
let game = new Chess();

const fenAt = p => p === 0 ? S.startFen : S.history[p - 1].after;
const live = () => S.ply === S.history.length;
const tcById = id => TCS.find(t => t.id === id) || TCS[0];

// ───────────────────────── board geometry ─────────────────────────
const boardEl = $('#board');
function sqColRow(sq) {
  const f = sq.charCodeAt(0) - 97, r = +sq[1];
  return S.flipped ? [7 - f, r - 1] : [f, 8 - r];
}
const sqT = sq => { const [c, r] = sqColRow(sq); return `translate(${c * 100}%, ${r * 100}%)`; };
function sqFromPoint(x, y) {
  const rect = boardEl.getBoundingClientRect();
  const c = Math.floor((x - rect.left) / rect.width * 8), r = Math.floor((y - rect.top) / rect.height * 8);
  if (c < 0 || c > 7 || r < 0 || r > 7) return null;
  return S.flipped ? FILES[7 - c] + (r + 1) : FILES[c] + (8 - r);
}
function fenMap(fen) {
  const m = {};
  fen.split(' ')[0].split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') f += +ch;
      else { m[FILES[f] + (8 - i)] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase(); f++; }
    }
  });
  return m;
}

function buildSquares() {
  const el = $('.squares', boardEl); el.innerHTML = '';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const file = S.flipped ? 7 - c : c, rank = S.flipped ? r + 1 : 8 - r;
    const d = document.createElement('div');
    d.className = 'sq ' + ((file + rank) % 2 === 0 ? 'l' : 'd');
    if (c === 0) d.innerHTML += `<span class="coord rank">${rank}</span>`;
    if (r === 7) d.innerHTML += `<span class="coord file">${FILES[file]}</span>`;
    el.appendChild(d);
  }
  $('.pieces', boardEl).innerHTML = '';
  pieceEls = {}; curMap = {};
}

// Pieces are diffed against the previous position so moves (forward, backward, castling) animate.
let pieceEls = {}, curMap = {};
function syncPieces(map, animate) {
  const layer = $('.pieces', boardEl);
  const dur = animate ? +settings.anim : 0;
  const next = {}, vanished = [], appeared = [];
  for (const sq in pieceEls) {
    if (map[sq] === curMap[sq]) next[sq] = pieceEls[sq];
    else vanished.push({ sq, p: curMap[sq], el: pieceEls[sq] });
  }
  for (const sq in map) if (!next[sq]) appeared.push({ sq, p: map[sq] });
  const dist = (a, b) => Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) + Math.abs(a[1] - b[1]);
  for (const a of appeared) {
    let best = null, bd = 99;
    for (const v of vanished) if (!v.used && v.p === a.p && dist(v.sq, a.sq) < bd) { bd = dist(v.sq, a.sq); best = v; }
    let el;
    if (best) {
      best.used = true; el = best.el;
      el.classList.remove('dragging');
      el.style.transition = dur ? `transform ${dur}ms ease` : 'none';
      el.style.zIndex = 5;
      setTimeout(() => { el.style.zIndex = ''; }, dur + 20);
    } else {
      el = document.createElement('div');
      el.className = 'piece';
      el.style.backgroundImage = `url(pieces/${a.p}.svg)`;
      el.style.transition = 'none';
      layer.appendChild(el);
    }
    el.style.transform = sqT(a.sq);
    next[a.sq] = el;
  }
  for (const v of vanished) if (!v.used) v.el.remove();
  pieceEls = next; curMap = { ...map };
}

// ───────────────────────── rendering ─────────────────────────
function posChess() { return live() ? game : new Chess(fenAt(S.ply)); }

function render(animate = false) {
  syncPieces(fenMap(fenAt(S.ply)), animate);
  renderHL(); renderArrows(); renderBars(); renderMoves(); renderEvalBar(); renderCoach();
}

function renderHL() {
  const layer = $('.hl-layer', boardEl);
  const out = [];
  const add = (sq, cls, inner = '') => out.push(`<div class="hl ${cls}" style="transform:${sqT(sq)}">${inner}</div>`);
  const mv = S.history[S.ply - 1];
  if (mv) { add(mv.from, 'last'); add(mv.to, 'last'); }
  for (const sq of S.marks) add(sq, 'mark');
  if (S.selected) add(S.selected, 'sel');
  const pc = posChess();
  if (pc.inCheck()) {
    const map = fenMap(fenAt(S.ply)), k = pc.turn() + 'K';
    const ksq = Object.keys(map).find(s => map[s] === k);
    if (ksq) add(ksq, 'check');
  }
  if (S.selected && settings.legal) {
    const map = curMap;
    for (const m of S.legal) add(m.to, map[m.to] || m.flags.includes('e') ? 'ring' : 'dot');
  }
  if (S.hover) add(S.hover, 'hover');
  if (S.phase === 'review' && S.review?.done && mv) {
    const c = CLS[S.review.cls[S.ply - 1]];
    if (c) add(mv.to, 'cls', `<span style="background:${c.c}">${c.i}</span>`);
  }
  layer.innerHTML = out.join('');
}

function arrowSVG(from, to, color, w = 0.17) {
  const ctr = sq => { const [c, r] = sqColRow(sq); return { x: c + 0.5, y: r + 0.5 }; };
  const a = ctr(from), b = ctr(to);
  const pts = [a];
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  if ((dx === 1 && dy === 2) || (dx === 2 && dy === 1)) pts.push(dx > dy ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
  const p = pts[pts.length - 1];
  const len = Math.hypot(b.x - p.x, b.y - p.y), ux = (b.x - p.x) / len, uy = (b.y - p.y) / len;
  const hl = 0.42, hw = 0.26;
  const base = { x: b.x - ux * hl, y: b.y - uy * hl };
  const start = pts.length === 2 ? { x: a.x + ux * 0.3, y: a.y + uy * 0.3 } : { ...a };
  if (pts.length === 3) { const u0x = Math.sign(pts[1].x - a.x), u0y = Math.sign(pts[1].y - a.y); start.x += u0x * 0.3; start.y += u0y * 0.3; }
  const shaft = [start, ...pts.slice(1), base].map(q => `${q.x},${q.y}`).join(' ');
  const head = [b, { x: base.x - uy * hw, y: base.y + ux * hw }, { x: base.x + uy * hw, y: base.y - ux * hw }].map(q => `${q.x},${q.y}`).join(' ');
  return `<g opacity=".8"><polyline points="${shaft}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round"/><polygon points="${head}" fill="${color}"/></g>`;
}
function renderArrows() {
  const parts = S.arrows.map(([f, t]) => arrowSVG(f, t, '#ffaa00'));
  if (S.hint) parts.push(arrowSVG(S.hint.slice(0, 2), S.hint.slice(2, 4), '#4caf50'));
  if (S.phase === 'review' && S.review?.done && S.ply > 0) {
    const k = S.ply - 1, best = S.review.best[k], cls = S.review.cls[k];
    if (best && !['best', 'book'].includes(cls)) parts.push(arrowSVG(best.slice(0, 2), best.slice(2, 4), '#81b64c', 0.14));
  }
  if (S.phase === 'analysis' && S.ana.lines[0]?.pv?.[0]) {
    const m = S.ana.lines[0].pv[0];
    parts.push(arrowSVG(m.slice(0, 2), m.slice(2, 4), '#3b8ed0', 0.14));
  }
  $('.arrows', boardEl).innerHTML = parts.join('');
}

const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
function material(fen) {
  const map = fenMap(fen);
  const cnt = { w: { P: 0, N: 0, B: 0, R: 0, Q: 0 }, b: { P: 0, N: 0, B: 0, R: 0, Q: 0 } };
  let mat = { w: 0, b: 0 };
  for (const p of Object.values(map)) { if (p[1] !== 'K') cnt[p[0]][p[1]]++; mat[p[0]] += VAL[p[1]]; }
  return { cnt, mat };
}
function playerFor(color) {
  if (S.mode === 'bot' && S.phase !== 'analysis') {
    if (color === S.playerColor) return { name: YOU.name, rating: '', style: avatarStyle(YOU.glyph, YOU.color) };
    return { name: S.bot.name, rating: `(${S.bot.elo})`, style: avatarStyle(S.bot.glyph, S.bot.color) };
  }
  return { name: color === 'w' ? 'White' : 'Black', rating: '', style: avatarStyle(color + 'K', color === 'w' ? '#5d5a57' : '#8a8784') };
}
function renderBars() {
  const { cnt, mat } = material(fenAt(S.ply));
  const START = { P: 8, N: 2, B: 2, R: 2, Q: 1 };
  const bottom = S.flipped ? 'b' : 'w', top = S.flipped ? 'w' : 'b';
  for (const [id, color] of [['#bar-top', top], ['#bar-bottom', bottom]]) {
    const bar = $(id), opp = color === 'w' ? 'b' : 'w', pl = playerFor(color);
    $('.avatar', bar).style.cssText = pl.style;
    $('.name', bar).textContent = pl.name;
    $('.rating', bar).textContent = pl.rating;
    let h = '';
    for (const t of ['P', 'B', 'N', 'R', 'Q']) {
      const n = Math.max(0, START[t] - cnt[opp][t]);
      for (let i = 0; i < n; i++) h += `<img src="pieces/${opp}${t}.svg">`;
      if (n) h += '<span class="gap"></span>';
    }
    const diff = mat[color] - mat[opp];
    if (diff > 0) h += `<span class="adv">+${diff}</span>`;
    $('.captured', bar).innerHTML = h;
    $('.clock', bar).className = 'clock ' + (color === 'w' ? 'white' : 'black');
  }
  renderClocks();
}
function fmtClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 20000) { const s = Math.floor(ms / 1000), t = Math.floor(ms % 1000 / 100); return `0:${String(s).padStart(2, '0')}.${t}`; }
  const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(ss).padStart(2, '0');
}
function renderClocks() {
  const hasClock = S.tc.base > 0 && ['play', 'over', 'review'].includes(S.phase);
  const bottom = S.flipped ? 'b' : 'w';
  for (const [id, color] of [['#bar-top', bottom === 'w' ? 'b' : 'w'], ['#bar-bottom', bottom]]) {
    const el = $('.clock', $(id));
    if (!hasClock) { el.textContent = ''; continue; }
    el.textContent = fmtClock(S.clocks[color]);
    el.classList.toggle('active', S.phase === 'play' && game.turn() === color);
    el.classList.toggle('low', S.clocks[color] < Math.min(20000, S.tc.base * 100) && S.phase === 'play');
  }
}

function evalVisible() {
  return S.phase === 'analysis' || S.phase === 'review' || (settings.evalPlay && ['play', 'over'].includes(S.phase));
}
function currentEval() {
  if (S.phase === 'review' && S.review?.done) return S.review.evals[S.ply];
  return S.ana.lines[0] || null;
}
function renderEvalBar() {
  const bar = $('#evalbar');
  bar.classList.toggle('hidden', !evalVisible());
  bar.classList.toggle('flipped', S.flipped);
  const s = currentEval(); if (!s) return;
  const v = scoreNum(s);
  const pct = s.mate != null ? (s.mate > 0 ? 100 : 0) : Math.min(97, Math.max(3, winChance(v)));
  $('.eval-white', bar).style.height = pct + '%';
  bar.classList.toggle('black-adv', v < 0);
  $('.eval-text', bar).textContent = Math.abs(v) >= 100000 ? scoreText(s) : scoreText(s, false).replace('-', '');
}

// ───────────────────────── panel ─────────────────────────
const panel = $('#panel');

function tcGrid(selId, act) {
  return `<div class="tc-grid">${TCS.map(t => `<button data-act="${act}" data-id="${t.id}" class="${t.id === selId ? 'sel' : ''}">${t.label}<small>${t.sub}</small></button>`).join('')}</div>`;
}
function navButtons() {
  return `<div class="navbtns"><button data-act="nav" data-to="start" title="First">⏮</button><button data-act="nav" data-to="prev" title="Previous">◀</button><button data-act="nav" data-to="next" title="Next">▶</button><button data-act="nav" data-to="end" title="Last">⏭</button></div>`;
}
function confirmLabel(act, label) { return S.confirm === act ? 'Confirm?' : label; }

function renderPanel() {
  let h = '';
  if (S.phase === 'setup' && S.mode === 'bot') {
    const b = S.bot;
    h = `<div class="panel-head"><img src="pieces/wN.svg">Play Bots</div>
      <div class="panel-body">
        <div class="bot-hero"><div class="avatar" style="${avatarStyle(b.glyph, b.color)}"></div>
          <div class="bubble"><b>${esc(b.name)} <span style="color:#888;font-weight:400">${b.elo}</span></b>${esc(b.hi)}</div></div>
        <div class="group-title">Choose a bot</div>
        <div class="bot-grid">${BOTS.map(x => `<button class="bot-card ${x === b ? 'sel' : ''}" data-act="bot" data-id="${x.id}" title="${esc(x.name)} (${x.elo})" style="${avatarStyle(x.glyph, x.color)}"><span class="r">${x.elo}</span></button>`).join('')}</div>
        <div class="group-title">I play as</div>
        <div class="seg colors">${[['w', '♔', 'White'], ['r', '⚄', 'Random'], ['b', '♚', 'Black']].map(([v, ic, t]) => `<button data-act="color" data-v="${v}" title="${t}" class="${S.colorChoice === v ? 'sel' : ''}">${ic}</button>`).join('')}</div>
        <div class="group-title">Time control</div>
        ${tcGrid(S.tcBot, 'tcbot')}
      </div>
      <div class="panel-foot"><button class="btn-green big" data-act="start">Play</button></div>`;
  } else if (S.phase === 'setup' && S.mode === 'friend') {
    h = `<div class="panel-head">⇄ Pass &amp; Play</div>
      <div class="panel-body">
        <p style="color:#bbb;margin-top:0">Play against a friend on this device. Flip the board whenever you like.</p>
        <div class="group-title">Time control</div>
        ${tcGrid(S.tcFriend, 'tcfriend')}
      </div>
      <div class="panel-foot"><button class="btn-green big" data-act="start">Play</button></div>`;
  } else if (S.phase === 'play' || S.phase === 'over') {
    const head = S.mode === 'bot'
      ? `<div class="avatar" style="width:28px;height:28px;${avatarStyle(S.bot.glyph, S.bot.color)}"></div>${esc(S.bot.name)} <span style="color:#989795;font-weight:400;font-size:15px">(${S.bot.elo})</span>`
      : '⇄ Pass &amp; Play';
    const tcLabel = S.tc.base ? `${S.tc.label} · ${S.tc.sub}` : 'Casual · No timer';
    let actions;
    if (S.phase === 'play') {
      const tb = S.mode === 'bot' ? S.history.some(m => m.color === S.playerColor) : S.history.length > 0;
      actions = `<div class="actbtns">
        <button data-act="takeback" ${tb ? '' : 'disabled'}><span>↶</span>Takeback</button>
        ${S.mode === 'bot' ? '<button data-act="hint"><span>✦</span>Hint</button>' : ''}
        <button data-act="flip"><span>⇅</span>Flip</button>
        <button data-act="draw" ${S.history.length < 2 ? 'disabled' : ''}><span>½</span>${confirmLabel('draw', 'Draw')}</button>
        <button data-act="resign"><span>⚑</span>${confirmLabel('resign', 'Resign')}</button></div>`;
    } else {
      actions = `<button class="btn-green" data-act="review">★ Game Review</button>
        <div class="go-row"><button class="btn-grey" data-act="new">+ New Game</button><button class="btn-grey" data-act="rematch">⟳ Rematch</button><button class="btn-grey" data-act="analyze">⌕ Analyze</button></div>`;
    }
    h = `<div class="panel-head">${head}</div>
      <div class="opening" id="opening"></div>
      ${S.mode === 'bot' && S.botSay ? `<div class="chat"><div class="avatar" style="${avatarStyle(S.bot.glyph, S.bot.color)}"></div><span>${esc(S.botSay)}</span></div>` : ''}
      <div class="moves" id="moves"></div>
      <div class="status-line" id="status">${esc(tcLabel)}</div>
      <div class="panel-foot">${navButtons()}${actions}</div>`;
  } else if (S.phase === 'review') {
    h = `<div class="panel-head">★ Game Review</div>
      <div class="review-top" id="review-top"></div>
      <div class="coach" id="coach"></div>
      <div class="moves" id="moves"></div>
      <div class="panel-foot">${navButtons()}<div class="go-row"><button class="btn-grey" data-act="new">+ New Game</button><button class="btn-grey" data-act="analyze">⌕ Analyze</button><button class="btn-grey" data-act="flip">⇅ Flip</button></div></div>`;
  } else if (S.phase === 'analysis') {
    h = `<div class="panel-head">⌕ Analysis</div>
      <div class="depth" id="depth"></div>
      <div class="lines" id="lines"></div>
      <div class="opening" id="opening"></div>
      <div class="moves" id="moves"></div>
      <div class="panel-foot">${navButtons()}
        <div class="io"><input id="fen-in" placeholder="Paste FEN…" spellcheck="false"><button class="btn-grey" data-act="loadfen">Load</button></div>
        <div class="io"><textarea id="pgn-in" rows="2" placeholder="Paste PGN…" spellcheck="false"></textarea><button class="btn-grey" data-act="loadpgn">Load</button></div>
        <div class="go-row"><button class="btn-grey" data-act="copypgn">Copy PGN</button><button class="btn-grey" data-act="copyfen">Copy FEN</button><button class="btn-grey" data-act="reset">Reset</button><button class="btn-grey" data-act="flip">⇅</button></div>
      </div>`;
  }
  panel.innerHTML = h;
  renderMoves(); renderReviewTop(); renderCoach(); renderLines();
}

function renderMoves() {
  const el = $('#moves'); if (!el) return;
  let h = '', row = null;
  const rows = [];
  S.history.forEach((m, i) => {
    const num = +m.before.split(' ')[5];
    if (m.color === 'w' || !row) { row = { num, w: null, b: null }; rows.push(row); }
    row[m.color] = i;
  });
  const cell = i => {
    if (i == null) return '<span></span>';
    const m = S.history[i];
    let icon = '';
    if (S.phase === 'review' && S.review?.done) { const c = CLS[S.review.cls[i]]; if (c) icon = `<span class="ci" style="background:${c.c}" title="${c.t}">${c.i}</span>`; }
    return `<span class="mv ${S.ply === i + 1 ? 'cur' : ''}" data-ply="${i + 1}">${icon}${esc(m.san)}</span>`;
  };
  for (const r of rows) h += `<div class="mrow"><span class="mnum">${r.num}.</span>${r.w == null ? '<span class="mnum">…</span>' : cell(r.w)}${cell(r.b)}</div>`;
  el.innerHTML = h;
  const cur = $('.mv.cur', el);
  if (cur) cur.scrollIntoView({ block: 'nearest' }); else if (live()) el.scrollTop = el.scrollHeight;
  const op = $('#opening');
  if (op) {
    const sans = S.history.slice(0, S.ply).map(m => m.san.replace(/[+#]/g, ''));
    let name = null;
    if (S.startFen === DEFAULT_POSITION) for (let k = sans.length; k > 0 && !name; k--) name = openingName(sans.slice(0, k));
    op.textContent = name || (S.startFen === DEFAULT_POSITION ? 'Starting Position' : 'Custom Position');
  }
}

function renderLines() {
  const el = $('#lines'); if (!el) return;
  const fen = fenAt(S.ply);
  const pc = new Chess(fen);
  if (pc.isGameOver()) { el.innerHTML = `<div class="line"><span class="pv">${pc.isCheckmate() ? 'Checkmate' : 'Draw'}</span></div>`; $('#depth').textContent = ''; return; }
  el.innerHTML = S.ana.lines.slice(0, 3).map(l => {
    const neg = scoreNum(l) < 0;
    return `<div class="line"><span class="sc ${neg ? 'neg' : ''}">${scoreText(l)}</span><span class="pv">${esc(pvToSan(fen, l.pv, 12))}</span></div>`;
  }).join('') || '<div class="line"><span class="pv">Calculating…</span></div>';
  $('#depth').innerHTML = `<span>Stockfish 19 (lite)</span><span>depth ${S.ana.depth || 0}</span>`;
}
function pvToSan(fen, pv, max) {
  const c = new Chess(fen); const out = [];
  for (const u of pv.slice(0, max)) {
    let m; try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    const n = m.before.split(' ')[5];
    out.push(m.color === 'w' ? `${n}. ${m.san}` : (out.length ? m.san : `${n}… ${m.san}`));
  }
  return out.join(' ');
}

// ───────────────────────── interaction ─────────────────────────
function canMoveFrom(sq) {
  const pc = posChess(), p = curMap[sq];
  if (!p || p[0] !== pc.turn()) return false;
  if (S.phase === 'analysis') return true;
  if (S.phase !== 'play' || !live()) return false;
  if (S.mode === 'bot') return p[0] === S.playerColor && !S.thinking;
  return true;
}
function select(sq) {
  S.selected = sq;
  S.legal = sq ? posChess().moves({ square: sq, verbose: true }) : [];
  renderHL();
}

let drag = null, rightStart = null;
boardEl.addEventListener('contextmenu', e => e.preventDefault());
boardEl.addEventListener('pointerdown', e => {
  const sq = sqFromPoint(e.clientX, e.clientY); if (!sq) return;
  if (e.button === 2) { rightStart = sq; return; }
  if (e.button !== 0) return;
  ac();
  if (S.arrows.length || S.marks.size) { S.arrows = []; S.marks.clear(); renderArrows(); }
  // in a live game, clicking while looking at an old move snaps back to the current position
  if (S.phase === 'play' && !live()) { goTo(S.history.length, false); }
  if (S.selected && S.legal.some(m => m.to === sq)) { tryMove(S.selected, sq, true); return; }
  if (!canMoveFrom(sq)) {
    if (S.selected) select(null);
    else if (curMap[sq] && S.phase === 'play' && S.mode === 'bot' && curMap[sq][0] === S.playerColor && game.turn() !== S.playerColor) sfx('illegal');
    return;
  }
  const wasSelected = S.selected === sq;
  select(sq);
  const el = pieceEls[sq];
  drag = { from: sq, el, x0: e.clientX, y0: e.clientY, moved: false, wasSelected };
  boardEl.setPointerCapture(e.pointerId);
});
boardEl.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
  drag.moved = true;
  const rect = boardEl.getBoundingClientRect(), sz = rect.width / 8;
  drag.el.classList.add('dragging');
  drag.el.style.transition = 'none';
  drag.el.style.transform = `translate(${e.clientX - rect.left - sz / 2}px, ${e.clientY - rect.top - sz / 2}px)`;
  const h = sqFromPoint(e.clientX, e.clientY);
  if (h !== S.hover) { S.hover = h; renderHL(); }
});
boardEl.addEventListener('pointerup', e => {
  const sq = sqFromPoint(e.clientX, e.clientY);
  if (e.button === 2) {
    if (rightStart && sq) {
      if (sq === rightStart) S.marks.has(sq) ? S.marks.delete(sq) : S.marks.add(sq);
      else {
        const i = S.arrows.findIndex(([f, t]) => f === rightStart && t === sq);
        i >= 0 ? S.arrows.splice(i, 1) : S.arrows.push([rightStart, sq]);
      }
      renderHL(); renderArrows();
    }
    rightStart = null; return;
  }
  if (!drag) return;
  const d = drag; drag = null; S.hover = null;
  if (d.moved && sq && sq !== d.from && S.legal.some(m => m.to === sq)) { tryMove(d.from, sq, false); return; }
  d.el.classList.remove('dragging');
  d.el.style.transition = d.moved ? 'transform 120ms ease' : 'none';
  d.el.style.transform = sqT(d.from);
  if (d.moved && sq && sq !== d.from) { sfx('illegal'); select(null); return; }
  if (!d.moved && d.wasSelected) select(null); else renderHL();
});

function promoChoice(to, color) {
  return new Promise(res => {
    const box = $('.promo', boardEl);
    const [c, r] = sqColRow(to);
    const fromTop = r === 0;
    const types = ['q', 'n', 'r', 'b'];
    box.innerHTML = `<div class="promo-col" style="left:${c * 12.5}%;${fromTop ? 'top:0' : 'bottom:0'};flex-direction:${fromTop ? 'column' : 'column-reverse'}">
      ${types.map(t => `<button data-p="${t}" style="background-image:url(pieces/${color}${t.toUpperCase()}.svg)"></button>`).join('')}<button class="x" data-p="">×</button></div>`;
    box.classList.remove('hidden');
    box.onpointerdown = e => {
      e.stopPropagation();
      const b = e.target.closest('button');
      box.classList.add('hidden'); box.innerHTML = '';
      res(b ? b.dataset.p || null : null);
    };
  });
}

async function tryMove(from, to, animate) {
  const cands = S.legal.filter(m => m.from === from && m.to === to);
  if (!cands.length) return;
  let promotion;
  if (cands[0].promotion) {
    if (settings.autoQ) promotion = 'q';
    else {
      // show the pawn on the promotion square while choosing
      const el = pieceEls[from];
      if (el) { el.classList.remove('dragging'); el.style.transition = 'none'; el.style.transform = sqT(to); }
      promotion = await promoChoice(to, cands[0].color);
      if (!promotion) { if (el) el.style.transform = sqT(from); select(null); return; }
    }
  }
  select(null);
  if (S.phase === 'analysis' && !live()) {
    // branching from an earlier position replaces the rest of the line
    game = new Chess(S.startFen);
    S.history = S.history.slice(0, S.ply).map(m => game.move(m.san));
  }
  const mv = game.move({ from, to, promotion });
  S.history.push(mv); S.ply = S.history.length;
  afterMove(mv, animate);
}

function moveSound(mv, chess) {
  if (chess.inCheck()) sfx('check');
  else if (mv.promotion) sfx('promote');
  else if (mv.flags.includes('k') || mv.flags.includes('q')) sfx('castle');
  else if (mv.captured) sfx('capture');
  else sfx('move');
}

function afterMove(mv, animate) {
  S.hint = null; S.confirm = null;
  moveSound(mv, game);
  if (S.phase === 'play' && S.tc.base) {
    if (S.clockStarted) S.clocks[mv.color] += S.tc.inc * 1000;
    S.clockStarted = true; S.lastTick = performance.now();
  }
  render(animate);
  if (S.phase === 'play') {
    const res = gameOverCheck();
    if (res) { endGame(res); return; }
    renderPanelActions();
    if (isBotTurn()) botMove();
  } else if (S.phase === 'analysis') {
    refreshAnalysis();
  }
  if (evalVisible() && S.phase === 'play') refreshAnalysis();
  persist();
}
// Re-render only the button row (keeps move-list scroll etc.)
function renderPanelActions() {
  if (S.phase !== 'play') return;
  const tb = $('[data-act="takeback"]', panel);
  if (tb) tb.disabled = S.mode === 'bot' ? !S.history.some(m => m.color === S.playerColor) : !S.history.length;
  const dr = $('[data-act="draw"]', panel); if (dr) dr.disabled = S.history.length < 2;
}

function gameOverCheck() {
  if (game.isCheckmate()) return { winner: game.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' };
  if (game.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (game.isInsufficientMaterial()) return { winner: null, reason: 'insufficient material' };
  if (game.isThreefoldRepetition()) return { winner: null, reason: 'repetition' };
  if (game.isDrawByFiftyMoves()) return { winner: null, reason: '50-move rule' };
  return null;
}

// ───────────────────────── game flow ─────────────────────────
function isBotTurn() { return S.mode === 'bot' && S.phase === 'play' && game.turn() !== S.playerColor; }

function startGame({ rematch = false } = {}) {
  S.gameId++;
  botEngine.cancel(); anaEngine.cancel();
  game = new Chess();
  Object.assign(S, {
    phase: 'play', startFen: DEFAULT_POSITION, history: [], ply: 0, result: null, review: null,
    selected: null, legal: [], arrows: [], hint: null, confirm: null, clockStarted: false, thinking: false,
    ana: { lines: [], depth: 0 },
  });
  S.marks.clear();
  if (S.mode === 'bot') {
    S.tc = tcById(S.tcBot);
    if (rematch) S.playerColor = S.playerColor === 'w' ? 'b' : 'w';
    else S.playerColor = S.colorChoice === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : S.colorChoice;
    S.botSay = S.bot.hi;
  } else {
    S.tc = tcById(S.tcFriend); S.playerColor = 'w';
  }
  S.flipped = S.playerColor === 'b';
  S.clocks = { w: S.tc.base * 1000, b: S.tc.base * 1000 };
  $('#gameover').classList.add('hidden');
  buildSquares(); render(false); renderPanel();
  sfx('start');
  if (isBotTurn()) botMove();
  if (evalVisible()) refreshAnalysis();
  persist();
}

async function botMove() {
  const gid = S.gameId, fen = game.fen();
  S.thinking = true;
  const cfg = S.bot.cfg;
  let options, go;
  if (cfg.full) { options = { UCI_LimitStrength: 'false', 'Skill Level': 20 }; go = 'movetime 1200'; }
  else if (cfg.elo) { options = { UCI_LimitStrength: 'true', UCI_Elo: cfg.elo, 'Skill Level': 20 }; go = 'movetime 700'; }
  else { options = { UCI_LimitStrength: 'false', 'Skill Level': cfg.skill }; go = `depth ${cfg.depth}`; }
  // spend less time when the bot's clock is low
  if (S.tc.base && S.clocks[game.turn()] < 30000) go = 'movetime 150';
  const t0 = performance.now();
  const res = await botEngine.search(fen, { go, options });
  if (gid !== S.gameId || S.phase !== 'play' || game.fen() !== fen) return;
  let uci = res?.bestmove;
  if (res?.lines[0]) S.botScore = scoreNum(res.lines[0]) * (game.turn() === 'w' ? 1 : -1);
  const moves = game.moves({ verbose: true });
  if (!uci || uci === '(none)' || (cfg.blunder && Math.random() < cfg.blunder)) {
    // weak bots: occasionally play a random move, preferring captures
    const caps = moves.filter(m => m.captured);
    const pool = caps.length && Math.random() < 0.5 ? caps : moves;
    const m = pool[Math.floor(Math.random() * pool.length)];
    uci = m.from + m.to + (m.promotion || '');
  }
  const fast = S.tc.base && S.tc.base <= 180;
  const want = fast ? 150 + Math.random() * 300 : 350 + Math.random() * 700;
  await sleep(Math.max(0, want - (performance.now() - t0)));
  if (gid !== S.gameId || S.phase !== 'play' || game.fen() !== fen) return;
  S.thinking = false;
  if (S.selected) select(null);
  const mv = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const wasLive = live();
  S.history.push(mv);
  S.ply = S.history.length;
  afterMove(mv, wasLive);
}

function endGame(result) {
  S.phase = 'over'; S.result = result; S.thinking = false; S.confirm = null;
  botEngine.cancel();
  sfx('end');
  let title, trophy;
  if (!result.winner) { title = 'Draw'; trophy = '½'; }
  else if (S.mode === 'bot') {
    const won = result.winner === S.playerColor;
    title = won ? 'You Won!' : `${S.bot.name} Won`; trophy = won ? '♛' : '⚑';
    S.botSay = won ? 'Well played! You earned that one.' : 'Good game! Want to try again?';
  } else { title = (result.winner === 'w' ? 'White' : 'Black') + ' Won'; trophy = '♛'; }
  const reason = { checkmate: 'by checkmate', resignation: 'by resignation', timeout: 'on time', agreement: 'by agreement' }[result.reason] || 'by ' + result.reason;
  const go = $('#gameover');
  $('.trophy', go).textContent = trophy;
  $('.go-title', go).textContent = title;
  $('.go-sub', go).textContent = reason;
  go.classList.remove('hidden');
  render(false); renderPanel();
  persist();
}

function goTo(p, animate = true) {
  p = Math.max(0, Math.min(S.history.length, p));
  if (p === S.ply) return;
  const step = Math.abs(p - S.ply) === 1, fwd = p > S.ply;
  S.ply = p; S.hint = null;
  select(null);
  render(animate && step);
  if (step && fwd) moveSound(S.history[p - 1], new Chess(fenAt(p)));
  else if (step) sfx('move');
  if (evalVisible() && !(S.phase === 'review')) refreshAnalysis();
}

// ───────────────────────── analysis ─────────────────────────
function refreshAnalysis() {
  if (!evalVisible() || S.phase === 'review') return;
  const token = ++S.anaToken;
  anaEngine.cancel();
  const fen = fenAt(S.ply), pc = new Chess(fen);
  S.ana = { lines: [], depth: 0 };
  if (pc.isGameOver()) {
    S.ana.lines = [terminalEval(pc)];
    renderEvalBar(); renderLines(); return;
  }
  renderLines(); renderArrows();
  const multipv = S.phase === 'analysis' ? 3 : 1;
  const go = S.phase === 'analysis' ? 'depth 22' : 'depth 16';
  let last = 0;
  anaEngine.search(fen, {
    go, multipv, options: { UCI_LimitStrength: 'false', 'Skill Level': 20 },
    onInfo: (lines, depth) => {
      if (token !== S.anaToken) return;
      S.ana = { lines, depth };
      const now = performance.now();
      if (now - last < 120 && depth < 10) return;
      last = now;
      renderEvalBar(); renderLines(); if (S.phase === 'analysis') renderArrows();
    },
  }).then(r => {
    if (token !== S.anaToken || !r) return;
    renderEvalBar(); renderLines(); if (S.phase === 'analysis') renderArrows();
  });
}

function enterAnalysis(keepGame) {
  S.gameId++; botEngine.cancel();
  if (!keepGame) { game = new Chess(); S.startFen = DEFAULT_POSITION; S.history = []; S.ply = 0; }
  S.mode = 'analysis'; S.phase = 'analysis'; S.review = null; S.result = null;
  $('#gameover').classList.add('hidden');
  setNav('analysis');
  buildSquares(); render(false); renderPanel(); refreshAnalysis();
}

function loadPosition(startFen, sans) {
  game = new Chess(startFen);
  S.startFen = startFen;
  S.history = sans.map(s => game.move(s));
  S.ply = S.history.length;
  buildSquares(); render(false); renderPanel(); refreshAnalysis();
}

// ───────────────────────── game review ─────────────────────────
async function runReview() {
  S.phase = 'review';
  $('#gameover').classList.add('hidden');
  const gid = S.gameId;
  const n = S.history.length;
  S.review = { done: false, progress: 0, evals: [], best: [], cls: [], acc: null };
  S.anaToken++; anaEngine.cancel();
  renderPanel(); render(false);
  for (let i = 0; i <= n; i++) {
    const fen = fenAt(i), pc = new Chess(fen);
    let ev, best = null;
    if (pc.isGameOver()) ev = terminalEval(pc);
    else {
      const r = await anaEngine.search(fen, { go: 'depth 13', multipv: 1, options: { UCI_LimitStrength: 'false', 'Skill Level': 20 } });
      if (gid !== S.gameId || S.phase !== 'review') return;
      if (!r) return;
      ev = r.lines[0] || { cp: 0, mate: null, pv: [] };
      best = r.bestmove;
    }
    S.review.evals[i] = ev; S.review.best[i] = best;
    S.review.progress = (i + 1) / (n + 1);
    renderReviewTop();
  }
  // classify every move by the drop in the mover's win chance
  const sans = S.history.map(m => m.san.replace(/[+#]/g, ''));
  const acc = { w: [], b: [] }, counts = { w: {}, b: {} };
  S.history.forEach((m, k) => {
    const sg = m.color === 'w' ? 1 : -1;
    const before = winChance(sg * clampEval(scoreNum(S.review.evals[k])));
    const after = winChance(sg * clampEval(scoreNum(S.review.evals[k + 1])));
    const loss = Math.max(0, before - after);
    const isBest = S.review.best[k] === m.from + m.to + (m.promotion || '');
    let c;
    if (S.startFen === DEFAULT_POSITION && loss < 3 && inBook(sans.slice(0, k + 1))) c = 'book';
    else if (isBest || loss < 0.5) c = 'best';
    else if (loss < 2.5) c = 'excellent';
    else if (loss < 6) c = 'good';
    else if (loss < 11) c = 'inaccuracy';
    else if (loss < 20) c = 'mistake';
    else c = 'blunder';
    const prev = S.review.cls[k - 1];
    // opponent erred and this move failed to punish it
    if (['mistake', 'blunder'].includes(c) && ['mistake', 'blunder'].includes(prev)) c = 'miss';
    S.review.cls[k] = c;
    acc[m.color].push(Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669)));
    counts[m.color][c] = (counts[m.color][c] || 0) + 1;
  });
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 100;
  S.review.acc = { w: avg(acc.w), b: avg(acc.b) };
  S.review.counts = counts;
  S.review.done = true;
  S.ply = 0;
  renderPanel(); render(false);
}
const clampEval = v => Math.max(-2000, Math.min(2000, v));
const inBook = sans => OPENINGS.some(([, seq]) => seq.length >= sans.length && sans.every((m, i) => m === seq[i]));

function renderReviewTop() {
  const el = $('#review-top'); if (!el || !S.review) return;
  const R = S.review;
  if (!R.done) {
    el.innerHTML = `<div style="font-weight:700">Analyzing your game…</div><div class="progress"><div style="width:${(R.progress * 100).toFixed(0)}%"></div></div><div style="color:#989795;font-size:13px">Stockfish is checking every move.</div>`;
    return;
  }
  const n = R.evals.length - 1;
  const pts = R.evals.map((e, i) => `${n ? i / n * 100 : 0},${100 - winChance(clampEval(scoreNum(e)))}`);
  const curX = n ? S.ply / n * 100 : 0;
  const dots = S.history.map((m, k) => {
    const c = R.cls[k]; if (!['mistake', 'blunder', 'miss'].includes(c)) return '';
    return `<circle cx="${(k + 1) / n * 100}" cy="${100 - winChance(clampEval(scoreNum(R.evals[k + 1])))}" r="2.2" fill="${CLS[c].c}" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  const wName = playerFor('w').name, bName = playerFor('b').name;
  const rows = ['best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'].map(c =>
    `<div class="lbl"><span class="ci" style="background:${CLS[c].c};width:18px;height:18px;border-radius:50%;font:800 10px/18px sans-serif;text-align:center">${CLS[c].i}</span>${CLS[c].t}</div><div class="n">${R.counts.w[c] || 0}</div><div class="n">${R.counts.b[c] || 0}</div>`).join('');
  el.innerHTML = `<svg class="graph" id="graph" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polygon points="0,100 ${pts.join(' ')} 100,100" fill="#fff"/>
      <line x1="0" y1="50" x2="100" y2="50" stroke="#888" stroke-width=".6" vector-effect="non-scaling-stroke"/>
      <line x1="${curX}" y1="0" x2="${curX}" y2="100" stroke="#81b64c" stroke-width="2" vector-effect="non-scaling-stroke"/>
      ${dots}</svg>
    <div class="acc"><div></div><div class="h">${esc(wName)}</div><div class="h">${esc(bName)}</div>
      <div class="lbl">Accuracy</div><div class="v w">${R.acc.w.toFixed(1)}</div><div class="v b">${R.acc.b.toFixed(1)}</div>
      ${rows}</div>`;
}

function renderCoach() {
  const el = $('#coach'); if (!el || !S.review?.done) { if (el) el.innerHTML = ''; return; }
  const R = S.review, k = S.ply - 1;
  const coachAv = `<div class="avatar" style="width:44px;height:44px;${avatarStyle('wN', '#81b64c')}"></div>`;
  if (k < 0) { el.innerHTML = `${coachAv}<div class="bubble">Let's look at your game. Use ▶ or the arrow keys to step through the moves.</div>`; renderReviewTop(); return; }
  const m = S.history[k], c = CLS[R.cls[k]];
  const ev = R.evals[k + 1];
  let txt = `<b style="color:${c.c}">${esc(m.san)} is ${R.cls[k] === 'best' ? 'the best move' : R.cls[k] === 'book' ? 'a book move' : (/^[aeiou]/i.test(c.t) ? 'an ' : 'a ') + c.t.toLowerCase()}</b>`;
  const best = R.best[k];
  if (best && !['best', 'book'].includes(R.cls[k])) {
    const san = pvToSan(fenAt(k), [best], 1).replace(/^\d+\.+\s?|^\d+…\s?/, '');
    txt += `The best move was <b style="display:inline;color:#45753c">${esc(san)}</b>.`;
  }
  txt += ` <span style="color:#666">(${scoreText(ev)})</span>`;
  el.innerHTML = `${coachAv}<div class="bubble">${txt}</div>`;
  renderReviewTop();
}

// ───────────────────────── persistence ─────────────────────────
function persist() {
  if (S.mode === 'analysis') { save('cl.game', null); return; }
  save('cl.game', {
    mode: S.mode, phase: S.phase === 'review' ? 'over' : S.phase, botId: S.bot.id, playerColor: S.playerColor,
    tcId: S.tc.id, startFen: S.startFen, sans: S.history.map(m => m.san), clocks: S.clocks,
    clockStarted: S.clockStarted, result: S.result, flipped: S.flipped,
  });
}
function restore() {
  const g = load('cl.game', null);
  if (!g || !['play', 'over'].includes(g.phase) || !g.sans?.length) return false;
  try {
    S.mode = g.mode; S.bot = BOTS.find(b => b.id === g.botId) || S.bot; S.playerColor = g.playerColor;
    S.tc = tcById(g.tcId); S.clocks = g.clocks; S.clockStarted = g.clockStarted; S.flipped = g.flipped;
    game = new Chess(g.startFen); S.startFen = g.startFen;
    S.history = g.sans.map(s => game.move(s)); S.ply = S.history.length;
    S.phase = g.phase; S.result = g.result; S.lastTick = performance.now();
    setNav(S.mode);
    buildSquares(); render(false); renderPanel();
    if (isBotTurn()) botMove();
    return true;
  } catch { return false; }
}

// ───────────────────────── panel actions ─────────────────────────
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
}
function askConfirm(act) {
  if (S.confirm === act) { S.confirm = null; return true; }
  S.confirm = act; renderPanel();
  setTimeout(() => { if (S.confirm === act) { S.confirm = null; renderPanel(); } }, 3000);
  return false;
}
function savePrefs() { save('cl.prefs', { botId: S.bot.id, color: S.colorChoice, tcBot: S.tcBot, tcFriend: S.tcFriend }); }

panel.addEventListener('click', async e => {
  const mvEl = e.target.closest('.mv');
  if (mvEl) { goTo(+mvEl.dataset.ply, true); return; }
  const g = e.target.closest('#graph');
  if (g && S.review?.done) {
    const r = g.getBoundingClientRect();
    goTo(Math.round((e.clientX - r.left) / r.width * S.history.length), false); return;
  }
  const b = e.target.closest('[data-act]'); if (!b) return;
  ac();
  switch (b.dataset.act) {
    case 'bot': S.bot = BOTS.find(x => x.id === b.dataset.id); savePrefs(); renderPanel(); renderBars(); break;
    case 'color': S.colorChoice = b.dataset.v; savePrefs(); renderPanel(); break;
    case 'tcbot': S.tcBot = b.dataset.id; savePrefs(); renderPanel(); break;
    case 'tcfriend': S.tcFriend = b.dataset.id; savePrefs(); renderPanel(); break;
    case 'start': startGame(); break;
    case 'rematch': startGame({ rematch: true }); break;
    case 'new': newGameSetup(); break;
    case 'nav': {
      const to = b.dataset.to;
      goTo(to === 'start' ? 0 : to === 'end' ? S.history.length : S.ply + (to === 'next' ? 1 : -1), true);
      break;
    }
    case 'flip': flip(); break;
    case 'takeback': takeback(); break;
    case 'hint': hint(); break;
    case 'resign':
      if (!askConfirm('resign')) break;
      endGame({ winner: S.mode === 'bot' ? (S.playerColor === 'w' ? 'b' : 'w') : (game.turn() === 'w' ? 'b' : 'w'), reason: 'resignation' });
      break;
    case 'draw':
      if (S.mode === 'friend') { if (askConfirm('draw')) endGame({ winner: null, reason: 'agreement' }); break; }
      offerDraw(); break;
    case 'review': runReview(); break;
    case 'analyze': enterAnalysis(true); break;
    case 'reset': loadPosition(DEFAULT_POSITION, []); break;
    case 'loadfen': {
      const f = $('#fen-in').value.trim();
      try { new Chess(f); loadPosition(f, []); } catch (err) { toast('Invalid FEN'); }
      break;
    }
    case 'loadpgn': {
      const c = new Chess();
      try {
        c.loadPgn($('#pgn-in').value.trim());
        const fen = c.header().FEN || DEFAULT_POSITION;
        loadPosition(fen, c.history());
      } catch (err) { toast('Invalid PGN'); }
      break;
    }
    case 'copypgn': copy(pgnText(), 'PGN copied'); break;
    case 'copyfen': copy(fenAt(S.ply), 'FEN copied'); break;
  }
});
function pgnText() {
  const c = new Chess(S.startFen);
  if (S.startFen !== DEFAULT_POSITION) { c.setHeader('SetUp', '1'); c.setHeader('FEN', S.startFen); }
  c.setHeader('Event', 'ChessLocal game');
  c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
  for (const m of S.history) c.move(m.san);
  return c.pgn();
}
function copy(text, msg) {
  (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast(msg), () => {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(msg); } catch { toast('Copy failed'); } ta.remove();
  });
}

function flip() { S.flipped = !S.flipped; buildSquares(); render(false); persist(); }

function takeback() {
  if (S.phase !== 'play') return;
  S.gameId++; botEngine.cancel(); S.thinking = false;
  let n = 1;
  if (S.mode === 'bot') {
    if (game.turn() === S.playerColor) n = 2;
    if (n > S.history.length || !S.history.slice(-n).some(m => m.color === S.playerColor)) return;
  }
  for (let i = 0; i < n && S.history.length; i++) { game.undo(); S.history.pop(); }
  S.ply = S.history.length; S.hint = null;
  select(null); sfx('move');
  render(true); renderPanelActions(); persist();
  if (isBotTurn()) botMove();
  if (evalVisible()) refreshAnalysis();
}

async function hint() {
  if (S.phase !== 'play' || !live() || isBotTurn()) return;
  const fen = game.fen();
  toast('Thinking…');
  anaEngine.cancel(); S.anaToken++;
  const r = await anaEngine.search(fen, { go: 'depth 14', options: { UCI_LimitStrength: 'false', 'Skill Level': 20 } });
  if (!r || game.fen() !== fen) return;
  S.hint = r.bestmove; renderArrows();
  if (evalVisible()) refreshAnalysis();
}

function offerDraw() {
  if (S.phase !== 'play') return;
  // bot accepts if it is clearly worse, or the game is long and dead level
  const s = S.botScore;
  const accept = s < -150 || (Math.abs(s) < 40 && S.history.length >= 60);
  if (accept) endGame({ winner: null, reason: 'agreement' });
  else { sfx('notify'); toast(`${S.bot.name} declined the draw`); S.botSay = 'No thanks, let\'s keep playing!'; renderPanel(); }
}

function newGameSetup() {
  S.gameId++; botEngine.cancel(); anaEngine.cancel();
  if (S.mode === 'analysis') S.mode = 'bot';
  game = new Chess();
  Object.assign(S, { phase: 'setup', startFen: DEFAULT_POSITION, history: [], ply: 0, result: null, review: null, selected: null, legal: [], hint: null, arrows: [], flipped: false, thinking: false });
  S.marks.clear();
  $('#gameover').classList.add('hidden');
  setNav(S.mode);
  buildSquares(); render(false); renderPanel(); persist();
}

// ───────────────────────── nav, modal, settings, keys ─────────────────────────
function setNav(mode) {
  document.querySelectorAll('.nav-item[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}
let navConfirm = null;
document.querySelectorAll('.nav-item[data-mode]').forEach(b => b.addEventListener('click', () => {
  const mode = b.dataset.mode;
  if (S.phase === 'play' && S.history.length && navConfirm !== mode) {
    navConfirm = mode; toast('Click again to leave the current game');
    setTimeout(() => { navConfirm = null; }, 3000); return;
  }
  navConfirm = null;
  if (mode === 'analysis') { enterAnalysis(false); return; }
  S.mode = mode; newGameSetup();
}));

$('.modal-x', $('#gameover')).onclick = () => $('#gameover').classList.add('hidden');
$('#go-review').onclick = () => runReview();
$('#go-new').onclick = () => newGameSetup();
$('#go-rematch').onclick = () => startGame({ rematch: true });

const dlg = $('#settings');
$('#btn-settings').onclick = () => {
  $('#set-theme').value = settings.theme; $('#set-sound').checked = settings.sound;
  $('#set-legal').checked = settings.legal; $('#set-coords').checked = settings.coords;
  $('#set-eval').checked = settings.evalPlay; $('#set-autoq').checked = settings.autoQ;
  $('#set-anim').value = String(settings.anim);
  dlg.classList.remove('hidden');
};
dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.classList.add('hidden'); });
dlg.addEventListener('change', () => {
  Object.assign(settings, {
    theme: $('#set-theme').value, sound: $('#set-sound').checked, legal: $('#set-legal').checked,
    coords: $('#set-coords').checked, evalPlay: $('#set-eval').checked, autoQ: $('#set-autoq').checked,
    anim: +$('#set-anim').value,
  });
  applySettings(); render(false);
  if (evalVisible()) refreshAnalysis();
});

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  const k = e.key;
  if (k === 'ArrowLeft') goTo(S.ply - 1);
  else if (k === 'ArrowRight') goTo(S.ply + 1);
  else if (k === 'ArrowUp' || k === 'Home') goTo(0, false);
  else if (k === 'ArrowDown' || k === 'End') goTo(S.history.length, false);
  else if (k === 'f') flip();
  else if (k === 'Escape') { dlg.classList.add('hidden'); $('#gameover').classList.add('hidden'); select(null); }
  else return;
  e.preventDefault();
});

// ───────────────────────── clock ─────────────────────────
setInterval(() => {
  if (S.phase !== 'play' || !S.tc.base || !S.clockStarted) return;
  const now = performance.now(), turn = game.turn();
  S.clocks[turn] -= now - S.lastTick; S.lastTick = now;
  if (S.clocks[turn] <= 0) {
    S.clocks[turn] = 0;
    const winner = turn === 'w' ? 'b' : 'w';
    // a flag only wins if the opponent could still deliver mate
    const { cnt } = material(game.fen());
    const c = cnt[winner];
    const canMate = c.P || c.Q || c.R || (c.B + c.N >= 2);
    endGame(canMate ? { winner, reason: 'timeout' } : { winner: null, reason: 'timeout vs insufficient material' });
    return;
  }
  renderClocks();
}, 100);

// ───────────────────────── boot ─────────────────────────
applySettings();
if (!restore()) { buildSquares(); render(false); renderPanel(); }

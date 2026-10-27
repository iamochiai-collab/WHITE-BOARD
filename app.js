import { firebaseConfig } from './firebase-config.js';

const FB = '10.12.2';
const UDFONT = '\"UD デジタル 教科書体 N-R\",\"UD Digi Kyokasho N-R\",\"UDDigiKyokashoN-R\",\"BIZ UDPGothic\",\"Hiragino Sans\",sans-serif';
const W = 1600, H = 900;
const NOTE_COLORS = [['#FFE97A','レモン'],['#FFC4D6','さくら'],['#C6EFA4','わかば'],['#B5DEFF','そら'],['#FFCF9E','みかん'],['#DCCEFF','ふじ']];
const INK_COLORS  = [['#22242A','すみ'],['#2C4FC6','あい'],['#1F8A4C','みどり'],['#D33A2C','べに'],['#E59A00','やまぶき']];
const MARK_COLORS = [['#FFD60A','きいろ'],['#7BE0A0','みどり'],['#FF8FB1','もも'],['#8EC9FF','みず']];
const USER_COLORS = ['#D9480F','#2B8A3E','#1971C2','#AE3EC9','#C2255C','#0C8599','#E67700','#5F3DC4','#2F9E44','#1864AB'];
const WIDTHS = [[3,'細'],[6,'中'],[12,'太']];
const BGS = [['plain','背景：無地'],['grid','背景：方眼'],['dot','背景：ドット'],['lined','背景：罫線'],['genkou','背景：原稿用紙']];
const BG_SVG = {
  grid:   "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><path d='M40 0V40M0 40H40' stroke='#D9DEE7' stroke-width='1.2' fill='none'/></svg>",
  dot:    "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><circle cx='16' cy='16' r='1.9' fill='#B4BCCA'/></svg>",
  lined:  "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='50'><path d='M0 49.4H16' stroke='#C5D0E3' stroke-width='1.2' fill='none'/></svg>",
  genkou: "<svg xmlns='http://www.w3.org/2000/svg' width='50' height='42'><path d='M5 0V42M45 0V42M5 0.6H45' stroke='#E2A193' stroke-width='1.2' fill='none'/></svg>"
};
const bgData = k => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(BG_SVG[k]);
const defaultGroups = n => Array.from({ length: n }, (_, i) => ({ id: 'g' + (i + 1), name: (i + 1) + '班' }));
const GID = /^g([1-9]|1[0-9]|20)$/;

const $ = id => document.getElementById(id);
const board = $('board'), layer = $('layer'), stage = $('stage'), wrap = $('wrap');
const livePath = $('livePath'), laserCv = $('laser'), lctx = laserCv.getContext('2d');
const titleEl = $('title'), ctxEl = $('ctx'), hintEl = $('hint');

const state = {
  tool: 'pen', inkColor: '#22242A', inkW: 6, markColor: '#FFD60A', noteColor: '#FFE97A', textColor: '#22242A',
  group: null, groups: defaultGroups(6), lock: false, myGroup: null, myName: '',
  frames: [], frameId: null, items: new Map(), local: new Map(), sel: null, editing: null,
  teacher: false, scale: 1, title: '', share: false, room: null, roomName: ''
};
let S = null, baseS = null;   // S: いまのルームの中を読み書きする / baseS: 全体
let uid = null, isLocal = false, authApi = null;
let pendingTeacherOpen = location.hash === '#teacher';
let peers = [];
const peerDrag = new Map();
const pendingFrames = new Set();
let sessionUnsubs = [];

const rid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const r1 = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fkOf = (fid, g) => (g || state.group) + '/' + fid;
const curFK = () => fkOf(state.frameId);
const framePath = fk => { const [g, f] = fk.split('/'); return 'groups/' + g + '/frames/' + f; };
const itemsPath = fk => { const [g, f] = fk.split('/'); return 'groups/' + g + '/items/' + f; };
const itemPath = (fk, id) => itemsPath(fk) + '/' + id;
const curFrame = () => state.frames.find(f => f.id === state.frameId) || state.frames[0];
const gName = id => { const g = state.groups.find(x => x.id === id); return g ? g.name : (GID.test(id || '') ? id.slice(1) + '班' : '班'); };
const fmtTime = t => { try { return new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
const anyModal = () => !!document.querySelector('.modal:not([hidden])');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const colorFor = id => { let h = 0; for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return USER_COLORS[h % USER_COLORS.length]; };
const asList = v => Array.isArray(v) ? v.filter(Boolean) : (isObj(v) ? Object.keys(v).sort((a, b) => a - b).map(k => v[k]).filter(Boolean) : []);
const isDenied = e => /PERMISSION|permission/i.test(String((e && (e.code || e.message)) || ''));

/* item encoding: strokes are stored as a compact "x,y,x,y" string */
function encodeItem(it) {
  const o = Object.assign({}, it);
  if (Array.isArray(o.pts)) o.pts = o.pts.join(',');
  for (const k in o) if (o[k] === undefined) delete o[k];
  return o;
}
function decodeItem(v) {
  if (!isObj(v)) return null;
  const o = Object.assign({}, v);
  if (typeof o.pts === 'string') o.pts = o.pts.split(',').map(Number);
  return o;
}

/* ================= stores ================= */
async function makeFirebaseStore() {
  const [{ initializeApp }, A, D] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${FB}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${FB}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${FB}/firebase-database.js`)
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = D.getDatabase(app);
  const R = p => D.ref(db, p);
  authApi = {
    onUser: cb => A.onAuthStateChanged(auth, cb),
    anon: () => A.signInAnonymously(auth)
  };
  return {
    write: (p, op, d) => op === 'set' ? D.set(R(p), d) : op === 'update' ? D.update(R(p), d) : D.remove(R(p)),
    get: async p => (await D.get(R(p))).val(),
    onValue: (p, cb, err) => D.onValue(R(p), s => cb(s.val()), err),
    onChildren: (p, h, err) => {
      const r = R(p);
      const u = [D.onChildAdded(r, s => h.add(s.key, s.val()), err), D.onChildChanged(r, s => h.change(s.key, s.val()), err), D.onChildRemoved(r, s => h.remove(s.key), err)];
      return () => u.forEach(f => f());
    },
    onDisconnectRemove: p => D.onDisconnect(R(p)).remove().catch(() => {}),
    connected: cb => D.onValue(R('.info/connected'), s => cb(!!s.val()))
  };
}
function makeLocalStore() {
  const KEY = 'white-board-trial-v1';
  let root = {};
  try { root = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { root = {}; }
  const parts = p => p.split('/').filter(Boolean);
  const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));
  const getAt = p => { let n = root; for (const k of parts(p)) { if (!isObj(n)) return null; n = n[k]; } return n === undefined ? null : clone(n); };
  const setAt = (p, v) => {
    const ks = parts(p); let n = root;
    for (let i = 0; i < ks.length - 1; i++) { if (!isObj(n[ks[i]])) n[ks[i]] = {}; n = n[ks[i]]; }
    const last = ks[ks.length - 1];
    if (v == null) delete n[last]; else n[last] = clone(v);
  };
  const subs = new Set();
  let queued = false;
  const notify = () => {
    try { localStorage.setItem(KEY, JSON.stringify(root)); } catch (e) {}
    if (queued) return; queued = true;
    Promise.resolve().then(() => { queued = false; subs.forEach(f => f()); });
  };
  return {
    write: async (p, op, d) => {
      if (op === 'set') setAt(p, d);
      else if (op === 'update') for (const k in d) setAt(p + '/' + k, d[k]);
      else setAt(p, null);
      notify();
    },
    get: async p => getAt(p),
    onValue: (p, cb) => { let last; const f = () => { const v = getAt(p), s = JSON.stringify(v); if (s !== last) { last = s; cb(v); } }; subs.add(f); setTimeout(f, 0); return () => subs.delete(f); },
    onChildren: (p, h) => {
      let prev = {};
      const f = () => {
        const v = getAt(p) || {}, next = {};
        for (const k in v) { const s = JSON.stringify(v[k]); next[k] = s; if (!(k in prev)) h.add(k, v[k]); else if (prev[k] !== s) h.change(k, v[k]); }
        for (const k in prev) if (!(k in next)) h.remove(k);
        prev = next;
      };
      subs.add(f); setTimeout(f, 0); return () => subs.delete(f);
    },
    onDisconnectRemove: () => {},
    connected: cb => { setTimeout(() => cb(true), 0); return () => {}; }
  };
}

function roomStore(base) {
  const P = p => p.startsWith('.info') ? p : 'rooms/' + state.room + '/' + p;
  return {
    write: (p, o, d) => base.write(P(p), o, d),
    get: p => base.get(P(p)),
    onValue: (p, cb, e) => base.onValue(P(p), cb, e),
    onChildren: (p, h, e) => base.onChildren(P(p), h, e),
    onDisconnectRemove: p => base.onDisconnectRemove(P(p)),
    connected: base.connected
  };
}

/* ================= status, toast, confirm ================= */
let inflight = 0, hadError = false, online = false, started = false;
function setStatus() {
  const el = $('status'), t = $('statusText');
  let s, txt;
  if (!started) { s = 'connecting'; txt = '接続中…'; }
  else if (isLocal) { s = 'local'; txt = 'お試しモード（この端末だけ）'; }
  else if (!online) { s = 'saving'; txt = 'オフライン（つながると保存）'; }
  else if (hadError) { s = 'error'; txt = '保存できませんでした'; }
  else if (inflight > 0) { s = 'saving'; txt = '保存中…'; }
  else { s = 'saved'; txt = '保存済み'; }
  el.dataset.s = s; t.textContent = txt;
}
let toastT = 0;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
}
function confirmBox(msg, okLabel, primary) {
  return new Promise(res => {
    const m = $('modal'), ok = $('modalOk'), cancel = $('modalCancel');
    $('modalMsg').textContent = msg; ok.textContent = okLabel || '消す';
    ok.className = 'txtbtn ' + (primary ? 'primary' : 'danger');
    m.hidden = false; cancel.focus();
    const done = v => { m.hidden = true; ok.onclick = cancel.onclick = m.onclick = null; res(v); };
    ok.onclick = () => done(true); cancel.onclick = () => done(false);
    m.onclick = e => { if (e.target === m) done(false); };
  });
}

/* ================= writes ================= */
let deniedToastAt = 0;
function write(path, op, data) {
  if (!S) return Promise.resolve(false);
  inflight++; setStatus();
  return S.write(path, op, data).then(() => { hadError = false; return true; }, e => {
    if (isDenied(e)) {
      if (Date.now() - deniedToastAt > 4000) { deniedToastAt = Date.now(); toast('書き込みが許可されていません。班の設定を確かめてください'); }
    } else hadError = true;
    return false;
  }).finally(() => { inflight--; setStatus(); });
}

/* ================= item helpers ================= */
function setItem(fk, id, data) {
  if (fk === curFK()) { state.items.set(id, data); renderItems(); }
  ensureFrame(fk);
  return write(itemPath(fk, id), 'set', encodeItem(data));
}
function updItem(fk, id, patch) {
  if (fk === curFK()) { const it = state.items.get(id); if (!it) return Promise.resolve(); state.items.set(id, Object.assign({}, it, patch)); renderItems(); }
  return write(itemPath(fk, id), 'update', encodeItem(patch));
}
function delItem(fk, id) {
  if (fk === curFK()) { state.items.delete(id); renderItems(); }
  return write(itemPath(fk, id), 'remove');
}
function ensureFrame(fk) {
  const f = state.frames.find(x => fkOf(x.id) === fk);
  if (f && f.virtual && !f._creating) { f._creating = true; write(framePath(fk), 'set', { order: f.order || 0, bg: f.bg || 'plain' }); }
}
function addItem(data) {
  const id = rid(), fk = curFK();
  const item = Object.assign({}, data, { z: Date.now(), by: uid || '', ts: Date.now() });
  setItem(fk, id, item);
  pushUndo({ undo: () => delItem(fk, id) });
  return id;
}

/* ================= undo ================= */
const undoStack = [];
function pushUndo(u) { u.frame = state.frameId; undoStack.push(u); if (undoStack.length > 120) undoStack.shift(); $('undoBtn').disabled = false; }
function undo() {
  const u = undoStack.pop(); $('undoBtn').disabled = !undoStack.length;
  if (!u) return;
  stopEdit();
  if (u.frame !== state.frameId && state.frames.find(f => f.id === u.frame)) goFrame(u.frame);
  u.undo(); toast('元に戻しました');
}

/* ================= layout ================= */
function layout() {
  const r = stage.getBoundingClientRect();
  const s = Math.max(0.05, Math.min((r.width - 12) / W, (r.height - 12) / H));
  state.scale = s;
  wrap.style.width = (W * s) + 'px'; wrap.style.height = (H * s) + 'px';
  board.style.transform = 'scale(' + s + ')';
  renderCursors();
}

/* ================= tools ================= */
function setTool(t) {
  if (state.editing) stopEdit();
  state.tool = t; board.dataset.tool = t;
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  if (t !== 'select') select(null);
  if (t !== 'laser') presence({ l: 0 });
  renderOpts();
}
function swBtn(color, name, cls, pressed, fn) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'sw ' + (cls || ''); b.style.background = color;
  b.title = name; b.setAttribute('aria-label', name); b.setAttribute('aria-pressed', String(pressed));
  b.onclick = fn; return b;
}
function renderOpts() {
  const o = $('opts'); o.textContent = '';
  const t = state.tool;
  const add = (list, key, cls) => list.forEach(([c, n]) => o.appendChild(swBtn(c, n, cls, state[key] === c, () => { state[key] = c; renderOpts(); })));
  if (t === 'pen') {
    add(INK_COLORS, 'inkColor');
    WIDTHS.forEach(([w, n]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'wd'; b.title = '太さ：' + n;
      b.setAttribute('aria-label', '太さ ' + n); b.setAttribute('aria-pressed', String(state.inkW === w));
      const d = document.createElement('b'); const px = 3 + w * 0.9; d.style.width = d.style.height = px + 'px';
      b.appendChild(d); b.onclick = () => { state.inkW = w; renderOpts(); }; o.appendChild(b);
    });
  } else if (t === 'marker') add(MARK_COLORS, 'markColor');
  else if (t === 'note') add(NOTE_COLORS, 'noteColor', 'note');
  else if (t === 'text') add(INK_COLORS, 'textColor');
  o.hidden = !o.children.length; $('optsSep').hidden = o.hidden;
}

/* ================= rendering items ================= */
const els = new Map();
const bboxCache = new WeakMap();
function bbox(it) {
  let b = bboxCache.get(it.pts); if (b) return b;
  const p = it.pts; let a = Infinity, c = Infinity, d = -Infinity, e = -Infinity;
  for (let i = 0; i < p.length; i += 2) { a = Math.min(a, p[i]); c = Math.min(c, p[i + 1]); d = Math.max(d, p[i]); e = Math.max(e, p[i + 1]); }
  b = [a, c, d, e]; bboxCache.set(it.pts, b); return b;
}
function pathD(p) {
  const n = p.length / 2;
  if (n < 1) return '';
  let d = 'M' + p[0] + ' ' + p[1];
  if (n === 1) return d + 'l0.01 0';
  if (n === 2) return d + 'L' + p[2] + ' ' + p[3];
  for (let i = 1; i < n - 1; i++) {
    const x = p[2 * i], y = p[2 * i + 1], nx = p[2 * i + 2], ny = p[2 * i + 3];
    d += 'Q' + x + ' ' + y + ' ' + r1((x + nx) / 2) + ' ' + r1((y + ny) / 2);
  }
  return d + 'L' + p[2 * n - 2] + ' ' + p[2 * n - 1];
}
const validInk = it => it && Array.isArray(it.pts) && it.pts.length >= 2 && it.pts.length % 2 === 0 && it.pts.every(v => typeof v === 'number' && isFinite(v));
const SVGNS = 'http://www.w3.org/2000/svg';
function createEl(id, it) {
  let el;
  if (it.type === 'ink') {
    el = document.createElementNS(SVGNS, 'svg');
    el.setAttribute('class', 'item ink' + ((it.a || 1) < 1 ? ' hl' : ''));
    const vis = document.createElementNS(SVGNS, 'path');
    vis.setAttribute('fill', 'none'); vis.setAttribute('stroke-linecap', 'round'); vis.setAttribute('stroke-linejoin', 'round');
    const hit = document.createElementNS(SVGNS, 'path');
    hit.setAttribute('class', 'hit'); hit.setAttribute('fill', 'none'); hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-linecap', 'round'); hit.setAttribute('stroke-linejoin', 'round');
    el.append(vis, hit); el._vis = vis; el._hit = hit;
  } else if (it.type === 'image') {
    el = document.createElement('div');
    el.className = 'item photo loading';
    const im = document.createElement('img'); im.alt = ''; im.draggable = false;
    el.appendChild(im); el._img = im;
  } else {
    el = document.createElement('div');
    el.className = 'item ' + (it.type === 'note' ? 'note' : 'textbox');
    const t = document.createElement('div'); t.className = 'txt'; el.appendChild(t); el._txt = t;
    t.addEventListener('input', () => onTextInput(id));
    t.addEventListener('blur', () => { if (state.editing === id) stopEdit(); });
    t.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); t.blur(); } e.stopPropagation(); });
    t.addEventListener('paste', e => {
      e.preventDefault();
      const s = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      document.execCommand('insertText', false, s);
    });
    el.addEventListener('dblclick', () => { if (state.tool === 'select') startEdit(id); });
  }
  el.dataset.id = id; el._type = it.type;
  return el;
}
function viewOf(id, it) {
  const loc = state.local.get(id), pd = peerDrag.get(id);
  if (loc) return Object.assign({}, it, loc);
  if (pd) return Object.assign({}, it, { x: pd.x, y: pd.y });
  return it;
}
function updateEl(el, id, it0, z) {
  const it = viewOf(id, it0);
  el.style.zIndex = z;
  if (it.type === 'ink') {
    const b = bbox(it), pad = (it.w || 4) / 2 + 10;
    const vx = b[0] - pad, vy = b[1] - pad, vw = b[2] - b[0] + pad * 2, vh = b[3] - b[1] + pad * 2;
    el.style.left = (it.x + vx) + 'px'; el.style.top = (it.y + vy) + 'px';
    el.setAttribute('width', vw); el.setAttribute('height', vh);
    el.setAttribute('viewBox', vx + ' ' + vy + ' ' + vw + ' ' + vh);
    if (el._pts !== it.pts) { const d = pathD(it.pts); el._vis.setAttribute('d', d); el._hit.setAttribute('d', d); el._pts = it.pts; }
    el._vis.setAttribute('stroke', it.color); el._vis.setAttribute('stroke-width', it.w);
    el._vis.setAttribute('stroke-opacity', it.a || 1);
    el._hit.setAttribute('stroke-width', (it.w || 4) + 18);
  } else if (it.type === 'image') {
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
    const c = imgCache.get(it.img);
    if (c && c.el) { if (el._img.getAttribute('src') !== c.el.src) el._img.src = c.el.src; el.classList.remove('loading'); }
    else { getImg(it.img); el.classList.add('loading'); }
  } else {
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; el.style.width = it.w + 'px';
    if (it.type === 'note') { el.style.height = it.h + 'px'; el.style.background = it.color; }
    else { el.style.color = it.color; el.style.fontSize = (it.fs || 36) + 'px'; }
    if (state.editing !== id && el._text !== it.text) { el._txt.textContent = it.text || ''; el._text = it.text; if (it.type === 'note') fitNote(el); }
    if (it.type === 'note' && el._h !== it.h + 'x' + it.w) { el._h = it.h + 'x' + it.w; fitNote(el); }
  }
  el.classList.toggle('sel', state.sel === id);
  const pd = peerDrag.get(id);
  el.classList.toggle('remote', !!pd && !state.local.get(id));
  if (pd) el.style.setProperty('--rc', pd.col || '#888');
  const wantHandle = state.sel === id && it.type !== 'ink';
  let h = el.querySelector(':scope > .handle');
  if (wantHandle && !h) { h = document.createElement('div'); h.className = 'handle'; h.setAttribute('aria-hidden', 'true'); el.appendChild(h); }
  else if (!wantHandle && h) h.remove();
}
function fitNote(el) {
  const t = el._txt; let s = 40; t.style.fontSize = s + 'px';
  const max = el.clientHeight - 36;
  while (s > 12 && t.scrollHeight > max) { s -= 2; t.style.fontSize = s + 'px'; }
}
let renderQueued = false;
function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderItems(); }); }
function renderItems() {
  const seen = new Set();
  const list = [...state.items.entries()].filter(([, it]) => it.type === 'note' || it.type === 'text' || (it.type === 'image' && typeof it.img === 'string' && isFinite(it.w) && isFinite(it.h)) || (it.type === 'ink' && validInk(it))).sort((a, b) => (a[1].z || 0) - (b[1].z || 0));
  list.forEach(([id, it], i) => {
    seen.add(id);
    let el = els.get(id);
    if (el && (el._type !== it.type || (it.type === 'ink' && el.classList.contains('hl') !== ((it.a || 1) < 1)))) { el.remove(); el = null; }
    if (!el) { el = createEl(id, it); els.set(id, el); layer.appendChild(el); }
    updateEl(el, id, it, i + 1);
  });
  for (const [id, el] of els) if (!seen.has(id)) {
    el.remove(); els.delete(id);
    if (state.editing === id) state.editing = null;
    if (state.sel === id) state.sel = null;
  }
  hintEl.hidden = state.items.size > 0 && !!state.group;
  renderCtx();
}
function renderOne(id) { const el = els.get(id), it = state.items.get(id); if (el && it) updateEl(el, id, it, el.style.zIndex); }

/* ================= selection & context bar ================= */
function select(id) { if (state.sel === id) return; state.sel = id; renderItems(); }
function renderCtx() {
  const id = state.sel, it = id && state.items.get(id);
  if (!it) { ctxEl.hidden = true; ctxEl._for = null; return; }
  ctxEl.hidden = false;
  const key = id + ':' + it.color + ':' + it.type + ':' + it.z;
  if (ctxEl._for === key) return;
  ctxEl._for = key;
  ctxEl.textContent = '';
  const lab = document.createElement('span'); lab.className = 'lbl';
  lab.textContent = it.type === 'note' ? '付箋' : it.type === 'text' ? '文字' : it.type === 'image' ? '写真' : ((it.a || 1) < 1 ? 'マーカー' : '線');
  ctxEl.appendChild(lab);
  const colors = it.type === 'image' ? [] : it.type === 'note' ? NOTE_COLORS : (it.type === 'ink' && (it.a || 1) < 1 ? MARK_COLORS : INK_COLORS);
  colors.forEach(([c, n]) => ctxEl.appendChild(swBtn(c, n, it.type === 'note' ? 'note' : '', it.color === c, () => recolor(id, c))));
  const vs = document.createElement('span'); vs.className = 'vs'; ctxEl.appendChild(vs);
  const btn = (label, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'txtbtn ' + (cls || ''); b.textContent = label; b.onclick = fn; ctxEl.appendChild(b); };
  if (it.type === 'note' || it.type === 'text') btn('編集', () => startEdit(id));
  btn('前面へ', () => { const fk = curFK(), old = it.z; updItem(fk, id, { z: Date.now() }); pushUndo({ undo: () => updItem(fk, id, { z: old }) }); });
  btn('複製', () => duplicate(id));
  btn('削除', () => deleteItem(id), 'danger');
}
function recolor(id, c) {
  const it = state.items.get(id); if (!it || it.color === c) return;
  const fk = curFK(), old = it.color;
  updItem(fk, id, { color: c }); pushUndo({ undo: () => updItem(fk, id, { color: old }) });
  if (it.type === 'note') state.noteColor = c;
}
function duplicate(id) {
  const it = state.items.get(id); if (!it) return;
  const copy = Object.assign({}, it); delete copy.z; delete copy.by; delete copy.ts;
  copy.x = clamp(it.x + 30, -100, W - 40); copy.y = clamp(it.y + 30, -100, H - 40);
  const nid = addItem(copy); select(nid);
}
function deleteItem(id, opt) {
  const it = state.items.get(id); if (!it) return;
  const fk = curFK();
  if (state.sel === id) state.sel = null;
  delItem(fk, id);
  if (!opt || opt.undo !== false) pushUndo({ undo: () => setItem(fk, id, it) });
}

/* ================= text editing ================= */
const textTimers = new Map();
function startEdit(id) {
  const el = els.get(id), it = state.items.get(id);
  if (!el || !it || (it.type !== 'note' && it.type !== 'text')) return;
  if (state.editing && state.editing !== id) stopEdit();
  state.editing = id; state.sel = id; renderItems();
  const t = el._txt;
  try { t.contentEditable = 'plaintext-only'; } catch (e) {}
  if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
  el.classList.add('editing');
  t.focus();
  const r = document.createRange(); r.selectNodeContents(t); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function onTextInput(id) {
  const el = els.get(id); if (!el) return;
  if (el._type === 'note') fitNote(el);
  const fk = curFK();
  clearTimeout(textTimers.get(id));
  textTimers.set(id, setTimeout(() => flushText(fk, id, el._txt.innerText.replace(/\n$/, '')), 600));
}
function flushText(fk, id, text) {
  clearTimeout(textTimers.get(id)); textTimers.delete(id);
  const it = fk === curFK() ? state.items.get(id) : null;
  if (it && it.text === text) return;
  const el = els.get(id); if (el) el._text = text;
  updItem(fk, id, { text });
}
function stopEdit() {
  const id = state.editing; if (!id) return;
  state.editing = null;
  const el = els.get(id); if (!el) return;
  el.classList.remove('editing');
  const t = el._txt; t.contentEditable = 'false';
  const text = t.innerText.replace(/\n$/, '');
  flushText(curFK(), id, text);
  const it = state.items.get(id);
  if (it && it.type === 'text' && !text.trim()) {
    delItem(curFK(), id);
    const last = undoStack[undoStack.length - 1];
    if (last && last._create === id) undoStack.pop();
    $('undoBtn').disabled = !undoStack.length;
    if (state.sel === id) state.sel = null;
  }
}

/* ================= pointer input ================= */
function pt(e) { const r = board.getBoundingClientRect(); return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale }; }
let act = null;
const laserTrail = [];
const peerTrails = new Map();

board.addEventListener('pointerdown', e => {
  if (e.button > 0 || act || !state.group) return;
  if (state.editing && e.target.closest('.editing')) return;
  const p = pt(e), t = state.tool;
  if (state.editing) stopEdit();
  if (t === 'laser') {
    act = { kind: 'laser', pid: e.pointerId }; board.setPointerCapture(e.pointerId);
    presence({ l: 1, c: [Math.round(p.x), Math.round(p.y)] }); pushTrail(laserTrail, p); return;
  }
  if (t === 'pen' || t === 'marker') {
    e.preventDefault();
    const mk = t === 'marker';
    act = { kind: 'ink', pid: e.pointerId, pts: [r1(p.x), r1(p.y)], color: mk ? state.markColor : state.inkColor, w: mk ? 26 : state.inkW, a: mk ? 0.4 : 1 };
    livePath.setAttribute('stroke', act.color); livePath.setAttribute('stroke-width', act.w);
    livePath.setAttribute('stroke-opacity', act.a);
    board.setPointerCapture(e.pointerId); drawLive();
  } else if (t === 'eraser') {
    act = { kind: 'erase', pid: e.pointerId, last: p, gone: [], fk: curFK() };
    board.setPointerCapture(e.pointerId); eraseAt(p);
  } else if (t === 'note') {
    e.preventDefault();
    const w = 240, h = 240;
    const id = addItem({ type: 'note', x: r1(clamp(p.x - w / 2, 0, W - w)), y: r1(clamp(p.y - h / 2, 0, H - h)), w, h, color: state.noteColor, text: '' });
    setTool('select'); select(id); requestAnimationFrame(() => startEdit(id));
  } else if (t === 'text') {
    e.preventDefault();
    const id = addItem({ type: 'text', x: r1(clamp(p.x - 10, 0, W - 120)), y: r1(clamp(p.y - 28, 0, H - 60)), w: 420, color: state.textColor, fs: 36, text: '' });
    undoStack[undoStack.length - 1]._create = id;
    setTool('select'); select(id); requestAnimationFrame(() => startEdit(id));
  } else if (t === 'select') {
    const handle = e.target.closest('.handle');
    const el = e.target.closest('.item');
    if (handle && el) {
      const id = el.dataset.id, it = state.items.get(id); if (!it) return;
      act = { kind: 'resize', pid: e.pointerId, id, sx: p.x, sy: p.y, ow: it.w, oh: it.h, fk: curFK() };
      board.setPointerCapture(e.pointerId); e.preventDefault();
    } else if (el) {
      const id = el.dataset.id, it = state.items.get(id); if (!it) return;
      const was = state.sel === id; select(id);
      act = { kind: 'drag', pid: e.pointerId, id, sx: p.x, sy: p.y, ox: it.x, oy: it.y, moved: false, was, fk: curFK() };
      board.setPointerCapture(e.pointerId); e.preventDefault();
    } else select(null);
  }
});

let moveRaf = 0;
board.addEventListener('pointermove', e => {
  const p = pt(e);
  if (!act || act.kind !== 'ink') presence({ c: [Math.round(p.x), Math.round(p.y)] });
  if (!act || e.pointerId !== act.pid) return;
  if (act.kind === 'ink') {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of (evs.length ? evs : [e])) {
      const q = pt(ce), n = act.pts.length;
      const dx = q.x - act.pts[n - 2], dy = q.y - act.pts[n - 1];
      if (dx * dx + dy * dy >= 4) act.pts.push(r1(q.x), r1(q.y));
    }
    if (!moveRaf) moveRaf = requestAnimationFrame(() => { moveRaf = 0; drawLive(); });
  } else if (act.kind === 'erase') {
    const a = act.last, dist = Math.hypot(p.x - a.x, p.y - a.y), steps = Math.max(1, Math.ceil(dist / 8));
    for (let i = 1; i <= steps; i++) eraseAt({ x: a.x + (p.x - a.x) * i / steps, y: a.y + (p.y - a.y) * i / steps });
    act.last = p;
  } else if (act.kind === 'drag') {
    const dx = p.x - act.sx, dy = p.y - act.sy;
    if (!act.moved && Math.hypot(dx, dy) * state.scale < 4) return;
    act.moved = true;
    const nx = r1(clamp(act.ox + dx, -200, W - 40)), ny = r1(clamp(act.oy + dy, -200, H - 40));
    state.local.set(act.id, { x: nx, y: ny }); renderOne(act.id);
    presence({ d: { id: act.id, x: nx, y: ny } });
  } else if (act.kind === 'resize') {
    const it = state.items.get(act.id); if (!it) return;
    const nw = r1(clamp(act.ow + (p.x - act.sx), it.type === 'note' ? 120 : 80, it.type === 'image' ? 1600 : 1200));
    const patch = { w: nw };
    if (it.type === 'note') patch.h = r1(clamp(act.oh + (p.y - act.sy), 120, 800));
    if (it.type === 'image') patch.h = r1(nw * (act.oh / act.ow));
    state.local.set(act.id, patch); renderOne(act.id);
  } else if (act.kind === 'laser') {
    presence({ l: 1 }); pushTrail(laserTrail, p);
  }
});
function endGesture(e) {
  if (!act || e.pointerId !== act.pid) return;
  const a = act; act = null;
  if (a.kind === 'ink') {
    livePath.removeAttribute('d');
    let pts = a.pts;
    if (pts.length === 2) pts = [pts[0], pts[1], r1(pts[0] + 0.2), r1(pts[1] + 0.2)];
    let mx = Infinity, my = Infinity;
    for (let i = 0; i < pts.length; i += 2) { mx = Math.min(mx, pts[i]); my = Math.min(my, pts[i + 1]); }
    mx = Math.floor(mx); my = Math.floor(my);
    const rel = pts.map((v, i) => r1(v - (i % 2 ? my : mx)));
    addItem({ type: 'ink', x: mx, y: my, pts: rel, color: a.color, w: a.w, a: a.a });
  } else if (a.kind === 'erase') {
    if (a.gone.length) { const gone = a.gone, fk = a.fk; pushUndo({ undo: () => gone.forEach(([id, it]) => setItem(fk, id, it)) }); }
  } else if (a.kind === 'drag') {
    presence({ d: null });
    const loc = state.local.get(a.id); state.local.delete(a.id);
    if (a.moved && loc) {
      const fk = a.fk, ox = a.ox, oy = a.oy, id = a.id;
      updItem(fk, id, { x: loc.x, y: loc.y, z: Date.now() });
      pushUndo({ undo: () => updItem(fk, id, { x: ox, y: oy }) });
    } else if (!a.moved && a.was) {
      const it = state.items.get(a.id); if (it && (it.type === 'note' || it.type === 'text')) startEdit(a.id);
    }
  } else if (a.kind === 'resize') {
    const loc = state.local.get(a.id); state.local.delete(a.id);
    if (loc) {
      const fk = a.fk, id = a.id, old = { w: a.ow }; if (a.oh != null) old.h = a.oh;
      updItem(fk, id, loc); pushUndo({ undo: () => updItem(fk, id, old) });
    }
  } else if (a.kind === 'laser') {
    presence({ l: 0 });
  }
}
board.addEventListener('pointerup', endGesture);
board.addEventListener('pointercancel', endGesture);
board.addEventListener('pointerleave', () => { if (!act) presence({ c: null }); });

function drawLive() { if (act && act.kind === 'ink') livePath.setAttribute('d', pathD(act.pts)); }

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function hitInk(it, p, r) {
  const px = p.x - it.x, py = p.y - it.y, b = bbox(it);
  if (px < b[0] - r || px > b[2] + r || py < b[1] - r || py > b[3] + r) return false;
  const q = it.pts;
  if (q.length === 2) return Math.hypot(px - q[0], py - q[1]) <= r;
  for (let i = 0; i < q.length - 2; i += 2) if (segDist(px, py, q[i], q[i + 1], q[i + 2], q[i + 3]) <= r) return true;
  return false;
}
function eraseAt(p) {
  for (const [id, it] of state.items) {
    if (it.type !== 'ink' || !validInk(it)) continue;
    if (hitInk(it, p, 12 + (it.w || 4) / 2)) { act.gone.push([id, it]); delItem(act.fk, id); }
  }
}

/* ================= laser trails ================= */
let laserRaf = 0;
function pushTrail(arr, p) { arr.push({ x: p.x, y: p.y, t: performance.now() }); if (arr.length > 40) arr.shift(); kickLaser(); }
function kickLaser() { if (!laserRaf) laserRaf = requestAnimationFrame(drawLaser); }
function drawTrail(arr, now) {
  const live = arr.filter(q => now - q.t < 700);
  arr.length = 0; arr.push(...live);
  if (!live.length) return false;
  lctx.lineCap = 'round'; lctx.lineJoin = 'round';
  for (let i = 1; i < live.length; i++) {
    const a = live[i - 1], b = live[i], f = 1 - (now - b.t) / 700;
    lctx.strokeStyle = 'rgba(235,40,40,' + (0.55 * f) + ')'; lctx.lineWidth = 10 * f + 2;
    lctx.beginPath(); lctx.moveTo(a.x, a.y); lctx.lineTo(b.x, b.y); lctx.stroke();
  }
  const h = live[live.length - 1];
  lctx.fillStyle = 'rgba(255,60,50,.95)'; lctx.shadowColor = 'rgba(255,40,40,.9)'; lctx.shadowBlur = 18;
  lctx.beginPath(); lctx.arc(h.x, h.y, 9, 0, Math.PI * 2); lctx.fill(); lctx.shadowBlur = 0;
  return true;
}
function drawLaser() {
  laserRaf = 0;
  const now = performance.now();
  lctx.clearRect(0, 0, W, H);
  let any = drawTrail(laserTrail, now);
  for (const arr of peerTrails.values()) any = drawTrail(arr, now) || any;
  if (any) kickLaser();
}

/* ================= groups ================= */
let unsubFrames = null, unsubItems = null, unsubPres = null;
async function setGroup(g) {
  if (!GID.test(g)) return false;
  if (state.group === g) { renderGroupBtn(); return true; }
  // 生徒は先に自分の班を記録してから読みに行く（ルールで班ごとに守られているため）
  if (!state.teacher && !isLocal) {
    const ok = await write('users/' + uid, 'set', { name: state.myName, group: g });
    if (!ok) { toast('班を変えられませんでした'); return false; }
  }
  if (!state.teacher) { state.myGroup = g; if (isLocal) S.write('users/' + uid, 'set', { name: state.myName || 'お試し', group: g }); }
  else { try { localStorage.setItem('wb-teacher-group', g); } catch (e) {} }
  stopEdit();
  leavePresence();
  state.group = g;
  undoStack.length = 0; $('undoBtn').disabled = true;
  board.classList.remove('nogroup');
  renderGroupBtn();
  if (location.hash.slice(1) !== g) { try { history.replaceState(null, '', '#' + g); } catch (e) {} }
  subscribeGroup();
  joinPresence();
  setHint(); updateCmpBtn();
  return true;
}
function renderGroupBtn() {
  $('grpName').textContent = state.group ? gName(state.group) : '班を選ぶ';
  $('grpBtn').title = state.teacher ? '班を切りかえる・班の設定' : '班を選ぶ';
}
function setHint() {
  if (!state.group) { $('hintMain').textContent = '最初に、名前と班を入れてください'; $('hintSub').textContent = ''; }
  else { $('hintMain').textContent = 'ペンで書いたり、付箋や写真を貼ったりしてみましょう'; $('hintSub').textContent = gName(state.group) + 'のボードです。書いた内容は自動で保存され、同じ班の人にすぐ届きます'; }
  hintEl.hidden = state.items.size > 0 && !!state.group;
}
function subscribeGroup() {
  if (unsubFrames) { unsubFrames(); unsubFrames = null; }
  if (unsubItems) { unsubItems(); unsubItems = null; }
  const g = state.group;
  state.frames = [{ id: 'f1', order: 0, bg: 'plain', virtual: true }];
  state.frameId = null;
  goFrame('f1');
  unsubFrames = S.onValue('groups/' + g + '/frames', v => {
    if (state.group !== g) return;
    let fr = isObj(v) ? Object.keys(v).filter(k => isObj(v[k])).map(k => Object.assign({ id: k }, v[k])) : [];
    fr.forEach(f => pendingFrames.delete(f.id));
    state.frames.forEach(f => { if (pendingFrames.has(f.id) && !fr.find(x => x.id === f.id)) fr.push(f); });
    if (!fr.length) fr = [state.frames.find(f => f.virtual) || { id: 'f1', order: 0, bg: 'plain', virtual: true }];
    fr.sort((a, b) => (a.order || 0) - (b.order || 0));
    state.frames = fr;
    if (!state.frameId || !fr.find(f => f.id === state.frameId)) goFrame(fr[0].id);
    else { renderFrames(); applyBg(); }
  }, onReadErr);
}
function onReadErr(e) { if (isDenied(e)) toast('この班のボードを開く許可がありません'); else { hadError = true; setStatus(); } }

/* group picker */
function openGroups() {
  const m = $('gModal');
  const lockedForMe = !state.teacher && state.lock && !!state.myGroup;
  $('gTitle').textContent = state.teacher ? '班を切りかえる' : '班を選ぶ';
  $('gSub').textContent = state.teacher
    ? '先生はどの班のボードも開けます。生徒には、自分の班のボードだけが表示されます。'
    : '同じ班の人とボードを共有します。ほかの班のボードは開けません。';
  $('gLock').hidden = !lockedForMe;
  const list = $('gList'); list.textContent = '';
  state.groups.forEach(g => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'gbtn';
    b.textContent = g.name; b.setAttribute('aria-current', String(g.id === state.group));
    b.disabled = lockedForMe && g.id !== state.myGroup;
    b.onclick = async () => { if (await setGroup(g.id)) m.hidden = true; };
    list.appendChild(b);
  });
  $('gSettings').hidden = !state.teacher;
  if (state.teacher) renderGroupSettings();
  m.hidden = false;
}
function renderGroupSettings() {
  const sel = $('gCount');
  if (!sel.options.length) for (let i = 1; i <= 20; i++) { const o = document.createElement('option'); o.value = i; o.textContent = i + '班'; sel.appendChild(o); }
  sel.value = String(state.groups.length);
  $('gNames').textContent = '';
  drawNameInputs(state.groups.length);
  $('gLockChk').checked = !!state.lock;
}
function drawNameInputs(n) {
  const box = $('gNames'), prev = [...box.querySelectorAll('input')].map(i => i.value);
  box.textContent = '';
  for (let i = 0; i < n; i++) {
    const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 12; inp.id = 'gName' + (i + 1);
    inp.setAttribute('aria-label', (i + 1) + '番目の班の名前');
    inp.value = prev[i] != null && prev[i] !== '' ? prev[i] : ((state.groups[i] && state.groups[i].name) || (i + 1) + '班');
    box.appendChild(inp);
  }
}
async function saveGroupSettings() {
  const names = [...$('gNames').querySelectorAll('input')].map((inp, i) => (inp.value.trim() || (i + 1) + '班').slice(0, 12));
  const list = names.map((n, i) => ({ id: 'g' + (i + 1), name: n }));
  const lock = $('gLockChk').checked;
  const ok = await write('meta/groups', 'set', { list, lock });
  if (ok) { state.groups = list; state.lock = lock; renderGroupBtn(); openGroups(); toast('班の設定を保存しました'); }
}

/* welcome (name + group) */
let wPick = null;
function openWelcome(preG) {
  wPick = GID.test(preG || '') ? preG : null;
  $('nameIn').value = state.myName || '';
  $('wErr').hidden = true;
  const list = $('wList'); list.textContent = '';
  state.groups.forEach(g => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'gbtn'; b.textContent = g.name;
    b.setAttribute('aria-current', String(g.id === wPick));
    b.onclick = () => { wPick = g.id; list.querySelectorAll('.gbtn').forEach(x => x.setAttribute('aria-current', String(x === b))); checkWelcome(); };
    list.appendChild(b);
  });
  checkWelcome();
  $('wModal').hidden = false;
  setTimeout(() => $('nameIn').focus(), 50);
}
function checkWelcome() { $('wStart').disabled = !($('nameIn').value.trim() && wPick); }
async function startWelcome() {
  const name = $('nameIn').value.trim().slice(0, 20);
  if (!name || !wPick) return;
  state.myName = name;
  $('wStart').disabled = true;
  const ok = await setGroup(wPick);
  $('wStart').disabled = false;
  if (ok) { $('wModal').hidden = true; toast(gName(wPick) + 'に入りました'); }
  else { $('wErr').hidden = false; $('wErr').textContent = '登録できませんでした。通信を確かめて、もう一度おしてください。'; }
}

/* ================= frames ================= */
function goFrame(id) {
  stopEdit();
  state.frameId = id; state.sel = null; state.items = new Map(); state.local.clear(); peerDrag.clear();
  renderItems(); renderFrames(); applyBg();
  if (unsubItems) { unsubItems(); unsubItems = null; }
  const fk = curFK();
  if (S && state.group) {
    unsubItems = S.onChildren(itemsPath(fk), {
      add: (k, v) => { if (curFK() !== fk) return; const it = decodeItem(v); if (it) { state.items.set(k, it); releasePeerDrag(k, it); scheduleRender(); } },
      change: (k, v) => { if (curFK() !== fk) return; const it = decodeItem(v); if (it) { state.items.set(k, it); releasePeerDrag(k, it); scheduleRender(); } },
      remove: k => { if (curFK() !== fk) return; state.items.delete(k); scheduleRender(); }
    }, onReadErr);
  }
  presence({ f: id, d: null });
  renderCursors();
}
function releasePeerDrag(k, it) { const o = peerDrag.get(k); if (o && o.released && Math.abs(it.x - o.x) < 1 && Math.abs(it.y - o.y) < 1) peerDrag.delete(k); }
function renderFrames() {
  const i = state.frames.findIndex(f => f.id === state.frameId), n = state.frames.length;
  $('flab').textContent = 'フレーム ' + (i + 1) + ' / ' + n;
  $('prevF').disabled = i <= 0; $('nextF').disabled = i >= n - 1;
  $('delF').disabled = n <= 1;
  const chips = $('chips'); chips.textContent = '';
  const here = new Map();
  peers.forEach(p => { if (!p.isMe && p.presence && p.presence.f) here.set(p.presence.f, p.presence.col || '#888'); });
  state.frames.forEach((f, k) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = k + 1;
    b.setAttribute('aria-label', 'フレーム ' + (k + 1)); b.setAttribute('aria-current', String(f.id === state.frameId));
    if (here.has(f.id)) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = here.get(f.id); b.appendChild(d); b.title = 'だれかがこのフレームを見ています'; }
    b.onclick = () => { if (f.id !== state.frameId) goFrame(f.id); };
    chips.appendChild(b);
  });
  const f = curFrame(); if (f) $('bgSel').value = f.bg || 'plain';
}
function applyBg() {
  const f = curFrame(), k = f && f.bg;
  $('bgl').style.backgroundImage = BG_SVG[k] ? 'url("' + bgData(k) + '")' : 'none';
}
function addFrame() {
  if (!state.group) return;
  ensureFrame(curFK());
  const id = rid(), order = Math.max(0, ...state.frames.map(f => f.order || 0)) + 1;
  const bg = (curFrame() && curFrame().bg) || 'plain';
  pendingFrames.add(id);
  state.frames.push({ id, order, bg });
  write(framePath(fkOf(id)), 'set', { order, bg });
  goFrame(id);
  toast('フレーム ' + state.frames.length + ' を追加しました');
}
async function deleteFrame() {
  if (state.frames.length <= 1) return;
  const i = state.frames.findIndex(f => f.id === state.frameId);
  const ok = await confirmBox('フレーム ' + (i + 1) + ' を削除します。中の付箋や書き込みもすべて消え、元に戻せません。', 'フレームを削除');
  if (!ok) return;
  const fid = state.frameId, fk = curFK();
  const next = state.frames[i + 1] || state.frames[i - 1];
  state.frames = state.frames.filter(f => f.id !== fid);
  goFrame(next.id);
  write(itemsPath(fk), 'remove');
  write(framePath(fk), 'remove');
  const keep = undoStack.filter(u => u.frame !== fid); undoStack.length = 0; undoStack.push(...keep);
  $('undoBtn').disabled = !undoStack.length;
}
async function clearFrame() {
  if (!state.items.size) return;
  const ok = await confirmBox('このフレームの付箋と書き込みをすべて消します。「元に戻す」で戻せます。', '全部消す');
  if (!ok) return;
  const fk = curFK(), gone = [...state.items.entries()];
  state.sel = null;
  state.items = new Map(); renderItems();
  write(itemsPath(fk), 'remove');
  pushUndo({ undo: () => gone.forEach(([id, it]) => setItem(fk, id, it)) });
}
function setBg(k) {
  const f = curFrame(); if (!f) return;
  f.bg = k; applyBg();
  if (f.virtual && !f._creating) ensureFrame(curFK());
  else write(framePath(curFK()), 'update', { order: f.order || 0, bg: k });
}

/* ================= photos ================= */
const imgCache = new Map();
function getImg(id) {
  let c = imgCache.get(id);
  if (c) return c.p;
  c = { el: null };
  c.p = (async () => {
    try {
      const v = await S.get('images/' + id);
      if (!isObj(v) || typeof v.data !== 'string' || !v.data.startsWith('data:image/')) return null;
      c.el = await loadImg(v.data); scheduleRender(); return c.el;
    } catch (e) { return null; }
  })();
  imgCache.set(id, c);
  return c.p;
}
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const limit = isLocal ? 140000 : 300000;
    let max = 1280, q = 0.78, out = null;
    for (let i = 0; i < 7; i++) {
      const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
      out = { data: c.toDataURL('image/jpeg', q), w, h };
      if (out.data.length <= limit) break;
      max = Math.round(max * 0.8); q = Math.max(0.5, q - 0.06);
    }
    return out;
  } finally { URL.revokeObjectURL(url); }
}
let photoBusy = false;
async function addPhoto(file) {
  if (!state.group || !file || photoBusy) return;
  if (file.type && !/^image\//.test(file.type)) { toast('写真（画像）を選んでください'); return; }
  photoBusy = true; toast('写真を読みこんでいます…');
  try {
    let r;
    try { r = await compressImage(file); } catch (e) { r = null; }
    if (!r) { toast('この写真は読みこめませんでした'); return; }
    const id = rid();
    const ok = await write('images/' + id, 'set', { data: r.data, by: uid, w: r.w, h: r.h, at: Date.now() });
    if (!ok) { toast(isLocal ? 'お試しモードでは、写真は少ししか入れられません' : '写真を保存できませんでした'); return; }
    const c = { el: null }; c.p = loadImg(r.data).then(el => (c.el = el)); imgCache.set(id, c); await c.p;
    const sc = Math.min(560 / r.w, 420 / r.h);
    const w = r1(r.w * sc), h = r1(r.h * sc);
    const jitter = (Math.random() - 0.5) * 60;
    const iid = addItem({ type: 'image', x: r1((W - w) / 2 + jitter), y: r1((H - h) / 2 + jitter), w, h, img: id });
    setTool('select'); select(iid);
    toast('写真を入れました');
  } finally { photoBusy = false; }
}

/* ================= drawing a frame to canvas ================= */
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
function wrapLines(g, text, maxW) {
  const out = [];
  String(text || '').split('\n').forEach(par => {
    let line = '';
    for (const ch of par) { if (g.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch; }
    out.push(line);
  });
  return out;
}
async function drawFrame(entries, bg, S2) {
  const c = document.createElement('canvas'); c.width = W * S2; c.height = H * S2;
  const g = c.getContext('2d'); g.scale(S2, S2);
  g.fillStyle = '#FCFCF9'; g.fillRect(0, 0, W, H);
  if (BG_SVG[bg]) { try { const img = await loadImg(bgData(bg)); g.fillStyle = g.createPattern(img, 'repeat'); g.fillRect(0, 0, W, H); } catch (e) {} }
  try { await document.fonts.load('400 30px "BIZ UDPGothic"'); } catch (e) {}
  const list = entries.map(([k, v]) => [k, decodeItem(v) || v]).filter(([, it]) => isObj(it)).sort((a, b) => (a[1].z || 0) - (b[1].z || 0));
  for (const [, it] of list) {
    const x = +it.x || 0, y = +it.y || 0;
    g.save();
    if (it.type === 'ink' && validInk(it)) {
      g.translate(x, y); g.globalAlpha = clamp(+it.a || 1, 0.05, 1);
      if ((it.a || 1) < 1) g.globalCompositeOperation = 'multiply';
      g.strokeStyle = String(it.color || '#222'); g.lineWidth = clamp(+it.w || 4, 1, 60); g.lineCap = 'round'; g.lineJoin = 'round';
      g.stroke(new Path2D(pathD(it.pts)));
    } else if (it.type === 'note') {
      const w = clamp(+it.w || 240, 20, 1600), h = clamp(+it.h || 240, 20, 900);
      g.shadowColor = 'rgba(0,0,0,.18)'; g.shadowBlur = 16; g.shadowOffsetY = 5;
      g.fillStyle = String(it.color || '#FFE97A'); g.fillRect(x, y, w, h); g.shadowColor = 'transparent';
      let s = 40, lines;
      for (;;) { g.font = '400 ' + s + 'px ' + UDFONT; lines = wrapLines(g, it.text, w - 36); if (lines.length * s * 1.35 <= h - 36 || s <= 12) break; s -= 2; }
      g.fillStyle = '#262626'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const lh = s * 1.35; let ty = y + h / 2 - (lines.length - 1) * lh / 2;
      g.beginPath(); g.rect(x, y, w, h); g.clip();
      lines.forEach(l => { g.fillText(l, x + w / 2, ty); ty += lh; });
    } else if (it.type === 'image' && typeof it.img === 'string') {
      const w = clamp(+it.w || 200, 10, 1600), h = clamp(+it.h || 150, 10, 900);
      const im = await getImg(it.img);
      g.shadowColor = 'rgba(0,0,0,.18)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
      g.fillStyle = '#E5E7EB'; g.fillRect(x, y, w, h); g.shadowColor = 'transparent';
      if (im) {
        const s2 = Math.max(w / im.naturalWidth, h / im.naturalHeight), sw = w / s2, sh = h / s2;
        g.drawImage(im, (im.naturalWidth - sw) / 2, (im.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
      }
    } else if (it.type === 'text') {
      const fs = clamp(+it.fs || 36, 8, 200), w = clamp(+it.w || 420, 40, 1600);
      g.font = '400 ' + fs + 'px ' + UDFONT; g.fillStyle = String(it.color || '#222');
      g.textBaseline = 'top'; const lh = fs * 1.4;
      wrapLines(g, it.text, w - 16).forEach((l, k) => g.fillText(l, x + 8, y + 4 + (lh - fs) / 2 + k * lh));
    }
    g.restore();
  }
  return c;
}
async function saveCanvas(canvas, name) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  if (!blob) { toast('画像を作れませんでした'); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name.replace(/[\\/:*?"<>|#]/g, '').slice(0, 60) + '.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('画像を保存しました');
}
async function exportPNG() {
  stopEdit();
  const f = curFrame();
  const c = await drawFrame([...state.items.entries()], f && f.bg, 2);
  const n = state.frames.findIndex(x => x.id === state.frameId) + 1;
  saveCanvas(c, (state.title || 'ボード') + '-' + gName(state.group) + '-フレーム' + n);
}

/* ================= submissions ================= */
let myIndex = [], allSubs = [], subBusy = false;
async function submitFrame() {
  if (!uid || !state.group || subBusy) return;
  stopEdit();
  if (!state.items.size) { toast('このフレームはまだ何も書かれていません'); return; }
  const n = state.frames.findIndex(x => x.id === state.frameId) + 1;
  const ok = await confirmBox(gName(state.group) + 'のフレーム ' + n + ' を先生に提出します。提出したあとにボードを書きかえても、提出した物は変わりません。', '提出する', true);
  if (!ok) return;
  subBusy = true; $('submitBtn').disabled = true;
  const sid = rid(), at = Date.now();
  const items = {}; state.items.forEach((v, k) => { items[k] = encodeItem(v); });
  const name = state.teacher ? '先生' : state.myName;
  const okData = await write('subData/' + sid, 'set', { uid, name, g: state.group, fn: n, at, title: state.title || '', bg: (curFrame() && curFrame().bg) || 'plain', items });
  const okIdx = okData && await write('subIndex/' + uid + '/' + sid, 'set', { name, g: state.group, fn: n, at });
  toast(okIdx ? '先生に提出しました' : '提出できませんでした。通信を確かめて、もう一度ためしてください');
  subBusy = false; $('submitBtn').disabled = false;
}
const seenKey = 'wb-seen';
function getSeen() { try { return JSON.parse(localStorage.getItem(seenKey) || '{}') || {}; } catch (e) { return {}; } }
function updateMineBadge() {
  const seen = getSeen();
  const n = myIndex.filter(x => x.rv && (x.rv.ok || x.rv.m) && seen[x.sid] !== (x.rv.at || 1)).length;
  $('mineBadge').hidden = !n; $('mineBadge').textContent = n;
}
function subscribeMine() {
  sessionUnsubs.push(S.onValue('subIndex/' + uid, v => {
    myIndex = isObj(v) ? Object.keys(v).filter(k => isObj(v[k])).map(k => Object.assign({ sid: k, uid }, v[k])).sort((a, b) => (b.at || 0) - (a.at || 0)) : [];
    updateMineBadge();
    if (!$('sModal').hidden && $('sModal').dataset.mode === 'mine') renderSubList();
  }, () => {}));
}
function subscribeInbox() {
  sessionUnsubs.push(S.onValue('subIndex', v => {
    const out = [];
    if (isObj(v)) for (const u in v) { const m = v[u]; if (!isObj(m)) continue; for (const sid in m) if (isObj(m[sid])) out.push(Object.assign({ uid: u, sid }, m[sid])); }
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    allSubs = out;
    const nNew = out.filter(x => !(x.rv && x.rv.ok)).length;
    $('inboxBadge').hidden = !nNew; $('inboxBadge').textContent = nNew;
    if (!$('sModal').hidden) renderSubList();
  }, () => {}));
}
function openSubs(mode) {
  const m = $('sModal'); m.dataset.mode = mode;
  $('sTitle').textContent = mode === 'inbox' ? '提出箱' : '提出した物';
  $('sSub').textContent = mode === 'inbox'
    ? '生徒が提出したフレームです。開くと、確認済みの印と、ひとことを返せます。'
    : '自分が先生に提出したフレームです。先生からの返事もここに届きます。';
  $('sFilters').hidden = mode !== 'inbox';
  const fg = $('fGroup'); const keep = fg.value; fg.textContent = '';
  const o0 = document.createElement('option'); o0.value = 'all'; o0.textContent = 'すべての班'; fg.appendChild(o0);
  state.groups.forEach(g => { const o = document.createElement('option'); o.value = g.id; o.textContent = g.name; fg.appendChild(o); });
  if (keep) fg.value = keep; if (!fg.value) fg.value = 'all';
  renderSubList();
  m.hidden = false;
}
function renderSubList() {
  const mode = $('sModal').dataset.mode, box = $('sList'); box.textContent = '';
  let rows;
  if (mode === 'inbox') {
    const fg = $('fGroup').value || 'all', fs = $('fState').value;
    rows = allSubs.filter(x => (fg === 'all' || x.g === fg) && (fs === 'all' || (fs === 'ok' ? x.rv && x.rv.ok : !(x.rv && x.rv.ok))));
  } else rows = myIndex;
  if (!rows.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = mode === 'inbox' ? 'まだ提出はありません。生徒が下の「先生に提出」を押すと、ここに届きます。' : 'まだ提出していません。ボードの下の「先生に提出」から送れます。';
    box.appendChild(e); return;
  }
  rows.forEach(x => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'subrow';
    const g = document.createElement('span'); g.className = 'g'; g.textContent = gName(x.g);
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = mode === 'inbox' ? (String(x.name || '') || '名前なし') : 'フレーム ' + (x.fn || '?');
    const st = document.createElement('span'); st.className = 'st';
    const tag = document.createElement('span'); tag.className = 'tag' + (x.rv && x.rv.ok ? ' ok' : '');
    tag.textContent = x.rv && x.rv.ok ? '確認済み' : (mode === 'inbox' ? '未確認' : '提出済み');
    st.appendChild(tag);
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = (mode === 'inbox' ? 'フレーム ' + (x.fn || '?') + '・' : '') + fmtTime(x.at);
    b.append(g, who, st, meta);
    if (x.rv && x.rv.m) { const c = document.createElement('span'); c.className = 'c'; c.textContent = (mode === 'inbox' ? 'ひとこと：' : '先生より：') + x.rv.m; b.appendChild(c); }
    b.onclick = () => openViewer(x, mode);
    box.appendChild(b);
  });
}
let viewing = null;
async function openViewer(x, mode) {
  viewing = { x, mode, data: null };
  const m = $('vModal');
  $('vImg').removeAttribute('src');
  $('vTitle').textContent = gName(x.g) + '・フレーム ' + (x.fn || '?');
  const info = $('vInfo'); info.textContent = '';
  const add = (k, v) => { const s = document.createElement('span'); s.textContent = k + '：'; const b = document.createElement('b'); b.textContent = v; s.appendChild(b); info.appendChild(s); };
  if (mode === 'inbox') add('提出した人', String(x.name || '名前なし'));
  add('提出', fmtTime(x.at));
  const teacherView = mode === 'inbox';
  $('vReview').hidden = !teacherView; $('vReviewSave').hidden = !teacherView;
  $('vOk').checked = !!(x.rv && x.rv.ok); $('vCmt').value = (x.rv && x.rv.m) || '';
  const from = $('vFrom'); from.textContent = '';
  if (!teacherView && x.rv && (x.rv.ok || x.rv.m)) {
    const d = document.createElement('div'); d.className = 'fromt';
    const b = document.createElement('b'); b.textContent = x.rv.ok ? '先生が確認しました' : '先生より'; d.appendChild(b);
    if (x.rv.m) d.appendChild(document.createTextNode(x.rv.m));
    from.appendChild(d);
    const seen = getSeen(); seen[x.sid] = x.rv.at || 1; try { localStorage.setItem(seenKey, JSON.stringify(seen)); } catch (e) {}
    updateMineBadge();
  }
  m.hidden = false;
  try {
    const d = await S.get('subData/' + x.sid);
    if (!viewing || viewing.x !== x) return;
    if (!isObj(d)) { toast('提出物を読み込めませんでした'); return; }
    viewing.data = d;
    const c = await drawFrame(isObj(d.items) ? Object.entries(d.items) : [], d.bg, 1);
    if (!viewing || viewing.x !== x) return;
    $('vImg').src = c.toDataURL('image/png');
  } catch (e) { toast('提出物を読み込めませんでした'); }
}
async function saveReview() {
  if (!viewing || viewing.mode !== 'inbox') return;
  const x = viewing.x;
  const rv = { ok: $('vOk').checked, m: $('vCmt').value.trim().slice(0, 400), at: Date.now() };
  const ok = await write('subIndex/' + x.uid + '/' + x.sid + '/rv', 'set', rv);
  if (ok) { toast('返事を保存しました'); $('vModal').hidden = true; viewing = null; }
}
async function saveViewed() {
  if (!viewing || !viewing.data) return;
  const d = viewing.data, x = viewing.x;
  const c = await drawFrame(isObj(d.items) ? Object.entries(d.items) : [], d.bg, 2);
  saveCanvas(c, gName(x.g) + '-' + (viewing.mode === 'inbox' ? String(x.name || '提出') : '提出') + '-フレーム' + (x.fn || ''));
}

/* ================= presence ================= */
let presObj = {}, presTimer = 0, presLast = 0, presPath = null;
function myColor() { return colorFor(uid); }
function presence(patch) {
  Object.assign(presObj, patch);
  if (!presPath || presTimer) return;
  const wait = Math.max(0, 180 - (Date.now() - presLast));
  presTimer = setTimeout(() => {
    presTimer = 0; presLast = Date.now();
    if (!presPath) return;
    const o = Object.assign({ name: state.teacher ? '先生' : (state.myName || ''), col: myColor(), t: Date.now() }, presObj);
    for (const k in o) if (o[k] == null) delete o[k];
    S.write(presPath, 'set', o).catch(() => {});
  }, wait);
}
function joinPresence() {
  if (!S || !uid || !state.group || isLocal) { renderPeople(); return; }
  presPath = 'presence/' + state.group + '/' + uid;
  S.onDisconnectRemove(presPath);
  presObj = { f: state.frameId };
  presence({});
  const map = new Map();
  const g = state.group;
  const push = () => { if (state.group !== g) return; peers = [...map.entries()].map(([k, v]) => ({ peer: k, isMe: k === uid, presence: v })); onPeers(); };
  unsubPres = S.onChildren('presence/' + g, {
    add: (k, v) => { if (isObj(v)) map.set(k, v); push(); },
    change: (k, v) => { if (isObj(v)) map.set(k, v); push(); },
    remove: k => { map.delete(k); push(); }
  }, () => {});
}
function leavePresence() {
  if (unsubPres) { unsubPres(); unsubPres = null; }
  if (presPath && S) { S.write(presPath, 'remove').catch(() => {}); }
  presPath = null; peers = []; renderCursors(); renderPeople();
}
const curEls = new Map();
function renderCursors() {
  const box = $('cursors'), seen = new Set(), inv = 1 / state.scale;
  peers.forEach(p => {
    if (p.isMe) return;
    const pr = p.presence || {};
    if (pr.f !== state.frameId || !Array.isArray(pr.c)) return;
    const x = +pr.c[0], y = +pr.c[1]; if (!isFinite(x) || !isFinite(y)) return;
    seen.add(p.peer);
    let el = curEls.get(p.peer);
    if (!el) {
      el = document.createElement('div'); el.className = 'cursor';
      el.innerHTML = '<svg viewBox="0 0 22 22"><path d="M3 2l15 8-6.5 1.6L8.5 18z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><b></b>';
      box.appendChild(el); curEls.set(p.peer, el);
    }
    const col = typeof pr.col === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(pr.col) ? pr.col : '#5D6778';
    el.querySelector('path').setAttribute('fill', col);
    const b = el.querySelector('b'); b.style.background = col;
    b.textContent = String(pr.name || 'だれか').slice(0, 20);
    el.classList.toggle('laser', !!pr.l);
    el.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + inv + ')';
    if (pr.l) { let tr = peerTrails.get(p.peer); if (!tr) { tr = []; peerTrails.set(p.peer, tr); } const last = tr[tr.length - 1]; if (!last || last.x !== x || last.y !== y) pushTrail(tr, { x, y }); }
  });
  for (const [k, el] of curEls) if (!seen.has(k)) { el.remove(); curEls.delete(k); peerTrails.delete(k); }
}
function renderPeople() {
  const box = $('people');
  const list = peers.slice().sort((a, b) => (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0));
  if (!presPath || !list.length) { box.hidden = true; return; }
  const av = $('avatars'); av.textContent = '';
  list.slice(0, 6).forEach(p => {
    const pr = p.presence || {};
    const nm = String(pr.name || 'だれか').slice(0, 20);
    const el = document.createElement('span');
    el.textContent = nm.slice(0, 1);
    el.style.background = typeof pr.col === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(pr.col) ? pr.col : '#5D6778';
    el.title = p.isMe ? nm + '（あなた）' : nm;
    if (p.isMe) el.className = 'me';
    av.appendChild(el);
  });
  $('pcount').textContent = gName(state.group) + 'に' + list.length + '人';
  box.hidden = false;
}
let lastPeerCount = -1;
function onPeers() {
  const active = new Set();
  peers.forEach(p => {
    if (p.isMe) return;
    const pr = p.presence || {};
    if (pr.f === state.frameId && isObj(pr.d) && typeof pr.d.id === 'string' && isFinite(pr.d.x) && isFinite(pr.d.y)) {
      active.add(pr.d.id); peerDrag.set(pr.d.id, { x: +pr.d.x, y: +pr.d.y, col: pr.col });
    }
  });
  for (const [k, o] of peerDrag) if (!active.has(k) && !o.released) {
    o.released = true; setTimeout(() => { if (peerDrag.get(k) === o) { peerDrag.delete(k); scheduleRender(); } }, 1500);
  }
  scheduleRender(); renderFrames(); renderCursors();
  if (peers.length !== lastPeerCount) { lastPeerCount = peers.length; renderPeople(); }
  else renderPeople();
}

/* ================= teacher (合言葉) ================= */
let tMode = 'enter';
const T_MSG = {
  enter: 'このルームの「先生の合言葉」を入れると、先生として入れます。先生は何人いても大丈夫です。すべての班のボードと提出箱が使えるようになります。',
  teacher: '先生として入っています。ほかの先生も、同じ合言葉を入れれば先生になれます。「生徒にもどる」で、この端末をふつうの参加者にもどせます。',
  change: '新しい合言葉を決めます。変えると、ほかの先生は新しい合言葉で入り直すことになります（生徒に知られてしまったときなどに使ってください）。',
  trial: 'お試しモードでは、合言葉なしで先生と生徒を切りかえられます。本番では、先生の合言葉を入れた人だけが先生になれます。'
};
function setTMode(m) {
  tMode = m;
  $('tEnter').hidden = m !== 'enter';
  $('tSetup').hidden = m !== 'change';
  $('tStudent').hidden = !(m === 'teacher');
  $('tChange').hidden = !(m === 'teacher') || isLocal;
  $('tGo').hidden = m === 'teacher';
  $('tGo').textContent = { enter: '先生として入る', change: '合言葉を変える', trial: '先生として入る' }[m] || '';
  $('tTitle').textContent = (m === 'teacher' || m === 'change') ? '先生モード' : '先生用';
  $('tMsg').textContent = T_MSG[m];
  $('tErr').hidden = true;
}
async function openTeacher() {
  ['tCode', 'tNew', 'tNew2'].forEach(k => $(k).value = '');
  if (state.teacher) setTMode('teacher');
  else if (isLocal) setTMode('trial');
  else setTMode('enter');
  $('tModal').hidden = false;
  const f = !$('tEnter').hidden ? $('tCode') : (!$('tSetup').hidden ? $('tNew') : null);
  if (f) setTimeout(() => f.focus(), 50);
}
const tryWrite = (p, op, d) => S.write(p, op, d).then(() => true, () => false);
async function teacherGo() {
  const err = t => { $('tErr').textContent = t; $('tErr').hidden = false; };
  $('tGo').disabled = true;
  try {
    if (tMode === 'trial') {
      try { localStorage.setItem('wb-trial-role:' + state.room, 'teacher'); } catch (e) {}
      $('tModal').hidden = true; toast('先生として入りました'); startSession(); return;
    }
    if (tMode === 'enter') {
      const c = $('tCode').value.trim();
      if (!c) return err('合言葉を入れてください');
      if (!(await tryWrite('teachers/' + uid, 'set', c))) return err('合言葉がちがいます');
      $('tModal').hidden = true; toast('先生として入りました'); startSession(); return;
    }
    if (tMode === 'change') {
      const a = $('tNew').value.trim(), b = $('tNew2').value.trim();
      if (a.length < 6) return err('合言葉は6文字以上にしてください');
      if (a !== b) return err('2つの合言葉が同じではありません');
      if (!(await tryWrite('secret/teacherCode', 'set', a))) return err('合言葉を変えられませんでした');
      await tryWrite('teachers/' + uid, 'set', a);
      $('tModal').hidden = true;
      toast('合言葉を変えました。ほかの先生は入り直してください');
      startSession();
    }
  } finally { $('tGo').disabled = false; }
}
async function backToStudent() {
  if (isLocal) { try { localStorage.setItem('wb-trial-role:' + state.room, 'student'); } catch (e) {} }
  else await tryWrite('teachers/' + uid, 'remove');
  $('tModal').hidden = true; toast('生徒にもどりました'); startSession();
}
function closeTeacher() {
  $('tModal').hidden = true;
  if (state.room && !state.group && !state.teacher && started && S) openWelcome(GID.test(location.hash.slice(1)) ? location.hash.slice(1) : null);
}

/* ================= compare groups ================= */
const panes = [];
function canCompare() { return state.teacher || state.share; }
function updateCmpBtn() {
  $('cmpBtn').hidden = !S || !started || !canCompare() || (!state.teacher && !state.group);
  if (!$('cModal').hidden && !canCompare()) { closeCompare(); toast('先生が「生徒にも見せる」をオフにしました'); }
  if (!$('cModal').hidden) { $('cShare').checked = state.share; refreshPaneMsgs(); }
}
function openCompare() {
  if (!canCompare()) return;
  stopEdit();
  $('cShareWrap').hidden = !state.teacher;
  $('cShare').checked = state.share;
  $('cSub').textContent = state.teacher
    ? '班のボードを並べて見られます。見るだけの画面です。「開く」を押すと、その班のボードに移って書きこめます。'
    : '班のボードを並べて見られます。見るだけの画面です。書きこむときは、閉じて自分の班のボードにもどってください。';
  if (!panes.length) {
    const ids = state.groups.map(g => g.id);
    const first = state.group && ids.includes(state.group) ? state.group : ids[0];
    const second = ids.find(id => id !== first);
    addPane(first); if (second) addPane(second);
  }
  $('cModal').hidden = false;
}
function closeCompare() {
  $('cModal').hidden = true;
  while (panes.length) removePane(panes[0]);
}
function addPane(g) {
  if (panes.length >= 4) { toast('ならべられるのは4つまでです'); return; }
  if (!g) { const used = new Set(panes.map(p => p.g)); g = (state.groups.find(x => !used.has(x.id)) || state.groups[0]).id; }
  const p = { g, f: null, frames: [], items: new Map(), timer: 0, unsubF: null, unsubI: null, denied: false };
  const el = document.createElement('div'); el.className = 'pane';
  const ph = document.createElement('div'); ph.className = 'ph';
  const gs = document.createElement('select'); gs.setAttribute('aria-label', '班');
  state.groups.forEach(x => { const o = document.createElement('option'); o.value = x.id; o.textContent = x.name; gs.appendChild(o); });
  gs.value = g;
  const fs = document.createElement('select'); fs.setAttribute('aria-label', 'フレーム');
  const sp = document.createElement('span'); sp.className = 'sp';
  const live = document.createElement('span'); live.className = 'live'; live.textContent = '自動で更新';
  const open = document.createElement('button'); open.type = 'button'; open.className = 'txtbtn'; open.textContent = '開く';
  const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'txtbtn'; rm.textContent = '外す';
  ph.append(gs, fs, sp, live, open, rm);
  const cv = document.createElement('div'); cv.className = 'cv';
  const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = '読み込み中…';
  cv.appendChild(msg);
  el.append(ph, cv);
  $('panes').appendChild(el);
  Object.assign(p, { el, gs, fs, cv, msg, open, rm });
  gs.onchange = () => { p.g = gs.value; p.f = null; paneSubscribe(p); };
  fs.onchange = () => { p.f = fs.value; paneItems(p); };
  rm.onclick = () => removePane(p);
  open.onclick = async () => {
    const g2 = p.g, f2 = p.f;
    if (!state.teacher && g2 !== state.group) return;
    closeCompare();
    if (await setGroup(g2)) { if (f2 && state.frames.find(x => x.id === f2)) goFrame(f2); }
  };
  panes.push(p);
  paneSubscribe(p);
  refreshPaneMsgs();
}
function removePane(p) {
  if (p.unsubF) p.unsubF(); if (p.unsubI) p.unsubI(); clearTimeout(p.timer);
  p.el.remove(); panes.splice(panes.indexOf(p), 1);
  refreshPaneMsgs();
}
function refreshPaneMsgs() {
  panes.forEach(p => {
    p.open.hidden = !(state.teacher || p.g === state.group);
    p.rm.hidden = panes.length <= 1;
  });
  $('cAdd').disabled = panes.length >= 4;
}
function paneSubscribe(p) {
  if (p.unsubF) { p.unsubF(); p.unsubF = null; }
  if (p.unsubI) { p.unsubI(); p.unsubI = null; }
  p.items = new Map(); p.denied = false; p.msg.hidden = false; p.msg.textContent = '読み込み中…';
  refreshPaneMsgs();
  const g = p.g;
  p.unsubF = S.onValue('groups/' + g + '/frames', v => {
    if (p.g !== g) return;
    let fr = isObj(v) ? Object.keys(v).filter(k => isObj(v[k])).map(k => Object.assign({ id: k }, v[k])) : [];
    if (!fr.length) fr = [{ id: 'f1', order: 0, bg: 'plain' }];
    fr.sort((a, b) => (a.order || 0) - (b.order || 0));
    p.frames = fr;
    p.fs.textContent = '';
    fr.forEach((f, i) => { const o = document.createElement('option'); o.value = f.id; o.textContent = 'フレーム ' + (i + 1); p.fs.appendChild(o); });
    const keep = p.f && fr.find(f => f.id === p.f);
    if (!keep) p.f = fr[0].id;
    p.fs.value = p.f;
    if (!keep || !p.unsubI) paneItems(p); else paneDraw(p);
  }, e => paneDenied(p, e));
}
function paneDenied(p, e) {
  p.denied = true; p.msg.hidden = false;
  p.msg.textContent = isDenied(e)
    ? (state.teacher ? 'この班のボードを読めませんでした' : 'ほかの班のボードは、先生が「生徒にも見せる」をオンにすると見られます')
    : '読み込めませんでした';
}
function paneItems(p) {
  if (p.unsubI) { p.unsubI(); p.unsubI = null; }
  p.items = new Map();
  const g = p.g, f = p.f;
  p.unsubI = S.onChildren('groups/' + g + '/items/' + f, {
    add: (k, v) => { if (p.g === g && p.f === f) { p.items.set(k, v); paneDraw(p); } },
    change: (k, v) => { if (p.g === g && p.f === f) { p.items.set(k, v); paneDraw(p); } },
    remove: k => { if (p.g === g && p.f === f) { p.items.delete(k); paneDraw(p); } }
  }, e => paneDenied(p, e));
  paneDraw(p);
}
function paneDraw(p) {
  clearTimeout(p.timer);
  p.timer = setTimeout(async () => {
    if (!panes.includes(p)) return;
    const fr = p.frames.find(x => x.id === p.f);
    const c = await drawFrame([...p.items.entries()], fr && fr.bg, 1);
    if (!panes.includes(p) || p.denied) return;
    const old = p.cv.querySelector('canvas'); if (old) old.remove();
    p.cv.insertBefore(c, p.msg);
    p.msg.hidden = p.items.size > 0;
    if (!p.items.size) p.msg.textContent = 'まだ何も書かれていません';
  }, 250);
}

/* ================= session ================= */
function resetSession() {
  sessionUnsubs.forEach(f => { try { f(); } catch (e) {} }); sessionUnsubs = [];
  leavePresence();
  if (unsubFrames) { unsubFrames(); unsubFrames = null; }
  if (unsubItems) { unsubItems(); unsubItems = null; }
  state.group = null; state.teacher = false; state.myGroup = null; state.myName = '';
  state.items = new Map(); renderItems();
  board.classList.add('nogroup');
  ['inboxBtn', 'mineBtn', 'submitBtn', 'cmpBtn'].forEach(k => $(k).hidden = true);
  closeCompare(); state.share = false;
  ['modal', 'wModal', 'gModal', 'sModal', 'vModal', 'cModal'].forEach(k => $(k).hidden = true);
  myIndex = []; allSubs = []; imgCache.clear();
  state.title = ''; titleEl.value = '';
  undoStack.length = 0; $('undoBtn').disabled = true;
}
async function startSession() {
  resetSession();
  started = true; setStatus();
  // 先生かどうか（合言葉が合っている人だけが secret を読める）
  if (isLocal) { let r = 'teacher'; try { r = localStorage.getItem('wb-trial-role:' + state.room) || 'teacher'; } catch (e) {} state.teacher = r === 'teacher'; }
  else { try { const c = await S.get('secret/teacherCode'); state.teacher = typeof c === 'string' && c.length > 0; } catch (e) { state.teacher = false; } }
  $('tBtn').textContent = state.teacher ? '先生モード' : '先生用はこちら';
  titleEl.readOnly = !state.teacher;
  titleEl.placeholder = state.roomName || '無題のボード';
  $('rmDelete').hidden = !state.teacher;
  // ボード名・班の設定
  sessionUnsubs.push(S.onValue('meta/board', v => {
    state.title = isObj(v) && typeof v.title === 'string' ? v.title : '';
    if (document.activeElement !== titleEl) titleEl.value = state.title;
  }, () => {}));
  sessionUnsubs.push(S.onValue('meta/share', v => { state.share = v === true; updateCmpBtn(); }, () => {}));
  let groupsReady; const groupsLoaded = new Promise(r => { groupsReady = r; });
  sessionUnsubs.push(S.onValue('meta/groups', v => {
    const list = isObj(v) ? asList(v.list).filter(g => isObj(g) && GID.test(g.id)).map(g => ({ id: g.id, name: String(g.name || '').slice(0, 12) || g.id.slice(1) + '班' })) : [];
    state.groups = list.length ? list : defaultGroups(6);
    state.lock = !!(isObj(v) && v.lock);
    renderGroupBtn(); setHint();
    groupsReady();
  }, () => groupsReady()));
  await Promise.race([groupsLoaded, new Promise(r => setTimeout(r, 4000))]);

  const hashG = GID.test(location.hash.slice(1)) ? location.hash.slice(1) : null;
  if (state.teacher) {
    let saved = null; try { saved = localStorage.getItem('wb-teacher-group'); } catch (e) {}
    const g = hashG || (GID.test(saved || '') ? saved : null) || state.groups[0].id;
    await setGroup(g);
    $('inboxBtn').hidden = false; subscribeInbox();
  } else {
    let prof = null;
    try { prof = await S.get('users/' + uid); } catch (e) {}
    if (isObj(prof) && typeof prof.name === 'string' && GID.test(prof.group || '')) {
      state.myName = prof.name; state.myGroup = prof.group;
      let g = prof.group;
      if (hashG && hashG !== g && !state.lock) g = hashG;
      if (!(await setGroup(g))) await setGroup(prof.group);
    } else {
      setHint();
      if (!pendingTeacherOpen) openWelcome(hashG);
    }
    $('mineBtn').hidden = false; subscribeMine();
  }
  $('submitBtn').hidden = false;
  setStatus(); updateCmpBtn();
  if (pendingTeacherOpen) { pendingTeacherOpen = false; if (!state.teacher) openTeacher(); }
}

/* ================= rooms ================= */
const normRoom = v => String(v || '').normalize('NFKC').trim().replace(/\s+/g, '').toLowerCase();
const roomOk = c => c.length >= 3 && c.length <= 20 && !/[.#$\[\]\/]/.test(c);
function recentRooms() { try { const v = JSON.parse(localStorage.getItem('wb-rooms') || '[]'); return Array.isArray(v) ? v.filter(x => x && typeof x.code === 'string') : []; } catch (e) { return []; } }
function rememberRoom(code, name) {
  const list = [{ code, name, at: Date.now() }, ...recentRooms().filter(x => x.code !== code)].slice(0, 8);
  try { localStorage.setItem('wb-rooms', JSON.stringify(list)); } catch (e) {}
}
function forgetRoom(code) { try { localStorage.setItem('wb-rooms', JSON.stringify(recentRooms().filter(x => x.code !== code))); } catch (e) {} }
function roomLink(code) { return location.origin + location.pathname + '?r=' + encodeURIComponent(code); }
function setUrlRoom(code) {
  try { history.replaceState(null, '', code ? '?r=' + encodeURIComponent(code) + location.hash : location.pathname); } catch (e) {}
}
function renderRoomBtn() {
  $('roomBtn').hidden = !state.room;
  $('tBtn').hidden = !state.room;
  $('grpBtn').hidden = !state.room;
  $('roomName').textContent = state.roomName || state.room || '';
}
function openLobby(msg) {
  $('lbErr').hidden = !msg; if (msg) $('lbErr').textContent = msg;
  $('mkErr').hidden = true;
  const rec = recentRooms(), box = $('recent'); box.textContent = '';
  rec.forEach(r => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'txtbtn';
    b.textContent = (r.name || r.code) + '（' + r.code + '）';
    b.onclick = () => tryJoin(r.code);
    box.appendChild(b);
  });
  $('recentWrap').hidden = !rec.length;
  $('hintMain').textContent = 'ルームに入ってください'; $('hintSub').textContent = '';
  $('lobbyModal').hidden = false;
  setTimeout(() => $('joinCode').focus(), 50);
}
async function tryJoin(code) {
  $('joinBtn').disabled = true;
  const r = await joinRoom(code);
  $('joinBtn').disabled = false;
  if (r === 'invalid') openLobby('合言葉は3〜20文字で入れてください');
  else if (r === 'missing') { openLobby('そのルームは見つかりません。合言葉を確かめてください'); }
  else if (r === 'error') openLobby('つながりませんでした。通信を確かめて、もう一度おしてください');
}
async function joinRoom(raw) {
  const code = normRoom(raw);
  if (!roomOk(code)) return 'invalid';
  let info = null;
  try { info = await baseS.get('rooms/' + code + '/info'); } catch (e) { return 'error'; }
  if (!isObj(info)) return 'missing';
  if (state.room && state.room !== code) resetSession();
  state.room = code; state.roomName = String(info.name || '').slice(0, 40) || code;
  rememberRoom(code, state.roomName);
  setUrlRoom(code);
  renderRoomBtn();
  $('lobbyModal').hidden = true;
  await startSession();
  return 'ok';
}
async function createRoom() {
  const err = t => { $('mkErr').textContent = t; $('mkErr').hidden = false; };
  $('mkErr').hidden = true;
  const name = $('rName').value.trim().slice(0, 40);
  const code = normRoom($('rCode').value);
  const a = $('rT1').value.trim(), b = $('rT2').value.trim();
  if (!name) return err('ルームの名前を入れてください');
  if (!roomOk(code)) return err('ルームの合言葉は3〜20文字にしてください（「. # $ [ ] /」は使えません）');
  if (a.length < 6) return err('先生の合言葉は6文字以上にしてください');
  if (a !== b) return err('2つの先生の合言葉が同じではありません');
  if (a === code) return err('先生の合言葉は、ルームの合言葉とちがうものにしてください');
  $('mkBtn').disabled = true;
  try {
    let exists = null;
    try { exists = await baseS.get('rooms/' + code + '/info'); } catch (e) { return err('つながりませんでした。通信を確かめてください'); }
    if (exists) return err('その合言葉は、もう使われています。ほかの合言葉にしてください');
    const w = (p, d) => baseS.write('rooms/' + code + '/' + p, 'set', d).then(() => true, () => false);
    if (!(await w('secret/teacherCode', a))) return err('その合言葉は、もう使われています。ほかの合言葉にしてください');
    await w('teachers/' + uid, a);
    if (!(await w('info', { name, at: Date.now() }))) return err('ルームを作れませんでした');
    if (isLocal) { try { localStorage.setItem('wb-trial-role:' + code, 'teacher'); } catch (e) {} }
    ['rName', 'rCode', 'rT1', 'rT2'].forEach(k => $(k).value = '');
    $('mkBox').open = false;
    const r = await joinRoom(code);
    if (r === 'ok') { toast('ルーム「' + name + '」を作りました'); openRoomInfo(); }
  } finally { $('mkBtn').disabled = false; }
}
function autoCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let c = ''; const r = new Uint32Array(6); crypto.getRandomValues(r);
  r.forEach(n => { c += chars[n % chars.length]; });
  $('rCode').value = c;
}
function openRoomInfo() {
  if (!state.room) return;
  $('rmTitle').textContent = state.roomName || 'ルーム';
  $('rmCode').textContent = state.room;
  $('rmLink').value = roomLink(state.room);
  $('rmDelete').hidden = !state.teacher;
  $('rmModal').hidden = false;
}
async function copyLink() {
  const v = $('rmLink').value;
  try { await navigator.clipboard.writeText(v); toast('リンクをコピーしました'); }
  catch (e) { $('rmLink').focus(); $('rmLink').select(); toast('選んだリンクをコピーしてください'); }
}
function leaveRoom() {
  $('rmModal').hidden = true;
  resetSession();
  state.room = null; state.roomName = '';
  renderRoomBtn(); renderGroupBtn();
  setUrlRoom(null);
  openLobby();
}
async function deleteRoom() {
  if (!state.teacher || !state.room) return;
  $('rmModal').hidden = true;
  const ok = await confirmBox('ルーム「' + state.roomName + '」を消します。すべての班のボード・写真・提出物が消え、元に戻せません。', 'ルームを消す');
  if (!ok) return;
  const code = state.room;
  resetSession();
  const done = await baseS.write('rooms/' + code, 'remove').then(() => true, () => false);
  if (done) { forgetRoom(code); toast('ルームを消しました'); }
  else toast('ルームを消せませんでした');
  state.room = null; state.roomName = ''; renderRoomBtn(); renderGroupBtn(); setUrlRoom(null);
  openLobby();
}
async function enterFromUrl() {
  const q = new URLSearchParams(location.search).get('r');
  if (q) { const r = await joinRoom(q); if (r !== 'ok') openLobby(r === 'missing' ? 'そのルームは見つかりません。合言葉を確かめてください' : r === 'error' ? 'つながりませんでした。通信を確かめてください' : null); }
  else openLobby();
}

/* ================= wiring ================= */
function bindUI() {
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('undoBtn').onclick = undo;
  $('prevF').onclick = () => { const i = state.frames.findIndex(f => f.id === state.frameId); if (i > 0) goFrame(state.frames[i - 1].id); };
  $('nextF').onclick = () => { const i = state.frames.findIndex(f => f.id === state.frameId); if (i < state.frames.length - 1) goFrame(state.frames[i + 1].id); };
  $('addF').onclick = addFrame;
  $('delF').onclick = deleteFrame;
  $('clearF').onclick = clearFrame;
  $('exportBtn').onclick = exportPNG;
  $('submitBtn').onclick = submitFrame;
  $('grpBtn').onclick = () => { if (!state.group && !state.teacher) openWelcome(); else openGroups(); };
  $('gCloseBtn').onclick = () => { $('gModal').hidden = true; };
  $('gCount').onchange = () => drawNameInputs(+$('gCount').value);
  $('gSave').onclick = saveGroupSettings;
  $('nameIn').addEventListener('input', checkWelcome);
  $('nameIn').addEventListener('keydown', e => { if (e.key === 'Enter') startWelcome(); });
  $('wStart').onclick = startWelcome;
  $('wTeacher').onclick = () => { $('wModal').hidden = true; openTeacher(); };
  $('tBtn').onclick = openTeacher;
  $('roomBtn').onclick = openRoomInfo;
  $('rmClose').onclick = () => { $('rmModal').hidden = true; };
  $('rmCopy').onclick = copyLink;
  $('rmLeave').onclick = leaveRoom;
  $('rmDelete').onclick = deleteRoom;
  $('joinBtn').onclick = () => tryJoin($('joinCode').value);
  $('joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') tryJoin($('joinCode').value); });
  $('mkBtn').onclick = createRoom;
  $('rAuto').onclick = autoCode;
  $('photoBtn').onclick = () => { if (!state.group) return; $('photoIn').value = ''; $('photoIn').click(); };
  $('photoIn').onchange = () => { const f = $('photoIn').files && $('photoIn').files[0]; if (f) addPhoto(f); };
  document.addEventListener('paste', e => {
    const tag = (e.target && e.target.tagName) || '';
    if (state.editing || tag === 'INPUT' || tag === 'TEXTAREA' || anyModal() || !state.group) return;
    const f = [...((e.clipboardData && e.clipboardData.files) || [])].find(x => /^image\//.test(x.type));
    if (f) { e.preventDefault(); addPhoto(f); }
  });
  stage.addEventListener('dragover', e => { if (state.group) e.preventDefault(); });
  stage.addEventListener('drop', e => {
    const f = [...((e.dataTransfer && e.dataTransfer.files) || [])].find(x => /^image\//.test(x.type));
    if (f && state.group) { e.preventDefault(); addPhoto(f); }
  });
  $('tClose').onclick = closeTeacher;
  $('tGo').onclick = teacherGo;
  $('tStudent').onclick = backToStudent;
  $('tChange').onclick = () => { setTMode('change'); setTimeout(() => $('tNew').focus(), 50); };
  ['tCode', 'tNew2'].forEach(k => $(k).addEventListener('keydown', e => { if (e.key === 'Enter') teacherGo(); }));
  $('inboxBtn').onclick = () => openSubs('inbox');
  $('cmpBtn').onclick = openCompare;
  $('cClose').onclick = closeCompare;
  $('cAdd').onclick = () => addPane();
  $('cShare').onchange = async () => {
    const v = $('cShare').checked;
    const ok = await write('meta/share', 'set', v);
    if (ok) { state.share = v; toast(v ? '生徒もほかの班を見られるようにしました' : '生徒はほかの班を見られなくなりました'); }
    else $('cShare').checked = state.share;
  };
  $('mineBtn').onclick = () => openSubs('mine');
  $('sClose').onclick = () => { $('sModal').hidden = true; };
  $('fGroup').onchange = renderSubList; $('fState').onchange = renderSubList;
  $('vClose').onclick = () => { $('vModal').hidden = true; viewing = null; };
  $('vReviewSave').onclick = saveReview;
  $('vSave').onclick = saveViewed;
  ['sModal', 'vModal', 'gModal', 'rmModal'].forEach(k => $(k).addEventListener('click', e => { if (e.target === $(k)) { $(k).hidden = true; if (k === 'vModal') viewing = null; } }));
  $('tModal').addEventListener('click', e => { if (e.target === $('tModal')) closeTeacher(); });
  const sel = $('bgSel');
  BGS.forEach(([k, n]) => { const o = document.createElement('option'); o.value = k; o.textContent = n; sel.appendChild(o); });
  sel.onchange = () => setBg(sel.value);
  let tt = 0;
  titleEl.addEventListener('input', () => { clearTimeout(tt); tt = setTimeout(saveTitle, 700); });
  titleEl.addEventListener('blur', saveTitle);
  titleEl.addEventListener('keydown', e => { if (e.key === 'Enter') titleEl.blur(); });
  window.addEventListener('hashchange', async () => {
    const h = location.hash.slice(1);
    if (!GID.test(h) || h === state.group || !state.group) return;
    if (!state.teacher && state.lock) { toast('班の変更は先生が止めています'); try { history.replaceState(null, '', '#' + state.group); } catch (e) {} return; }
    if (!(await setGroup(h))) { try { history.replaceState(null, '', '#' + state.group); } catch (e) {} }
  });
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || '';
    if (anyModal()) {
      if (e.key === 'Escape') { if (!$('cModal').hidden) { closeCompare(); return; } ['sModal', 'vModal', 'gModal', 'tModal', 'rmModal'].forEach(k => $(k).hidden = true); viewing = null; }
      return;
    }
    if (state.editing || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) { e.preventDefault(); deleteItem(state.sel); return; }
    if (e.key === 'Escape') { select(null); return; }
    if (e.key === 'Enter' && state.sel) { e.preventDefault(); startEdit(state.sel); return; }
    const map = { v: 'select', p: 'pen', m: 'marker', e: 'eraser', n: 'note', t: 'text', l: 'laser' };
    const t = map[e.key.toLowerCase()]; if (t) setTool(t);
  });
  new ResizeObserver(layout).observe(stage);
}
function saveTitle() {
  const v = titleEl.value.trim();
  if (v === state.title || !state.teacher) return;
  state.title = v; write('meta/board', 'set', { title: v });
}

async function startLocal() {
  $('setupModal').hidden = true;
  isLocal = true; baseS = makeLocalStore(); S = roomStore(baseS); uid = 'trial-user'; online = true;
  started = true; setStatus();
  enterFromUrl();
}
async function init() {
  bindUI(); setTool('pen'); layout(); setHint(); renderGroupBtn(); renderRoomBtn();
  state.frames = [{ id: 'f1', order: 0, bg: 'plain', virtual: true }]; state.frameId = 'f1'; renderFrames();
  $('tryLocal').onclick = startLocal;
  const configured = firebaseConfig && typeof firebaseConfig.apiKey === 'string' && !/YOUR_/.test(JSON.stringify(firebaseConfig));
  if (!configured) { $('hintMain').textContent = 'Firebase の設定がまだです'; $('setupModal').hidden = false; started = true; isLocal = true; setStatus(); isLocal = false; return; }
  try { baseS = await makeFirebaseStore(); S = roomStore(baseS); }
  catch (e) { $('hintMain').textContent = 'Firebase を読み込めませんでした'; $('hintSub').textContent = '通信を確かめて、ページを読み込み直してください'; return; }
  S.connected(c => { online = c; setStatus(); });
  authApi.onUser(async user => {
    if (!user) { try { await authApi.anon(); } catch (e) { toast('ログインできませんでした。Firebase の「匿名」ログインが有効か確かめてください'); } return; }
    uid = user.uid;
    started = true; setStatus();
    if (state.room) startSession(); else enterFromUrl();
  });
}
init();

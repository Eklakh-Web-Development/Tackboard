// Tackboard server: HTTP static + WebSocket sync. Server-sequenced last-write-wins.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(dir, 'data', 'board.db');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // e.g. https://board.example.com
const COLS = ['todo', 'doing', 'done'];
const COLORS = ['#2C56E8', '#C9461A', '#2E8B6A', '#8A3FBF', '#B0871A', '#0F8FA8'];

// ---------- storage ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Untitled', version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS cards(
    id TEXT PRIMARY KEY, board TEXT NOT NULL, col TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', pos REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS cards_board ON cards(board);
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS board_members(board TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT DEFAULT 'editor', PRIMARY KEY(board, user_id));
  CREATE TABLE IF NOT EXISTS activity_log(id INTEGER PRIMARY KEY AUTOINCREMENT, board TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, detail TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS activity_board ON activity_log(board);`);

const q = {
  // boards
  ensure: db.prepare('INSERT OR IGNORE INTO boards(id) VALUES(?)'),
  ver: db.prepare('SELECT version FROM boards WHERE id=?'),
  bump: db.prepare('UPDATE boards SET version=version+1 WHERE id=?'),
  boardName: db.prepare('SELECT name FROM boards WHERE id=?'),
  setBoardName: db.prepare('UPDATE boards SET name=? WHERE id=?'),
  listBoards: db.prepare('SELECT id, name, version FROM boards ORDER BY version DESC'),
  deleteBoard: db.prepare('DELETE FROM boards WHERE id=?'),
  // cards
  cards: db.prepare('SELECT id,col,title,description,pos FROM cards WHERE board=?'),
  has: db.prepare('SELECT 1 FROM cards WHERE id=? AND board=?'),
  ins: db.prepare('INSERT OR IGNORE INTO cards(id,board,col,title,description,pos) VALUES(?,?,?,?,?,?)'),
  upd: db.prepare('UPDATE cards SET title=?, description=? WHERE id=? AND board=?'),
  mv: db.prepare('UPDATE cards SET col=?, pos=? WHERE id=? AND board=?'),
  del: db.prepare('DELETE FROM cards WHERE id=? AND board=?'),
  // users
  ensureUser: db.prepare('INSERT OR IGNORE INTO users(id, name, token) VALUES(?,?,?)'),
  getUserByToken: db.prepare('SELECT id, name FROM users WHERE token=?'),
  // board members
  addMember: db.prepare('INSERT OR IGNORE INTO board_members(board, user_id) VALUES(?,?)'),
  isMember: db.prepare('SELECT 1 FROM board_members WHERE board=? AND user_id=?'),
  // activity log
  logActivity: db.prepare('INSERT INTO activity_log(board, user_id, action, detail) VALUES(?,?,?,?)'),
  getActivity: db.prepare('SELECT a.*, u.name as user_name FROM activity_log a LEFT JOIN users u ON a.user_id=u.id WHERE a.board=? ORDER BY a.id DESC LIMIT 100'),
};

// ---------- auth helpers ----------
function createToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

function getUserFromWs(ws) {
  return ws.user && ws.user.id ? ws.user : null;
}

function logActivity(board, user, action, detail) {
  try {
    q.logActivity.run(board, user?.id || null, action, JSON.stringify(detail).slice(0, 500));
  } catch (e) {
    console.error('Activity log error:', e.message);
  }
}

// Position rebalancing function (for fractional indexing exhaustion)
function rebalancePositions(boardId) {
  const cards = q.cards.all(boardId);
  if (cards.length === 0) return;
  
  // Group by column
  const byCol = {};
  cards.forEach(c => {
    if (!byCol[c.col]) byCol[c.col] = [];
    byCol[c.col].push(c);
  });
  
  // Rebalance each column
  for (const col of COLS) {
    const colCards = byCol[col] || [];
    colCards.sort((a, b) => a.pos - b.pos || a.id.localeCompare(b.id));
    
    // Assign new positions with sufficient spacing
    for (let i = 0; i < colCards.length; i++) {
      const targetPos = i * 2; // Use even numbers to leave room for inserts
      if (Math.abs(colCards[i].pos - targetPos) > 0.001) {
        const oldPos = colCards[i].pos;
        q.mv.run(colCards[i].col, targetPos, colCards[i].id, boardId);
        logActivity(boardId, null, 'position.rebalance', { card_id: colCards[i].id, old_pos: oldPos, new_pos: targetPos });
      }
    }
  }
  
  // Schedule periodic rebalancing
  setTimeout(() => rebalancePositions(boardId), 24 * 60 * 60 * 1000); // 24 hours
}

// ---------- ops ----------
const validId = (s) => typeof s === 'string' && /^[\w-]{1,40}$/.test(s);
const validTitle = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 200;
const validDesc = (s) => typeof s === 'string' && s.length <= 2000;
const validPos = (n) => Number.isFinite(n) && Math.abs(n) < 1e12;

function cleanOp(op) {
  if (!op || typeof op !== 'object' || !validId(op.id)) return null;
  switch (op.type) {
    case 'card.delete': return { type: op.type, id: op.id };
    case 'card.update':
      return (validTitle(op.title) || validTitle(op.description))
        ? { type: op.type, id: op.id, title: validTitle(op.title) ? op.title.trim() : undefined, description: validDesc(op.description) ? op.description : undefined }
        : null;
    case 'card.move': return COLS.includes(op.col) && validPos(op.pos) ? { type: op.type, id: op.id, col: op.col, pos: op.pos } : null;
    case 'card.create':
      return COLS.includes(op.col) && validPos(op.pos) && validTitle(op.title)
        ? { type: op.type, id: op.id, col: op.col, pos: op.pos, title: op.title.trim(), description: validDesc(op.description) ? op.description : '' } : null;
    default: return null;
  }
}

// returns true if state changed
function apply(board, op) {
  if (op.type === 'card.create') return q.ins.run(op.id, board, op.col, op.title, op.description || '', op.pos).changes > 0;
  if (!q.has.get(op.id, board)) return false; // concurrently deleted: no-op
  if (op.type === 'card.update') {
    if (op.title !== undefined && op.description !== undefined) return q.upd.run(op.title, op.description, op.id, board).changes > 0;
    if (op.title !== undefined) return q.upd.run(op.title, null, op.id, board).changes > 0;
    if (op.description !== undefined) return q.upd.run(null, op.description, op.id, board).changes > 0;
    return false;
  }
  if (op.type === 'card.move') return q.mv.run(op.col, op.pos, op.id, board).changes > 0;
  return q.del.run(op.id, board).changes > 0;
}
const commit = db.transaction((board, op) => {
  if (!apply(board, op)) return null;
  q.bump.run(board);
  return q.ver.get(board).version;
});

// ---------- rooms ----------
const rooms = new Map(); // board -> { clients:Set<ws>, seen:Map<opId,version> }
function room(board) {
  let r = rooms.get(board);
  if (!r) { q.ensure.run(board); r = { clients: new Set(), seen: new Map() }; rooms.set(board, r); }
  return r;
}
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const broadcast = (r, m, except) => r.clients.forEach((c) => c !== except && send(c, m));
const users = (r) => [...r.clients].map((c) => c.user);

function handleOp(ws, msg) {
  const user = ws.user;
  if (!user) return send(ws, { t: 'nack', opId: msg?.opId, error: 'not authenticated' });

  const r = room(ws.board);
  const { opId } = msg;
  if (typeof opId !== 'string' || opId.length > 64) return;
  if (r.seen.has(opId)) return send(ws, { t: 'ack', opId, v: r.seen.get(opId) }); // idempotent resend
  const op = cleanOp(msg.op);
  if (!op) return send(ws, { t: 'nack', opId, error: 'invalid operation' });
  let v = q.ver.get(ws.board).version;
  const nv = commit(ws.board, op);
  if (nv !== null) { 
    v = nv; 
    broadcast(r, { t: 'op', op, v, by: ws.user.id }, ws);
    logActivity(ws.board, user, op.type, { op, board: ws.board, by: ws.user.id }); 
  }
  r.seen.set(opId, v);
  if (r.seen.size > 5000) r.seen.delete(r.seen.keys().next().value);
  send(ws, { t: 'ack', opId, v });
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

function authenticate(req, res, next) {
  const token = req.headers['x-auth-token'] || new URL(req.url, 'http://x').searchParams.get('auth');
  if (!token) return sendJson(res, 401, { error: 'missing auth token' });
  const user = q.getUserByToken.get(token);
  if (!user) return sendJson(res, 401, { error: 'invalid auth token' });
  next(user);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  
  // Auth endpoints
  if (url.pathname === '/api/auth' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const name = body.name?.trim().slice(0, 50) || 'Guest';
      const userId = crypto.randomUUID();
      const token = createToken();
      q.ensureUser.run(userId, name, token);
      logActivity('system', null, 'auth.create', JSON.stringify({ user_id: userId }));
      return sendJson(res, 200, { user: { id: userId, name, token } });
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid request' });
    }
  }
  
  if (url.pathname === '/api/boards' && req.method === 'GET') {
    authenticate(req, res, (user) => {
      const boards = q.listBoards.all();
      const enriched = boards.map(b => ({ id: b.id, name: b.name, version: b.version, user_role: 'editor' }));
      return sendJson(res, 200, enriched);
    });
    return;
  }
  
  if (url.pathname === '/api/boards' && req.method === 'POST') {
    authenticate(req, res, async (user) => {
      try {
        const body = await readBody(req);
        const boardId = crypto.randomUUID().slice(0, 12);
        const boardName = body.name?.trim() || `Board ${Date.now()}`;
        q.ensure.run(boardId);
        q.setBoardName.run(boardName, boardId);
        q.addMember.run(boardId, user.id);
        logActivity(boardId, user, 'board.create', JSON.stringify({ board_id: boardId, name: boardName }));
        return sendJson(res, 201, { board: { id: boardId, name: boardName, version: 0 } });
      } catch (e) {
        return sendJson(res, 400, { error: 'failed to create board' });
      }
    });
    return;
  }
  
  if (url.pathname.startsWith('/api/boards/') && req.method === 'DELETE') {
    authenticate(req, res, async (user) => {
      const boardId = url.pathname.split('/')[3];
      if (!validId(boardId)) return sendJson(res, 400, { error: 'invalid board id' });
      const member = q.isMember.get(boardId, user.id);
      if (!member) return sendJson(res, 403, { error: 'not a board member' });
      q.deleteBoard.run(boardId);
      logActivity(boardId, user, 'board.delete', null);
      return sendJson(res, 200, { success: true });
    });
    return;
  }
  
  if (url.pathname.startsWith('/api/boards/') && req.method === 'GET' && url.pathname.endsWith('/activity')) {
    authenticate(req, res, (user) => {
      const boardId = url.pathname.split('/')[3];
      if (!validId(boardId)) return sendJson(res, 400, { error: 'invalid board id' });
      const member = q.isMember.get(boardId, user.id);
      if (!member) return sendJson(res, 403, { error: 'not a board member' });
      const activity = q.getActivity.all(boardId);
      return sendJson(res, 200, activity);
    });
    return;
  }
  
  // Static files
  const rel = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.join(dir, 'public', rel);
  if (!file.startsWith(path.join(dir, 'public'))) { res.writeHead(403); return res.end(); }
  
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    res.end(buf);
  });
});

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws, req) => {
  if (ALLOWED_ORIGIN && req.headers.origin !== ALLOWED_ORIGIN) return ws.close(1008, 'origin');
  const p = new URL(req.url, 'http://x').searchParams;
  ws.board = (p.get('board') || 'main').replace(/[^\w-]/g, '').slice(0, 40) || 'main';
  const id = crypto.randomUUID().slice(0, 8);
  ws.user = { id, name: (p.get('name') || 'Guest').slice(0, 24), color: COLORS[parseInt(id, 16) % COLORS.length] };
  ws.alive = true; ws.hits = 0;
  ws.on('pong', () => (ws.alive = true));

  const r = room(ws.board);
  r.clients.add(ws);
  send(ws, { t: 'snapshot', v: q.ver.get(ws.board).version, cards: q.cards.all(ws.board), you: ws.user.id, users: users(r) });
  broadcast(r, { t: 'presence', users: users(r) }, ws);

  ws.on('message', (raw) => {
    if (++ws.hits > 60) return ws.close(1008, 'rate limit'); // 60 msgs/sec
    let msg; try { msg = JSON.parse(raw); } catch { return ws.close(1003); }
    if (msg?.t === 'op') handleOp(ws, msg);
  });
  ws.on('close', () => {
    r.clients.delete(ws);
    broadcast(r, { t: 'presence', users: users(r) });
    if (!r.clients.size) rooms.delete(ws.board); // free memory; state is in SQLite
  });
});
setInterval(() => wss.clients.forEach((c) => (c.hits = 0)), 1000).unref();
setInterval(() => wss.clients.forEach((c) => {
  if (!c.alive) return c.terminate();
  c.alive = false; c.ping();
}), 30000).unref();

server.listen(PORT, () => console.log(`Tackboard listening on :${server.address().port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  wss.clients.forEach((c) => c.close(1001, 'restart'));
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
});

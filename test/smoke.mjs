import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PORT = 4123;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_PATH: path.join(tmp, 't.db') }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('listening') && r()));

const open = (name) => new Promise((res) => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?board=t&name=${name}`);
  const inbox = [];
  ws.on('message', (m) => inbox.push(JSON.parse(m)));
  ws.on('open', () => res({ ws, inbox }));
});
const next = (c, pred, ms = 2000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const i = setInterval(() => {
    const k = c.inbox.findIndex(pred);
    if (k >= 0) { clearInterval(i); res(c.inbox.splice(k, 1)[0]); }
    else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout waiting for message')); }
  }, 15);
});
const op = (c, opId, o) => c.ws.send(JSON.stringify({ t: 'op', opId, op: o }));

try {
  const a = await open('A'), b = await open('B');
  await next(a, (m) => m.t === 'snapshot'); await next(b, (m) => m.t === 'snapshot');

  op(a, 'o1', { type: 'card.create', id: 'c1', col: 'todo', title: 'Ship it', pos: 1 });
  assert.equal((await next(a, (m) => m.t === 'ack')).v, 1);
  const remote = await next(b, (m) => m.t === 'op');
  assert.equal(remote.op.title, 'Ship it');

  op(a, 'o1', { type: 'card.create', id: 'c1', col: 'todo', title: 'Ship it', pos: 1 }); // resend
  assert.equal((await next(a, (m) => m.t === 'ack')).v, 1, 'duplicate op is idempotent');

  op(b, 'o2', { type: 'card.move', id: 'c1', col: 'doing', pos: 2 });
  assert.equal((await next(a, (m) => m.t === 'op')).op.col, 'doing');

  op(b, 'o3', { type: 'card.move', id: 'c1', col: 'hacked', pos: 2 });
  assert.equal((await next(b, (m) => m.t === 'nack')).opId, 'o3');

  const c = await open('C');
  const snap = await next(c, (m) => m.t === 'snapshot');
  assert.deepEqual(snap.cards.map((x) => [x.id, x.col]), [['c1', 'doing']]);
  console.log('OK: sync, ack, idempotency, validation, late-join snapshot');
} catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; }
finally { srv.kill(); }

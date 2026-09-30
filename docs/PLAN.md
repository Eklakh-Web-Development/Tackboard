# Tackboard: Implementation Plan (Real-Time Collaborative Project Management)

## 1. Research summary

| Approach | Fits | Cost | Verdict for a kanban board |
|---|---|---|---|
| Server-sequenced last-write-wins (LWW) + optimistic apply | Small structured state (cards, columns, fields) | Low | **Chosen for v1.** Every op gets a global version; all clients converge; conflicts show as a visible "snap", not silent loss |
| CRDTs (LWW-map, OR-set, Yjs) | Offline-first, peer sync, rich text | Medium | **Stage 8 upgrade** for offline editing and card descriptions |
| Operational Transform | Character-level text editing | High | Skip unless building a Google-Docs-style editor |

Patterns worth copying (seen in open-source boards and diagram editors):
- Apply the op locally at once; the server **ack** is the convergence point, the server **broadcast** updates everyone else.
- Keep `server state` and a `pending` queue separate; render `server + pending replayed`. Remote ops never clobber your un-acked edits.
- Order cards with **fractional indexing** (position between neighbours = midpoint), so a move changes one row, not the whole column.
- Give every op a client-generated id so resends after reconnect are **idempotent**.
- Undo is local-only (inverse ops per client); do not try to undo other people's work.

Sources: PyPI `aether-zta` docs (LWW/HLC, rate limits); github.com/badnikhil/collab (OR-Set + fractional indexing kanban); github.com/emylfy/taskflow (Yjs + optimistic dnd-kit); github.com/Deepakbefoodly/DiagramEditor (ack/seq LWW model).

## 2. Architecture

```
Browser (vanilla JS)                         Node 22 process
 state = server + pending     WebSocket      ws server  -> validate -> SQLite tx (op + version bump)
 optimistic render  --op(opId)-->            -> ack(opId, v) to sender
 reconnect + resend <--snapshot/op/presence  -> op(v) broadcast to other clients in the room
```

Protocol (JSON): client `{t:'op', opId, op}`; server `snapshot | op | ack | nack | presence`.
Ops: `card.create | card.update | card.move | card.delete`. Data: `boards(id, version)`, `cards(id, board, col, title, pos)`.
Conflict rules: per-field LWW in server arrival order; update/move on a deleted card is a no-op; duplicate `opId` returns the original ack.

## 3. Stages (each ends with a demo-able exit criterion)

| # | Stage | Deliverables | Exit criterion | Status |
|---|---|---|---|---|
| 0 | Scaffold | Repo, Node 22, `ws`, SQLite, lint/format | `npm start` serves a page | Done |
| 1 | Board CRUD | Lanes, create/edit/delete, persistence | Refresh keeps data | Done |
| 2 | Realtime sync | WebSocket rooms, snapshot, broadcast | Two tabs mirror each other | Done |
| 3 | Optimistic UI | pending queue, ack/nack, rollback on reject | Edits show instantly; throttled network still converges | Done |
| 4 | Drag and drop | Fractional ordering, cross-lane moves | Concurrent moves converge identically | Done |
| 5 | Resilience | Heartbeat, backoff reconnect, idempotent resend, rate limit, payload cap | Kill server mid-edit: no lost or duplicated cards | Done |
| 6 | Presence and polish | Avatars, status pill, share link, dark mode | Second user visible within 1 s | Done |
| 7 | Deploy | Dockerfile, compose, Render/Fly configs, CI, `/healthz`, origin check | Public HTTPS URL, `wss://` works | Ready to ship |
| 8 | Next (not built) | Auth + boards list, card descriptions/assignees, live cursors, undo, keyboard moves, activity log, tests with two browsers (Playwright), rebalance positions when gap < 1e-9 | see Roadmap | Planned |

## 4. Deploy checklist
1. `npm ci && npm test` (CI does this on every push).
2. Pick a host: **Fly.io** (`fly.toml`, volume for SQLite) or **Render** (`render.yaml`, paid disk) or any VPS (`docker compose up -d` behind Caddy/nginx).
3. Terminate TLS at the proxy and forward `Upgrade`/`Connection` headers. Caddy: `reverse_proxy localhost:3000` works as is. nginx needs `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 75s;`.
4. Set `ALLOWED_ORIGIN=https://your-domain`.
5. Back up the `/data` volume (`sqlite3 board.db ".backup ..."` on a cron).

## 5. Scaling roadmap
- **Now:** one instance, rooms in memory, SQLite (WAL). Comfortable for hundreds of concurrent users.
- **Multi-instance:** move to Postgres, add Redis pub/sub so each instance broadcasts to its own sockets, sticky sessions by board id.
- **Offline / rich text:** adopt Yjs for card descriptions, keep the op log for structure.

## 6. Known limits and risks
- No auth: anyone with a board link can edit. Add sign-in and per-board ACLs before real use (Stage 8).
- Fractional positions run out of precision after roughly 50 successive inserts in the same gap; add a server rebalance job.
- Pending ops live in memory: a tab closed while offline loses them. Persist the queue in IndexedDB if that matters.
- Drag and drop uses HTML5 DnD: no touch or keyboard support yet.

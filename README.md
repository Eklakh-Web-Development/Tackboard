# Tackboard

**Real-time collaborative Kanban board for teams.**

Tackboard is a deliberately small full-stack collaboration system built around **WebSockets, optimistic UI, server-sequenced operations, idempotent retries, authenticated users, shareable boards, and persistent SQLite**.

## Features

- Real-time WebSocket collaboration
- Optimistic UI with pending-operation replay
- Idempotent operation IDs for reconnect/resend
- Authenticated user sessions and live presence
- Shareable board links for collaborators
- Owner/editor board membership
- SQLite WAL persistence
- Transactional mutations + board versions
- Input validation, payload limits, rate limiting and origin checks
- WebSocket heartbeat and reconnect backoff
- Docker + persistent volume
- Automated integration smoke tests + Docker build
- /healthz deployment endpoint

## Architecture

Browser → REST auth/boards + WebSocket → Node.js → SQLite persistent volume.

The client renders **authoritative server state + unacknowledged local operations**. Accepted operations are committed transactionally, assigned a board version, broadcast to other members, and acknowledged to the sender.

## Run locally

Requires Node.js 22+.

```bash
npm ci
npm start
```

Open http://localhost:3000. Create a board, copy its share URL, and open that URL in another browser/profile.

```bash
npm test
docker compose up --build
```

## Production deployment

The included Render and Fly configurations use a persistent /data volume for SQLite.

**Important: run exactly one app instance.** WebSocket rooms and operation deduplication are process-local. Horizontal scaling requires Postgres + Redis/pub-sub.

Set:

```text
ALLOWED_ORIGIN=https://your-public-domain.example
```

The app exposes `GET /healthz`.

### Render

Use a persistent-disk plan, one instance, and set `ALLOWED_ORIGIN` to the exact public HTTPS origin.

### Fly.io

Set a unique app name in `fly.toml`, create a persistent /data volume, then deploy one machine.

## Security model

This version uses link-based collaboration rather than enterprise identity.

- Session tokens are generated server-side.
- Only SHA-256 token hashes are stored in SQLite.
- Share tokens are also stored only as hashes.
- WebSocket connections require an authenticated board member.
- Share links grant editor membership.
- Owner-only board deletion is enforced.
- `ALLOWED_ORIGIN` can restrict browser origins.

For enterprise deployment, add OIDC/SSO, session expiry/rotation, invite revocation, centralized audit/observability, and multi-instance infrastructure.

## Data model

`users`, `boards`, `board_members`, `cards`, and `activity_log`.

Foreign keys are enabled and board deletion cascades to dependent records.

## Known limitations

- Share links grant editor access.
- Pending offline operations are memory-only.
- HTML5 drag/drop is not touch-first.
- Fractional ordering should eventually get threshold-based rebalancing.
- Single-instance only.

## Roadmap

- Board management UI
- Card detail/description editor
- Activity panel
- Playwright multi-browser tests
- Session expiry and share-link revocation
- OIDC/SSO
- Postgres + Redis for horizontal scaling

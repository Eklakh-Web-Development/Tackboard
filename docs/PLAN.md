# Tackboard — Production Readiness

## Implemented

- Authenticated user sessions with hashed tokens
- Board owners/editors and share-link joining
- Authenticated WebSocket admission
- Optimistic UI and idempotent operation replay
- Atomic SQLite transactions and board versions
- Foreign keys and cascading board deletion
- Payload limits, validation, rate limiting and origin checks
- Heartbeats and reconnect backoff
- Docker persistent volume
- CI smoke test and Docker build
- Health endpoint

## Deployment boundary

Run one application instance with persistent `/data` storage. This supports multiple people editing the same board in real time.

Do not horizontally scale this version: WebSocket rooms and deduplication state are process-local.

## Next hardening

1. Playwright multi-browser concurrency tests
2. Session expiry/rotation
3. Share-link revocation
4. OIDC/SSO
5. Centralized logs/metrics
6. Postgres + Redis/pub-sub for multi-instance deployment
7. Automated backup/restore

## Consistency model

Operations are committed in server arrival order. Each accepted operation increments the board version. Clients render server state plus pending local operations, and duplicate operation IDs are acknowledged without duplicating writes.

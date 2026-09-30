# Tackboard

Real-time collaborative project board. WebSockets for sync, optimistic UI for instant feedback, SQLite for persistence, one Docker image to deploy.

```bash
npm install
npm start            # http://localhost:3000  (open two tabs; boards are #hash-named)
npm test             # spawns the server, drives 3 WebSocket clients
docker compose up    # production-style run with a persistent volume
```

- Full research, protocol, stages and deploy checklist: [docs/PLAN.md](docs/PLAN.md)
- Config: see `.env.example` (`PORT`, `DB_PATH`, `ALLOWED_ORIGIN`)
- Deploy: `Dockerfile`, `docker-compose.yml`, `fly.toml`, `render.yaml`, `.github/workflows/ci.yml`
- Layout: `server.js` (HTTP + WS + SQLite), `public/index.html` (client), `test/smoke.mjs`
"# Tackboard" 

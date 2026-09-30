# Tackboard production plan

## Target architecture

Vercel hosts the browser application. Supabase provides Auth, PostgreSQL, RLS, Realtime and private board presence.

## Completed in this branch

- Replaced the custom Node/SQLite/WebSocket runtime with a Vite + Supabase client architecture.
- Added authenticated email/password signup and sign-in.
- Added persistent user profiles.
- Added owner/editor board membership.
- Added hashed share tokens and owner-only rotation.
- Added authenticated board joining through invite links.
- Added PostgreSQL persistence for boards and cards.
- Added RLS policies for every application table.
- Added private Realtime presence authorization by board membership.
- Added Realtime Postgres Changes for cards.
- Added optimistic card operations.
- Added Vercel security headers and environment template.
- Replaced the legacy CI smoke test with a Vercel production build.
- Removed the old SQLite/Node/Docker/Render/Fly deployment path from the production branch.

## Required before public launch

1. Connect/create the Supabase production project.
2. Apply the SQL migration.
3. Configure Supabase Auth email settings and production redirect URLs.
4. Disable public access for Realtime channels.
5. Run Supabase security and performance advisors.
6. Configure Vercel environment variables.
7. Deploy the main branch.
8. Run a two-browser realtime acceptance test.
9. Add password recovery, invite revocation/member management, abuse controls, monitoring, privacy/terms and backup/restore procedures.

## Scale boundary

The application no longer depends on a single Node process or SQLite disk. Supabase Realtime and Postgres provide the shared state layer needed for multiple concurrent users.

For very high realtime fan-out, use Supabase Broadcast with database triggers rather than relying indefinitely on Postgres Changes per-subscriber authorization.

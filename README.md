# Tackboard

**Real-time collaborative Kanban for authenticated teams.**

Tackboard is a production-oriented collaboration product built around **Supabase Auth, PostgreSQL, Row Level Security, Realtime, optimistic UI, private presence, and Vercel deployment**.

## Product capabilities

- Email/password authentication with persistent Supabase sessions
- User profiles and display names
- Private boards with owner/editor membership
- Share links that require authentication before joining
- Hashed share tokens with owner-only rotation
- PostgreSQL persistence
- Row Level Security on every application table
- Supabase Realtime database synchronization
- Private Realtime presence per board
- Optimistic card creation, editing, moving and deletion
- Responsive Kanban UI
- Vercel-ready build and security headers
- GitHub CI build verification

## Architecture

```
Browser
  │
  ├── Supabase Auth
  ├── Supabase Data API + RLS
  └── Supabase Realtime
          │
          ▼
     PostgreSQL
          │
          ▼
       Vercel
```

The browser never receives a service-role key. The publishable key is safe for client use only because access is enforced by authentication and RLS.

Realtime card changes are delivered through Supabase Realtime. Board presence uses private Realtime channels whose authorization is tied to board membership.

## Local development

Requires Node.js 20+.

Create a Supabase project, apply `supabase/migrations/202610010001_production.sql`, then create `.env.local`:

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Then:

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm run preview
```

## Supabase production setup

1. Create the Supabase project.
2. Apply the migration in `supabase/migrations/`.
3. Enable Email authentication.
4. Configure the production Site URL and redirect URLs.
5. Disable public access for Realtime channels.
6. Confirm `cards` is in the `supabase_realtime` publication.
7. Run Supabase security/performance advisors after the migration.
8. Configure the Vercel environment variables with the project's URL and publishable key.

The migration enables RLS, least-privilege grants, private board presence authorization, hashed share tokens, and the required Realtime publication.

## Vercel deployment

Connect this GitHub repository to Vercel and deploy the `main` branch.

Set these environment variables in Vercel:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

Do **not** add `service_role`, secret keys, database passwords, or other privileged credentials to `VITE_` variables.

## Security model

- Supabase Auth owns identity and session lifecycle.
- RLS is the database authorization boundary.
- Every board read requires membership.
- Card reads/writes require board membership.
- Board rename/delete requires ownership.
- Share tokens are stored only as SHA-256 hashes.
- Joining a board requires an authenticated user and a valid share token.
- Realtime presence uses private channels authorized by board membership.
- The frontend uses only the Supabase publishable key.

## Current production boundary

This architecture is suitable for a real multi-user web product without the single-process limitation of the previous Node/WebSocket/SQLite implementation.

Before opening the product to a large public audience, add:

1. Password reset / account recovery UX
2. Email verification UX and production redirect configuration
3. Board member management and invite revocation UI
4. Playwright multi-browser realtime tests
5. Error monitoring and structured application telemetry
6. Rate limiting/abuse controls for public signup and board creation
7. Automated database backups and restore drills
8. Ordering rebalance for very large boards
9. Product analytics and privacy/terms pages

## Project structure

```
index.html
src/main.js
src/style.css
supabase/migrations/
vercel.json
.github/workflows/ci.yml
```

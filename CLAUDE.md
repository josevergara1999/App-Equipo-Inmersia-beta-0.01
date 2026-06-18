# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run server (production)
npm start

# Run server with auto-restart on file change
npm run dev
```

The server listens on `PORT` env var (default 10000). There is no build step — the frontend is served as a static file from `public/`.

## Architecture

This is a **single-file React SPA + Express backend** — no bundler, no build pipeline.

### Frontend (`public/index.html`)
A single ~2400-line HTML file. React 18, ReactDOM, and Babel Standalone are loaded from CDN. All JSX is transpiled in the browser at runtime via `<script type="text/babel">`. There are no separate component files — every component, hook, and utility lives inline in that one file.

Key architectural patterns:
- All state lives in the root `Main` component with `useState`/`useMemo`/`useRef`
- Data is loaded on mount from Supabase via `DB.loadAll()` and saved debounced (800ms) via `dbSave(key, value)`
- Guards prevent saving empty arrays when Supabase had data (`initTrack*` refs and `hadData` ref)
- `localStorage` is used as a backup for companies and GCal tokens
- The `API` object routes all AI/backend calls through the Express server (never directly to external APIs from the frontend)

Component naming uses short aliases: `Ic` (icon), `Av` (avatar), `Bt` (button), `Bg` (badge/pill), `Md` (modal), `Fd` (form field).

Three CSS themes are toggled via `body[data-variant]` attribute (A=Oak & Sage dark, B=Night & Coral dark, C=Light Linen light). All colors use CSS custom properties (`--bg`, `--accent`, `--tx`, etc.).

### Backend (`server.js`)
Express server that:
- Proxies AI requests to Google Gemini 2.5 Flash (`/api/ai/generate`, `/api/generate-acta`, `/api/loyalty/generate-push`, `/api/meta/advisor`)
- Handles email notifications via Resend API (`/api/notify`)
- Manages Google OAuth2 flow for login and Calendar access (`/api/auth/google*`, `/api/auth/callback/google`)
- Syncs tasks to Google Calendar using stored refresh tokens (`/api/gcal/sync`)
- Serves the static frontend from `public/`

### Database (Supabase)
A single `app_data` table with `key` / `value` / `updated_at` columns, used as a key-value store. Keys in use: `companies`, `tasks`, `extras`, `meetings`, `planners`, `planner_drafts`, `teamPay`, `billRcpts`, `gcal_tokens`. GCal OAuth tokens (with refresh tokens) are also stored here for server-side calendar sync.

### Environment Variables
| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API |
| `RESEND_API_KEY` | Email via Resend |
| `GOOGLE_CLIENT_ID` | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `GOOGLE_REDIRECT_URI` | Google OAuth callback URL |
| `SUPABASE_URL` | Supabase project URL (also hardcoded in frontend as fallback) |
| `SUPABASE_KEY` | Supabase publishable key (also hardcoded in frontend) |
| `APP_URL` | Base URL for email links |
| `PORT` | Server port (default 10000) |

## Domain Model

**Companies** have a plan (`pro_emprende`, `society`, `basic`, `medium`, `full`, `custom`) that defines how many tasks of each type get generated automatically.

**Task types** (`TT`): `post`, `historia`, `reel`, `video_pro`, `visita`, `custom`, `repost`

**Task states** (`SS`): `no_realizado` → `en_proceso` → `en_aprobacion` → `aprobado` → `publicado`

**User roles**: `admin` (full access), `editor` (create/edit tasks), `visualizador` (read-only), `cliente` (approval flow only)

**Extras** are ad-hoc billable items (videos, sessions, Meta Ads campaigns) attached to a company and date.

When a company's plan changes (`updCoP`), tasks for that company are regenerated via `genTasks()` — existing scheduled tasks are kept, unscheduled ones replaced.

## Deployment

Deployed on Render. The `public/index_files/` folder contains cached/offline copies of the CDN scripts for the PWA service worker (`sw.js`) and manifest (`manifest.json`).

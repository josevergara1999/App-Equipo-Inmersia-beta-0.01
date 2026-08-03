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
A single ~3400-line HTML file. React 18, ReactDOM, and Babel Standalone are loaded from CDN. All JSX is transpiled in the browser at runtime via `<script type="text/babel">`. There are no separate component files — every component, hook, and utility lives inline in that one file.

Because Babel runs in the browser, a JSX syntax error is a blank page with no build-time
warning. To check before reloading, run the page's own Babel copy over the script block:

```js
// node, from repo root
const Babel = require("./public/index_files/babel.min.js.descarga");
const html = require("fs").readFileSync("public/index.html", "utf8");
const code = html.match(/<script[^>]*type="text\/babel"[^>]*>([\s\S]*?)<\/script>/)[1];
Babel.transform(code, { presets: ["react"] }); // throws with a line number on error
```

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
- Uploads content files to Supabase Storage (`/api/upload`, `/api/upload/status`)
- Exposes Meta Ads / Instagram insights and the Atlas voice-assistant API (`/api/meta/*`, `/api/atlas/*`)
- Serves the static frontend from `public/`

Most `/api/*` routes are behind `requireAuth`, which checks an HMAC token in the HttpOnly
`_iauth` cookie. **That cookie is only issued by the Google OAuth callback** — the
email+password form in `Login` matches against `INIT_USERS` client-side and never touches
the server, so password-only users (and all `cliente` accounts) cannot reach authed
endpoints. Atlas routes use a separate `x-atlas-key` header instead.

### Database (Supabase)
A single `app_data` table with `key` / `value` / `updated_at` columns, used as a key-value store. Keys in use: `companies`, `tasks`, `extras`, `meetings`, `planners`, `planner_drafts`, `teamPay`, `billRcpts`, `gcal_tokens`, `prospects`. Uploaded content files live in Supabase **Storage** (bucket `contenido`), not in this table. GCal OAuth tokens (with refresh tokens) are also stored here for server-side calendar sync.

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
| `SUPABASE_SERVICE_KEY` | Supabase service_role key — **required for content upload**; the publishable key cannot write to Storage |
| `SUPABASE_BUCKET` | Storage bucket for uploaded content (default `contenido`) |
| `ATLAS_API_KEY` | Shared secret for the `/api/atlas/*` routes |
| `APP_URL` | Base URL for email links |
| `PORT` | Server port (default 10000) |

## Domain Model

**Companies** have a plan (`pro_emprende`, `society`, `basic`, `medium`, `full`, `custom`) that defines how many tasks of each type get generated automatically.

**Task types** (`TT`): `post`, `historia`, `reel`, `video_pro`, `visita`, `custom`, `repost`

**Task states** (`SS`): `no_realizado` → `en_proceso` → `en_aprobacion` → `aprobado` → `publicado`

**User roles**: `admin` (full access), `editor` (create/edit tasks), `visualizador` (read-only), `Sales` (Prospectos tab only, plus the default pages), `cliente` (client portal only)

## Content approval & scheduling flow

The team produces content, the **client** decides when it publishes. One task carries the
whole lifecycle — `state` and `date` are independent, which is what makes "approved but
not yet scheduled" representable:

1. `genTasks()` creates empty slots per plan (`Post 1 Huemul`…), `state:"no_realizado"`, `date:null`.
2. **Contenido page** (team): pick a company and a type, drop files. Each file fills the next
   free slot of that type — attaching a file to a slot is what defines the piece as post /
   historia / reel; the client never chooses the type. Leftover files beyond the plan's slots
   require an explicit click and are flagged `extraSlot:true` (they affect billing).
3. "Enviar a aprobación" flips those tasks to `en_aprobacion`.
4. **Client portal, "Por aprobar"**: a swipe deck (`SwipeDeck`). Right = approve → `aprobado`.
   Left = opens a mandatory reason box → `en_proceso` + the reason in `clientApproval.comment`
   and `comments`, so the piece returns to the team's Contenido page with the motive shown.
5. **Client portal, "Planificar"** (`PlanBoard`): approved tasks with no `date` sit in a bank.
   Dragging one onto a day (or tapping piece → tapping day on touch) opens a modal asking for
   an optional `caption` and `publishTime`, then writes `date`. Scheduled pieces can be moved,
   edited or dragged back to the bank at any time. `publicado` pieces are shown but locked.

Fields added by this flow: `caption` (client's copy for the post), `publishTime` (`"HH:MM"`),
`extraSlot`, and `files[]` entries shaped `{name, type, url}` (`url` from Supabase Storage;
legacy/fallback entries use base64 `data` instead — read them via the `fSrc()` helper).

Two constraints worth knowing before changing this:
- **Never store video as base64 in a task.** All tasks live in one `app_data` row that
  `DB.loadAll()` pulls in full on every page load for every user. `/api/upload` exists to keep
  binaries out of that row; without `SUPABASE_SERVICE_KEY` the frontend falls back to base64
  and refuses files over 3 MB.
- **`DB.loadAll()` fetches every company's tasks and filters client-side**, so a client's
  browser receives other clients' content. Fixing that needs row-level filtering, not a UI change.

**Extras** are ad-hoc billable items (videos, sessions, Meta Ads campaigns) attached to a company and date.

When a company's plan changes (`updCoP`), tasks for that company are regenerated via `genTasks()` — existing scheduled tasks are kept, unscheduled ones replaced.

## Deployment

Deployed on Render. The `public/index_files/` folder contains cached/offline copies of the CDN scripts for the PWA service worker (`sw.js`) and manifest (`manifest.json`).

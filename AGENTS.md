# Whiteboard Ultra

AI-powered digital whiteboard. React + Vite frontend and an Express API server, both served on a single port via Vite middleware mode.

## Cursor Cloud specific instructions

### Architecture
- Single product. The Express server (`server/index.ts`) mounts the Vite dev server in middleware mode, so the client and the `/api/*` + `/uploads/*` routes are all served from **one port: 3001** (not Vite's default 5173). The README's mention of `5173` does not apply to the `npm run dev` flow.
- Data is persisted with `better-sqlite3` to `./data/whiteboard-ultra.db` (auto-created on first run). Uploaded assets go to `./uploads/`. Both dirs are gitignored and created automatically.

### Run / build / lint / test
- Dev server (use this for development): `npm run dev` — runs `tsx watch server/index.ts`, hot-reloads both client and server. App at `http://localhost:3001`.
- Build: `npm run build` (runs `build:server` then `build:client`).
- Production start (after build): `npm start`.
- Lint: `npm run lint`. NOTE: the repository currently has pre-existing lint errors (e.g. `no-case-declarations` in `server/ai.ts` and `src/lib/board.ts`); these are unrelated to environment setup.
- There is no automated test suite.

### Notes
- Supported Node versions are `^20.19.0`, `^22.13.0`, or `>=24` (the VM has a compatible Node 22 release). npm is the package manager (`package-lock.json`).
- AI features (Ask / Build / Insert) require an AI provider API key configured at runtime through the in-app settings UI (stored in SQLite). The core whiteboard (drawing, shapes, embeds, math tools) works without any key. No `.env` is needed to run the app.

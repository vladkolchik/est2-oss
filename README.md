# EST2 — LLM-driven Post-Apocalyptic RPG

A text RPG in a retro-futuristic post-apocalyptic wasteland, inspired by the Fallout game series. An LLM game master narrates the world, and a persistent **world memory with GraphRAG** keeps it consistent: NPCs remember you, consequences come back, relations and quests survive across sessions. On top of that: generated scene images, narrated audio, and BYOK so players can bring their own API keys.

> EST2 is a non-commercial fan project inspired by the Fallout game series. It is not affiliated with, endorsed or sponsored by Bethesda Softworks, ZeniMax Media or Microsoft. Fallout and related names are trademarks of their respective owners.

## Current Stack

- Frontend: React 19 + TypeScript + Vite
- Backend: Node.js 24 LTS + Express (`backend/index.js`; `backend/server.js` serves the built frontend + API on one port in production)
- Deployment: Docker Compose (app + Postgres/pgvector + optional Silero) — same files with or without Coolify
- **World memory (the core):** own world service on Postgres + pgvector (`backend/supabaseWorldService.js`) — turns, events, entities, relations, quests, NPC state and deferred consequences — with GraphRAG over the world graph (cached subgraph summaries). Embeddings: `text-embedding-3-small` via OpenAI or OpenRouter
- AI text: DeepSeek (`deepseek-v4-pro` for the GM, `deepseek-v4-flash` for light agents) or Google Gemini, directly or through OpenRouter with a single key
- Under-the-hood agents: GM (main narrative), GraphRAG summarizer, and a scene "artist" — each on its own model tier
- AI images: Gemini image model (`/api/generate-image`, directly or via OpenRouter) or free "sketch" mode — the artist agent emits a scene descriptor rendered client-side on canvas (`services/sceneRenderer.ts`)
- TTS: Gemini TTS (primary; directly or via OpenRouter), Chirp 3 HD, ElevenLabs, and Silero (self-hosted, auto-provisioned by the backend)
- Audio playback: Howler.js
- BYOK: players enter their own keys in **API KEYS**; an OpenRouter key alone covers text, memory, images and the Gemini voice

## Features

- Dynamic AI narrative and state updates (`/api/action`)
- World memory: canonical events/entities/relations in Postgres, hybrid (vector + text) memory retrieval, state patches applied transactionally, world ticks and encounter hints
- GraphRAG lane for complex history/causality questions (complex-only + timeout fallback, summary cache in Postgres)
- NPC reflection loop (trust/behavior/goals) with pinned long-term memories
- `@mentions` in player input with autocomplete (`@Name` / `@{Name With Space}`) and mention-aware retrieval
- Character creation, stats, quests, inventory, map/discovered locations
- Scene visuals in two modes (SKETCH/AI toggle in the header):
  - sketch (default, free): artist agent -> scene descriptor (`/api/scene-descriptor`) -> parametric canvas render; descriptors are cached per location in localStorage for instant re-entry frames
  - ai: full image model (`/api/generate-image`)
- Narration with provider fallback chain: Gemini -> Chirp -> ElevenLabs -> Silero (voices without a usable key are skipped)
- Cloud sessions: list/continue/rename/delete sessions across devices (protected by `SESSIONS_ACCESS_KEY`)
- BYOK (bring your own key), see below
- Ambient audio and UI SFX, local save/load in the browser

## BYOK and OpenRouter

Players can open **API KEYS** (start screen, or KEYS in the game header) and enter their own OpenRouter, DeepSeek, Gemini, OpenAI, ElevenLabs and Google Cloud TTS keys.

- Keys stay in the browser (localStorage) and are sent as `x-byok-*` headers. The backend (`backend/byok.js`) uses a key only for the request that carried it — including that turn's embeddings and GraphRAG summaries — and never stores or logs it.
- A player's key always wins over a server key; a direct provider key wins over OpenRouter.
- `BYOK_REQUIRED=true` stops using server keys for player traffic: requests without their own key get `401 { code: "byok_key_required" }`. A rejected key gives `byok_key_invalid`, an empty balance `402 byok_no_credits`; the dialog opens with the reason.
- OpenRouter (`backend/openrouterClient.js`) is the catch-all: GM `deepseek/deepseek-v4-pro`, light agents `deepseek/deepseek-v4-flash` (Gemini models when `TEXT_PROVIDER=gemini`), embeddings `openai/text-embedding-3-small` (same vectors as OpenAI), images `google/gemini-2.5-flash-image`, voice `google/gemini-3.8-flash-lite-tts`. Override with `OPENROUTER_*_MODEL`.

## Project Structure

- `App.tsx`: main game loop and UI orchestration
- `components/`: game UI components (incl. `ApiKeysModal.tsx`, `SessionBrowser.tsx`)
- `services/`: frontend API/audio/TTS services, BYOK keys (`byokService.ts`), scene renderer and cache
- `backend/`:
  - `index.js` (API routes), `server.js` (production entry)
  - `supabaseWorldService.js` (world memory + GraphRAG; the name is historical — it talks to any Postgres via `pgRest.js`), `contextBuilder.js`, `statePatchExtractor.js`
  - `migrations/*.sql` + `migrate.js` (schema)
  - `geminiService.js` (GM), `artistService.js` (artist agent), `deepseekClient.js`, `openrouterClient.js`, `llmTargets.js`, `byok.js`
  - `sileroManager.js` + `silero/` (self-hosted TTS)
- `shared/`: vocabularies shared between backend agents and the frontend renderer (`sceneVocabulary.json`)
- `tests/`: world-memory smoke test, eval gate, release gate
- `public/audio/`: your music and UI sounds (not included, see [Audio](#audio))
- `docs/`: TTS setup (`tts.md`); `docs/design/` holds design notes on world memory and simulation (in Russian)

## Local Development

Prerequisites: Node.js 24 LTS (>= 24.22.1, see `.nvmrc`), Postgres with pgvector (e.g. Docker). Or skip local setup and run everything with Docker Compose (see Deployment).

1. Install dependencies:
```bash
npm install
cd backend && npm install && cd ..
```

2. Start Postgres with pgvector (skip if you already have one):
```bash
docker run -d --name est2-pg -e POSTGRES_PASSWORD=est2 -e POSTGRES_DB=est2 -p 5432:5432 pgvector/pgvector:pg17
```

3. Configure the backend. All variables are documented in `backend/.env.example`:
```bash
cp backend/.env.example backend/.env
```
Then fill in at least:
```bash
DATABASE_URL=postgres://postgres:est2@localhost:5432/est2
# one text key: OPENROUTER_API_KEY alone is enough, or DEEPSEEK_API_KEY / GEMINI_API_KEY
OPENROUTER_API_KEY=...
# embeddings: OPENAI_API_KEY, or leave it to OpenRouter
```
`backend/.env` and other `.env*` files are git-ignored — never commit real keys. Without `DATABASE_URL` the game still runs, but with no world memory, GraphRAG or cloud sessions (the backend warns on startup).

4. Create the schema:
```bash
cd backend && node migrate.js && cd ..   # --status lists applied/pending migrations
```

5. Run the backend (terminal 1):
```bash
cd backend
npm start
```

6. Run the frontend (terminal 2):
```bash
npx vite --port 3002 --host 0.0.0.0
```
The frontend talks to `http://localhost:3001` in dev; override with `VITE_BACKEND_URL` in the root `.env.local`.

Note: on some Windows setups, `npm run dev` can bind in a way that causes `ERR_CONNECTION_REFUSED`; using `--host 0.0.0.0` avoids this.

## Audio

Music and UI sounds are not part of the repository: the original assets were third-party content. Put your own files into `public/audio/` under the names listed in [`public/audio/README.md`](public/audio/README.md), which also names the tracks the game was originally scored with. Missing files are skipped and the game plays silently; narration (TTS) and the in-game radio work regardless. In Docker Compose the folder is mounted into the app container, so adding files needs no rebuild.

The in-game radio plays public streams from [fallout.fm](https://fallout.fm), a third-party fan radio; EST2 only links to them.

## API Endpoints (Backend)

- `POST /api/action` — a game turn (accepts optional `mentions: string[]`; inline mentions in `playerAction` are parsed too)
- `POST /api/generate-image`
- `POST /api/scene-descriptor` (artist agent -> descriptor for the parametric renderer)
- `POST /api/gemini-tts`, `POST /api/chirp-tts`, `POST /api/tts` (ElevenLabs), `POST /api/silero-tts` (503 with a status phase while provisioning)
- `GET /api/byok/status` — whether BYOK is required and which providers have a server key (no key material)
- `GET /api/sessions`, `GET|PATCH|DELETE /api/sessions/:id` — cloud sessions (header `x-access-key: $SESSIONS_ACCESS_KEY`)
- `POST /api/mint-session`, `POST /api/clear-session`
- `GET /api/memory-stats` — world memory / GraphRAG diagnostics

Paid endpoints read the player's keys from `x-byok-openrouter`, `x-byok-deepseek`, `x-byok-gemini`, `x-byok-openai`, `x-byok-elevenlabs`, `x-byok-gcp-tts`.

## Regression Smoke Test

There is a dedicated regression smoke script at `tests/smoke-world-memory.mjs`.

What it validates:
- backend can process multiple `/api/action` turns in one session
- `State Updater` runs in `rpc_v1` mode
- canonical world-memory writes are present in Postgres (`turns`, `turn_artifacts`, `entity_state`, `relations`)
- `world_tick` and `encounter_hint` events are generated

Run:
```bash
npm run test:smoke-world-memory
```

Useful flags:
```bash
# keep session data in Postgres for manual inspection
npm run test:smoke-world-memory -- --keep-session

# increase wait-turn budget for encounter generation
npm run test:smoke-world-memory -- --max-turns 12

# run against already running backend instead of auto-start
npm run test:smoke-world-memory -- --backend-url http://127.0.0.1:3001
```

## Eval Gate (Stage 8)

There is an evaluation gate at `tests/eval-memory-gate.mjs` that runs regression scenarios and enforces SLO thresholds:

- `memory_recall@k` (scenario-based proxy)
- `p95 latency` from `turn_artifacts.latency_ms`
- `consistency_violations` (schema/range + dead->alive sanity checks)
- `empty_retrieval_rate`
- `graph_used_rate_on_complex_queries`, `graph_timeout_rate`, `graph_cache_hit_rate`, `graph_context_non_empty_rate`

Run:
```bash
npm run test:eval-memory-gate -- --backend-url http://127.0.0.1:3001
```

Optional SLO env overrides:
```bash
EVAL_MAX_P95_LATENCY_MS=25000
EVAL_MIN_RECALL_AT_K=0.67
EVAL_MAX_CONSISTENCY_VIOLATIONS=0
EVAL_MAX_EMPTY_RETRIEVAL_RATE=0.60
```

Release preflight (smoke + eval):
```bash
npm run test:release-gate -- --backend-url http://127.0.0.1:3001
```

## Deployment

One method for every host: **Docker Compose** (`compose.yaml`). It runs three services:

- `app` — `Dockerfile`: the built frontend + API on port 3000 (`node backend/server.js`), on the official `node:24-bookworm-slim` image, so each rebuild gets the newest Node 24 LTS security patch. Pending DB migrations are applied on every start.
- `db` — Postgres 17 + pgvector (`pgvector/pgvector:pg17`) with a persistent volume: world memory and GraphRAG.
- `silero` — optional self-hosted TTS (`backend/silero/Dockerfile`), enabled with the compose profile `tts`.

Variables are listed in `backend/.env.example`; compose reads them from a `.env` file next to `compose.yaml` (or from the host environment). Required: `POSTGRES_PASSWORD` (URL-safe, e.g. `openssl rand -hex 24`) and at least one text key (`OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY` or `GEMINI_API_KEY`), unless every player brings their own key.

### Any Docker host (no Coolify)

```bash
cp backend/.env.example .env      # set POSTGRES_PASSWORD and a text key
docker compose -f compose.yaml -f compose.standalone.yaml up -d --build
# -> http://localhost:3000   (APP_PORT / APP_BIND to change; put HTTPS in front for public use)
```
Silero too: add `COMPOSE_PROFILES=tts` and `SILERO_TTS_URL=http://silero:3000/tts` to `.env`.

Update: `git pull && docker compose -f compose.yaml -f compose.standalone.yaml up -d --build`.

Sounds: put files into `public/audio/` next to `compose.yaml` (see [Audio](#audio)).

### Coolify

1. New resource from this repository, build pack **Docker Compose**, compose file `/compose.yaml`.
2. Give the `app` service a domain (container port 3000). Don't add `compose.standalone.yaml`: Traefik reaches `app` over the compose network, and a published host port would bypass HTTPS.
3. Set the variables in the resource's Environment Variables (Coolify lists the `${...}` ones from `compose.yaml`).
4. Deploy. For Silero, add `COMPOSE_PROFILES=tts` and `SILERO_TTS_URL=http://silero:3000/tts`.
5. Sounds (optional): copy them to `public/audio/` inside the resource's directory on the server (`/data/coolify/applications/<uuid>/`) and restart.

Node version: `.nvmrc` and `engines` require Node >= 24.22.1 (the 2026-10-20 security release). Nixpacks is no longer used: it is in maintenance mode, defaults to the end-of-life Node 18 and ships only old Node 24 patches.

### Public instances

Anyone who can open the site spends your API credits. For a public deployment set `BYOK_REQUIRED=true` (players bring their own keys) and a long random `SESSIONS_ACCESS_KEY`, and serve it over HTTPS. See [SECURITY.md](SECURITY.md).

## License

The code is released under the [MIT License](LICENSE).

The license covers the code in this repository only. It grants no rights to third-party trademarks, to sounds or music you add to `public/audio/`, or to the radio streams the game links to.

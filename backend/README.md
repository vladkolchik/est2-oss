## Backend environment

All variables with defaults are listed in `backend/.env.example` (copy it to `backend/.env`, which is git-ignored). The backend needs `DATABASE_URL` for its core (world memory + GraphRAG) and at least one text key: `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY` or `GEMINI_API_KEY` — or players bring their own via BYOK.

- `GEMINI_API_KEY` (or legacy `API_KEY`): Gemini narrative generation (when `TEXT_PROVIDER=gemini`) and Gemini image/TTS requests.
- `TEXT_PROVIDER` (optional): `gemini` (default) or `deepseek`. With `deepseek`, the GM runs on `DEEPSEEK_MODEL` (default `deepseek-v4-pro`) and light agents (GraphRAG summary, scene artist) run on `deepseek-v4-flash`. If `DEEPSEEK_API_KEY` is missing, everything falls back to Gemini, then to OpenRouter.
- `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL` (optional): DeepSeek chat-completions client (`backend/deepseekClient.js`). DeepSeek structured output is validated and retried up to 3 times with error feedback.
- `ARTIST_PROVIDER`, `ARTIST_MODEL` (optional): override the scene "artist" agent (`backend/artistService.js`, endpoint `POST /api/scene-descriptor`). Defaults follow `TEXT_PROVIDER` on the light model tier. The descriptor vocabulary is shared with the frontend renderer via `shared/sceneVocabulary.json`.
- `GEMINI_IMAGE_MODEL` (optional): defaults to `gemini-2.5-flash-image`.
- `ELEVENLABS_API_KEY` (optional): enables ElevenLabs proxy endpoint (`POST /api/tts`).
- `GCP_TTS_API_KEY` (optional): enables Chirp 3 HD endpoint (`POST /api/chirp-tts`).
  Alternative names also supported: `GOOGLE_CLOUD_API_KEY`, `CLOUD_TTS_API_KEY`.
- Silero TTS (`POST /api/silero-tts`, managed by `backend/sileroManager.js`):
  - `SILERO_AUTOSTART` (default `true`): auto-provision a local Silero server on backend startup — creates `backend/.silero/venv` (Python 3.9+ required on PATH), installs CPU torch (one-time, ~1.5-2 GB) and downloads the model (~60-150 MB). While provisioning, the endpoint answers `503` with the current phase.
  - `SILERO_MODEL` (default `v3_en`; also `v4_ru`, `v3_de`, `v3_es`, `v3_fr`), `SILERO_SPEAKER` (default `en_0`), `SILERO_PORT` (default `8010`), `SILERO_THREADS` (default `4`).
  - `SILERO_TTS_URL`: set to use an external Silero server instead of autostart (POST `{text, speaker, sample_rate}` -> WAV, or JSON `{audio: base64}`).
- `OPENROUTER_API_KEY` (optional): one key for everything the game calls through OpenRouter (`backend/openrouterClient.js`) — GM/artist/GraphRAG text, embeddings (`openai/text-embedding-3-small`, same vectors as OpenAI), AI images (`google/gemini-2.5-flash-image`) and Gemini voices (`/audio/speech`). Used for any job whose direct key (DeepSeek/Gemini/OpenAI) is missing. Model families follow `TEXT_PROVIDER`; override with `OPENROUTER_MODEL`, `OPENROUTER_LIGHT_MODEL`, `OPENROUTER_EMBEDDING_MODEL`, `OPENROUTER_IMAGE_MODEL`, `OPENROUTER_TTS_MODEL`.
- `OPENAI_API_KEY` (optional): embeddings for world memory (`text-embedding-3-small`). Without it (and without OpenRouter) memories are stored and embedded later from `embedding_jobs`.
- `BYOK_REQUIRED` (optional, default `false`): players' own keys (`x-byok-*` headers from the API KEYS dialog, see `backend/byok.js`) always override server keys; with `true` server keys are not used for player traffic at all.
- `DATABASE_URL` (required for the core memory system): Postgres connection string (`postgres://user:pass@host:5432/db`) for canonical world memory (`turns/events/entities/relations/memory_items`). The backend talks to Postgres directly (`pgRest.js`), no Supabase/PostgREST needed. Postgres needs the pgvector extension available (e.g. the `pgvector/pgvector:pg17` image; `compose.yaml` bundles one).
  - `PG_POOL_MAX` (optional, default `10`): connection pool size.
  - Apply the schema with `node migrate.js` (run from `backend/`; `--status` lists applied/pending). It applies `backend/migrations/*.sql` in order and tracks them in `public.schema_migrations`:
  - `001_world_memory_v1.sql`
  - `002_turn_artifacts_v1.sql` (context retrieval artifacts / observability)
  - `003_state_updater_v1.sql` (transactional state patch updater + world-tick encounters)
  - `005_rls_lockdown_v1.sql` only does anything on Supabase (it is skipped when the `anon` role doesn't exist)
- Stage 7 GraphRAG env flags (optional, safe rollout):
  - `GRAPH_RAG_ENABLED=false` (default off)
  - `GRAPH_RAG_TIMEOUT_MS=500` (GraphRAG lane budget in ms; timeout => immediate fallback)
  - `GRAPH_RAG_COMPLEX_ONLY=true` (run GraphRAG only on complex history/causality queries)
  - `GRAPH_RAG_SUMMARY_MODEL=gemini-2.5-flash` (provider follows `TEXT_PROVIDER`: with deepseek the default is `deepseek-v4-flash`; override the provider with `GRAPH_RAG_SUMMARY_PROVIDER`)
  - `GRAPH_RAG_SUMMARY_TTL_TURNS=6`
  - `GRAPH_RAG_MAX_SCOPES=4`
  - `GRAPH_RAG_MAX_SUBGRAPH_NODES=80`
  - `GRAPH_RAG_MAX_SUBGRAPH_EDGES=140`
  - `GRAPH_RAG_JOB_BATCH=12` (max jobs drained per turn; dedup keeps the per-session queue below this)
  - `GRAPH_RAG_CACHE_WARM_ON_TURN=true`
  - Graph tables/jobs/summaries come from `004_graph_rag_v1.sql` and `006_graph_jobs_dedup_v1.sql` (applied by `migrate.js`).
- `NPC_REFLECTION_EVERY_N_EVENTS` (optional): cadence for stage-6 NPC reflection loop. Default is `4` events per NPC before writing a new reflection update.

Image generation now uses the Gemini Models API via the Google Gen AI JS SDK. The server returns a base64 data URL (e.g., `data:image/jpeg;base64,...`).

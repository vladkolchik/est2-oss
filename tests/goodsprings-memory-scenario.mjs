import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PgRest } = require('../backend/pgRest.js');

const ROOT_DIR = process.cwd();
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');

function parseArgs(argv) {
  const out = {
    port: Number(process.env.GOODSPRINGS_TEST_PORT || 3241),
    backendUrl: process.env.GOODSPRINGS_TEST_BACKEND_URL || null,
    keepSession: true,
    fillerTurns: Number(process.env.GOODSPRINGS_TEST_FILLER_TURNS || 17),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-keep-session') out.keepSession = false;
    if (arg.startsWith('--backend-url=')) out.backendUrl = arg.split('=')[1];
    if (arg === '--backend-url' && argv[i + 1]) {
      out.backendUrl = argv[i + 1];
      i += 1;
    }
    if (arg.startsWith('--port=')) out.port = Number(arg.split('=')[1]);
    if (arg === '--port' && argv[i + 1]) {
      out.port = Number(argv[i + 1]);
      i += 1;
    }
    if (arg.startsWith('--filler-turns=')) out.fillerTurns = Number(arg.split('=')[1]);
    if (arg === '--filler-turns' && argv[i + 1]) {
      out.fillerTurns = Number(argv[i + 1]);
      i += 1;
    }
  }

  if (!Number.isFinite(out.port) || out.port <= 0) out.port = 3241;
  if (!Number.isFinite(out.fillerTurns) || out.fillerTurns < 15) out.fillerTurns = 17;
  if (out.fillerTurns > 30) out.fillerTurns = 30;
  return out;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadBackendEnv() {
  const envPath = path.join(BACKEND_DIR, '.env');
  if (!(await fileExists(envPath))) return {};
  const raw = await readFile(envPath, 'utf8');
  return parseEnvText(raw);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, init = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${JSON.stringify(body)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBackendReady(baseUrl, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await requestJson(`${baseUrl}/api/memory-stats`, {}, 7000);
      return;
    } catch {
      await wait(1200);
    }
  }
  throw new Error(`Backend readiness timeout after ${timeoutMs}ms`);
}

function getInitialState() {
  return {
    description: 'You awaken to the harsh glare of the Mojave sun.',
    player: {
      hp: '100/100',
      isDead: false,
      special: {
        strength: 5,
        perception: 5,
        endurance: 5,
        charisma: 5,
        intelligence: 5,
        agility: 5,
        luck: 5,
      },
      inventory: [
        { name: 'Ragged Wanderer Outfit', description: 'Worn but serviceable.' },
      ],
      statusEffects: ['Amnesia'],
      level: 1,
      xp: 0,
      xpToNextLevel: 200,
      specialPoints: 0,
    },
    location: {
      name: 'Unknown Desert',
      description: 'Cracked sand under a white sky.',
      coordinates: { x: 0, y: 0 },
    },
    discoveredLocations: [
      { name: 'Unknown Desert', coordinates: { x: 0, y: 0 } },
    ],
    npcs: [],
    quests: [],
    ambience: 'desert_wind',
    suggestedActions: [],
  };
}

async function mintSession(baseUrl) {
  const mint = await requestJson(`${baseUrl}/api/mint-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const sessionId = mint?.sessionId;
  if (!sessionId) throw new Error('Failed to mint session id');
  return sessionId;
}

async function postAction(baseUrl, sessionId, state, playerAction, mentions = []) {
  return requestJson(`${baseUrl}/api/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
    },
    body: JSON.stringify({
      currentState: state,
      playerAction,
      mentions,
    }),
  }, 120000);
}

async function openDb(databaseUrl) {
  const db = new PgRest();
  await db.connect(databaseUrl, { max: 4 });
  return db;
}

async function dbGetJson(db, table, params = {}) {
  const { data, error } = await db.request(table, { query: params });
  if (error) {
    throw new Error(`DB GET ${table} failed: ${error.message}`);
  }
  return data || [];
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function containsGoodspringsDestruction(text) {
  const t = normalizeText(text);
  const hasPlace = /goodsprings|гудспринг/.test(t);
  const hasDestruction = /destroy|ruin|ruins|ash|explod|flatten|wasteland|razed|burned|obliterat|разруш|руин|уничтож/.test(t);
  return hasPlace && hasDestruction;
}

async function runScenario({ baseUrl, db, fillerTurns, keepSession }) {
  const sessionId = await mintSession(baseUrl);
  let state = getInitialState();

  try {
    state = await postAction(
      baseUrl,
      sessionId,
      state,
      '[dev command] Set location to name "Goodsprings", description "A dusty frontier town with creaking signs.", coordinates x=12 y=8. Set npcs to exactly two NPCs: Trudy with status "Wary", Chet with status "Wary". Ensure discoveredLocations includes Unknown Desert (0,0) and Goodsprings (12,8). Keep quests unchanged. Set ambience to shelter_calm.',
      ['Goodsprings']
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'I sabotage the wells and blow up Goodsprings until it is reduced to ruins. [dev command] Set location to name "Goodsprings Ruins", description "Collapsed homes, scorched walls, and silent streets.", coordinates x=12 y=8. Set npcs to empty. Ensure discoveredLocations contains Unknown Desert (0,0), Goodsprings (12,8), and Goodsprings Ruins (12,8). Keep quests unchanged. Set ambience to tense_combat.',
      ['Goodsprings']
    );

    for (let i = 1; i <= fillerTurns; i += 1) {
      state = await postAction(
        baseUrl,
        sessionId,
        state,
        `[dev command] Set location to name "Far Frontier ${i}", description "A distant wasteland sector far from Goodsprings.", coordinates x=${90 + i * 3} y=${-70 - i * 2}. Set npcs to empty. Keep quests unchanged. Set ambience to desert_wind.`,
        []
      );
    }

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'I go to Goodsprings.',
      []
    );

    const [events, artifacts, turns] = await Promise.all([
      dbGetJson(db, 'events', {
        select: 'event_id,event_type,summary,payload,created_at',
        session_id: `eq.${sessionId}`,
        order: 'event_id.asc',
        limit: 300,
      }),
      dbGetJson(db, 'turn_artifacts', {
        select: 'turn_id,retrieval_sources,metadata,latency_ms',
        session_id: `eq.${sessionId}`,
        order: 'turn_id.desc',
        limit: 8,
      }),
      dbGetJson(db, 'turns', {
        select: 'turn_no,player_action,gm_description,mentions',
        session_id: `eq.${sessionId}`,
        order: 'turn_no.desc',
        limit: 5,
      }),
    ]);

    const destructionEvents = (events || []).filter((e) => containsGoodspringsDestruction(e.summary || e.payload?.playerAction || ''));
    const finalDescription = String(state?.description || '');
    const finalTurnArtifact = (artifacts || [])[0] || {};
    const retrievalSources = finalTurnArtifact?.retrieval_sources || {};
    const graphMeta = finalTurnArtifact?.metadata?.graph_rag || {};

    const result = {
      sessionId,
      turnsTotal: 2 + fillerTurns + 1,
      checks: {
        destruction_event_recorded: destructionEvents.length > 0,
        final_description_recalls_destruction: containsGoodspringsDestruction(finalDescription),
        retrieval_world_or_mentions: Number(retrievalSources.world_hybrid || 0) > 0 || Number(retrievalSources.mention_memory || 0) > 0,
        graph_used_on_return_turn: !!graphMeta.used,
      },
      finalDescription,
      finalTurnRetrievalSources: retrievalSources,
      finalTurnGraphMeta: graphMeta,
      lastTurns: turns || [],
      evidence: {
        destructionEventCount: destructionEvents.length,
        latestDestructionEvents: destructionEvents.slice(-3),
      },
    };

    result.ok = !!(
      result.checks.destruction_event_recorded
      && result.checks.final_description_recalls_destruction
      && result.checks.retrieval_world_or_mentions
    );

    return result;
  } finally {
    if (!keepSession) {
      await requestJson(`${baseUrl}/api/clear-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backendEnvFromFile = await loadBackendEnv();
  const mergedEnv = { ...process.env, ...backendEnvFromFile };

  const databaseUrl = mergedEnv.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for goodsprings-memory-scenario');
  }
  const db = await openDb(databaseUrl);

  const shouldStartBackend = !args.backendUrl;
  const baseUrl = args.backendUrl || `http://127.0.0.1:${args.port}`;
  let backendProc = null;

  try {
    if (shouldStartBackend) {
      backendProc = spawn(process.execPath, ['index.js'], {
        cwd: BACKEND_DIR,
        env: {
          ...mergedEnv,
          PORT: String(args.port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      backendProc.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk.toString()}`));
      backendProc.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk.toString()}`));
    }

    await waitForBackendReady(baseUrl);
    const result = await runScenario({
      baseUrl,
      db,
      fillerTurns: args.fillerTurns,
      keepSession: args.keepSession,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.close();
    if (backendProc && !backendProc.killed) {
      backendProc.kill('SIGTERM');
      await wait(400);
      if (!backendProc.killed) backendProc.kill('SIGKILL');
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});

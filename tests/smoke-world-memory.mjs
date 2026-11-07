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
    port: Number(process.env.SMOKE_BACKEND_PORT || 3220),
    maxTurns: Number(process.env.SMOKE_MAX_TURNS || 8),
    keepSession: false,
    backendUrl: process.env.SMOKE_BACKEND_URL || null,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep-session') {
      out.keepSession = true;
      continue;
    }
    if (arg.startsWith('--port=')) {
      out.port = Number(arg.split('=')[1]);
      continue;
    }
    if (arg === '--port' && argv[i + 1]) {
      out.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-turns=')) {
      out.maxTurns = Number(arg.split('=')[1]);
      continue;
    }
    if (arg === '--max-turns' && argv[i + 1]) {
      out.maxTurns = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--backend-url=')) {
      out.backendUrl = arg.split('=')[1];
      continue;
    }
    if (arg === '--backend-url' && argv[i + 1]) {
      out.backendUrl = argv[i + 1];
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  if (!out.backendUrl && positional[0] && /^https?:\/\//i.test(positional[0])) {
    out.backendUrl = positional[0];
  }

  if (!Number.isFinite(out.port) || out.port <= 0) out.port = 3220;
  if (!Number.isFinite(out.maxTurns) || out.maxTurns < 2) out.maxTurns = 8;
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
    if (!key) continue;
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

function mergeEnv(base, extra) {
  return { ...base, ...extra };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, init = {}, timeoutMs = 40000) {
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
        { name: 'Empty Nuka-Cola Bottle', description: 'Could be reused.' },
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

async function countEvents(db, sessionId, eventType) {
  const rows = await dbGetJson(db, 'events', {
    select: 'event_id',
    session_id: `eq.${sessionId}`,
    event_type: `eq.${eventType}`,
    limit: 1000,
  });
  return Array.isArray(rows) ? rows.length : 0;
}

async function countRows(db, table, sessionId) {
  const rows = await dbGetJson(db, table, {
    select: '*',
    session_id: `eq.${sessionId}`,
    limit: 1000,
  });
  return Array.isArray(rows) ? rows.length : 0;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const backendEnvFromFile = await loadBackendEnv();
  const mergedEnv = mergeEnv(process.env, backendEnvFromFile);

  const databaseUrl = mergedEnv.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for smoke-world-memory');
  }
  const db = await openDb(databaseUrl);

  const shouldStartBackend = !args.backendUrl;
  const baseUrl = args.backendUrl || `http://127.0.0.1:${args.port}`;
  let backendProc = null;

  try {
    if (shouldStartBackend) {
      try {
        backendProc = spawn(process.execPath, ['index.js'], {
          cwd: BACKEND_DIR,
          env: {
            ...mergedEnv,
            PORT: String(args.port),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        if (error?.code === 'EPERM') {
          throw new Error('Cannot spawn backend process in this environment (EPERM). Start backend manually and run with --backend-url http://127.0.0.1:3001');
        }
        throw error;
      }

      backendProc.stdout.on('data', (chunk) => {
        process.stdout.write(`[backend] ${chunk.toString()}`);
      });
      backendProc.stderr.on('data', (chunk) => {
        process.stderr.write(`[backend] ${chunk.toString()}`);
      });
    }

    await waitForBackendReady(baseUrl);

    const stats = await requestJson(`${baseUrl}/api/memory-stats`);
    if (!stats?.world?.enabled) {
      throw new Error(`World memory is not enabled. world.lastInitError=${stats?.world?.lastInitError || 'n/a'}`);
    }

    const mint = await requestJson(`${baseUrl}/api/mint-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const sessionId = mint?.sessionId;
    if (!sessionId) {
      throw new Error('Failed to mint session id');
    }

    let state = getInitialState();
    const headers = {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
    };

    const firstAction = '[dev command] Set location to name "Makeshift Prospector Camp", description "A rough camp of salvagers", coordinates x=2 y=1. Set npcs to exactly one NPC: Dusty Pete with status "Hostile". Ensure discoveredLocations includes Unknown Desert (0,0) and Makeshift Prospector Camp (2,1). Keep quests empty. Set ambience to tense_combat.';
    state = await requestJson(`${baseUrl}/api/action`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        currentState: state,
        playerAction: firstAction,
        mentions: [],
      }),
    }, 90000);

    let worldTickCount = 0;
    let encounterHintCount = 0;

    for (let i = 0; i < args.maxTurns; i += 1) {
      const waitAction = '[dev command] Keep current location unchanged with same coordinates. Set npcs to []. Keep quests unchanged. Set ambience to desert_wind.';
      state = await requestJson(`${baseUrl}/api/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          currentState: state,
          playerAction: waitAction,
          mentions: [],
        }),
      }, 90000);

      // Pull live counters from canonical DB each turn.
      [worldTickCount, encounterHintCount] = await Promise.all([
        countEvents(db, sessionId, 'world_tick'),
        countEvents(db, sessionId, 'encounter_hint'),
      ]);

      if (worldTickCount > 0 && encounterHintCount > 0) break;
    }

    const [turnCount, artifactCount, relationCount, stateCount] = await Promise.all([
      countRows(db, 'turns', sessionId),
      countRows(db, 'turn_artifacts', sessionId),
      countRows(db, 'relations', sessionId),
      countRows(db, 'entity_state', sessionId),
    ]);

    const artifactRows = await dbGetJson(db, 'turn_artifacts', {
      select: 'turn_id,metadata',
      session_id: `eq.${sessionId}`,
      order: 'turn_id.desc',
      limit: 1,
    });
    const latestArtifact = artifactRows?.[0] || null;
    const updaterMode = latestArtifact?.metadata?.state_updater?.mode || null;

    const failures = [];
    if (turnCount < 2) failures.push(`Expected at least 2 turns, got ${turnCount}`);
    if (artifactCount < 1) failures.push('No turn_artifacts rows were written');
    if (stateCount < 1) failures.push('No entity_state rows were written');
    if (relationCount < 1) failures.push('No relations rows were written');
    if (worldTickCount < 1) failures.push('No world_tick events were generated');
    if (encounterHintCount < 1) failures.push('No encounter_hint events were generated');
    if (updaterMode !== 'rpc_v1') failures.push(`Expected state_updater.mode=rpc_v1, got ${updaterMode || 'null'}`);

    const summary = {
      ok: failures.length === 0,
      sessionId,
      backend: baseUrl,
      turns: turnCount,
      artifacts: artifactCount,
      entityState: stateCount,
      relations: relationCount,
      worldTick: worldTickCount,
      encounterHint: encounterHintCount,
      updaterMode,
      finalLocation: state?.location?.name || null,
      finalNpcCount: Array.isArray(state?.npcs) ? state.npcs.length : null,
      maxTurns: args.maxTurns,
    };

    console.log(JSON.stringify(summary, null, 2));

    if (!args.keepSession) {
      await requestJson(`${baseUrl}/api/clear-session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    }

    if (failures.length) {
      throw new Error(`Smoke test failed:\n- ${failures.join('\n- ')}`);
    }
  } finally {
    await db.close();
    if (backendProc && !backendProc.killed) {
      backendProc.kill('SIGTERM');
      await wait(400);
      if (!backendProc.killed) {
        backendProc.kill('SIGKILL');
      }
    }
  }
}

run().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});

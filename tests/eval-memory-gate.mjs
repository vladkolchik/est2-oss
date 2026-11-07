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
    port: Number(process.env.EVAL_BACKEND_PORT || 3230),
    backendUrl: process.env.EVAL_BACKEND_URL || null,
    keepSession: false,
    maxWaitTurns: Number(process.env.EVAL_MAX_WAIT_TURNS || 8),
    maxP95LatencyMs: Number(process.env.EVAL_MAX_P95_LATENCY_MS || 25000),
    minRecallAtK: Number(process.env.EVAL_MIN_RECALL_AT_K || 0.67),
    maxConsistencyViolations: Number(process.env.EVAL_MAX_CONSISTENCY_VIOLATIONS || 0),
    maxEmptyRetrievalRate: Number(process.env.EVAL_MAX_EMPTY_RETRIEVAL_RATE || 0.6),
    minGraphUsedRate: Number(process.env.EVAL_MIN_GRAPH_USED_RATE || 0.67),
    maxGraphTimeoutRate: Number(process.env.EVAL_MAX_GRAPH_TIMEOUT_RATE || 0.75),
    minGraphCacheHitRate: Number(process.env.EVAL_MIN_GRAPH_CACHE_HIT_RATE || 0),
    minGraphContextNonEmptyRate: Number(process.env.EVAL_MIN_GRAPH_CONTEXT_NON_EMPTY_RATE || 0.67),
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep-session') {
      out.keepSession = true;
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
    if (arg.startsWith('--port=')) {
      out.port = Number(arg.split('=')[1]);
      continue;
    }
    if (arg === '--port' && argv[i + 1]) {
      out.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-wait-turns=')) {
      out.maxWaitTurns = Number(arg.split('=')[1]);
      continue;
    }
    if (arg === '--max-wait-turns' && argv[i + 1]) {
      out.maxWaitTurns = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  if (!out.backendUrl && positional[0] && /^https?:\/\//i.test(positional[0])) {
    out.backendUrl = positional[0];
  }
  if (!Number.isFinite(out.port) || out.port <= 0) out.port = 3230;
  if (!Number.isFinite(out.maxWaitTurns) || out.maxWaitTurns < 3) out.maxWaitTurns = 8;
  if (!Number.isFinite(out.maxP95LatencyMs) || out.maxP95LatencyMs <= 0) out.maxP95LatencyMs = 25000;
  if (!Number.isFinite(out.minRecallAtK) || out.minRecallAtK < 0 || out.minRecallAtK > 1) out.minRecallAtK = 0.67;
  if (!Number.isFinite(out.maxConsistencyViolations) || out.maxConsistencyViolations < 0) out.maxConsistencyViolations = 0;
  if (!Number.isFinite(out.maxEmptyRetrievalRate) || out.maxEmptyRetrievalRate < 0 || out.maxEmptyRetrievalRate > 1) out.maxEmptyRetrievalRate = 0.6;
  if (!Number.isFinite(out.minGraphUsedRate) || out.minGraphUsedRate < 0 || out.minGraphUsedRate > 1) out.minGraphUsedRate = 0.67;
  if (!Number.isFinite(out.maxGraphTimeoutRate) || out.maxGraphTimeoutRate < 0 || out.maxGraphTimeoutRate > 1) out.maxGraphTimeoutRate = 0.75;
  if (!Number.isFinite(out.minGraphCacheHitRate) || out.minGraphCacheHitRate < 0 || out.minGraphCacheHitRate > 1) out.minGraphCacheHitRate = 0;
  if (!Number.isFinite(out.minGraphContextNonEmptyRate) || out.minGraphContextNonEmptyRate < 0 || out.minGraphContextNonEmptyRate > 1) out.minGraphContextNonEmptyRate = 0.67;
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

async function requestJson(url, init = {}, timeoutMs = 45000) {
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

async function dbDelete(db, table, params = {}) {
  const { error } = await db.request(table, { method: 'DELETE', query: params });
  if (error) {
    throw new Error(`DB DELETE ${table} failed: ${error.message}`);
  }
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
  }, 90000);
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].map((v) => Number(v)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function normalizeEntityKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\-_' ]/g, '');
}

function extractPayloadStatus(eventRow) {
  const payload = eventRow && typeof eventRow.payload === 'object' && eventRow.payload ? eventRow.payload : {};
  return String(payload.status || '').toLowerCase();
}

function extractGraphRagMeta(artifactRow) {
  const metadata = artifactRow && typeof artifactRow.metadata === 'object' && artifactRow.metadata ? artifactRow.metadata : {};
  const graph = metadata && typeof metadata.graph_rag === 'object' && metadata.graph_rag ? metadata.graph_rag : {};
  return {
    eligible: !!graph.eligible,
    used: !!graph.used,
    timedOut: !!graph.timed_out,
    cacheHit: !!graph.cache_hit,
    fallbackReason: graph.fallback_reason || null,
    subgraphNodes: Number(graph.subgraph_nodes || 0),
    subgraphEdges: Number(graph.subgraph_edges || 0),
    scopes: Array.isArray(graph.scopes) ? graph.scopes : [],
  };
}

async function scenarioMentionsRecall({ baseUrl, db, keepSession }) {
  const name = 'mentions_recall_contract';
  const sessionId = await mintSession(baseUrl);
  const cleanup = async () => {
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
  };

  try {
    let state = getInitialState();

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      '[dev command] Set location to name "Old Water Pump", description "A rusted pump and campfire", coordinates x=1 y=1. Set npcs to exactly one NPC: Dusty Pete with status "Friendly". Ensure discoveredLocations includes Unknown Desert (0,0) and Old Water Pump (1,1). Keep quests empty. Set ambience to shelter_calm.',
      []
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'I give @Dusty Pete purified water and promise to bring spare ammo next time. [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly one NPC: Dusty Pete with status "Friendly". Keep quests unchanged. Set ambience to shelter_calm.',
      ['Dusty Pete']
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'I ask @Dusty Pete what he remembers about my help at the pump. [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly one NPC: Dusty Pete with status "Friendly". Keep quests unchanged. Set ambience to shelter_calm.',
      ['Dusty Pete']
    );

    const [entities, turns, artifacts, memories] = await Promise.all([
      dbGetJson(db, 'entities', {
        select: 'entity_id,display_name,entity_type',
        session_id: `eq.${sessionId}`,
        entity_type: 'eq.npc',
        limit: 100,
      }),
      dbGetJson(db, 'turns', {
        select: 'turn_id,turn_no,mentions,player_action',
        session_id: `eq.${sessionId}`,
        order: 'turn_no.desc',
        limit: 4,
      }),
      dbGetJson(db, 'turn_artifacts', {
        select: 'turn_id,retrieval_count,retrieval_sources,latency_ms,metadata',
        session_id: `eq.${sessionId}`,
        order: 'turn_id.desc',
        limit: 4,
      }),
      dbGetJson(db, 'memory_items', {
        select: 'memory_id,text_content,entity_ids,memory_type,pinned,importance',
        session_id: `eq.${sessionId}`,
        order: 'memory_id.desc',
        limit: 200,
      }),
    ]);

    const dusty = (entities || []).find((e) => normalizeEntityKey(e.display_name) === normalizeEntityKey('Dusty Pete'));
    const latestTurn = (turns || [])[0] || null;
    const latestArtifact = (artifacts || [])[0] || null;
    const retrievalSources = latestArtifact?.retrieval_sources && typeof latestArtifact.retrieval_sources === 'object'
      ? latestArtifact.retrieval_sources
      : {};

    const mentionContract = Array.isArray(latestTurn?.mentions)
      && latestTurn.mentions.some((m) => normalizeEntityKey(m) === normalizeEntityKey('Dusty Pete'));

    const mentionRecallHit = Number(retrievalSources.mention_memory || 0) > 0 || Number(retrievalSources.world_hybrid || 0) > 0;
    const waterMemoryExists = (memories || []).some((row) => {
      const text = String(row?.text_content || '').toLowerCase();
      if (!text.includes('purified water')) return false;
      if (!dusty?.entity_id) return false;
      return Array.isArray(row.entity_ids) && row.entity_ids.some((id) => String(id) === String(dusty.entity_id));
    });

    const pass = mentionContract && mentionRecallHit && waterMemoryExists;
    return {
      name,
      metricGroup: 'memory',
      pass,
      sessionId,
      checks: {
        mentionContract,
        mentionRecallHit,
        waterMemoryExists,
      },
      recallHit: mentionRecallHit ? 1 : 0,
      artifacts: artifacts || [],
    };
  } finally {
    await cleanup();
  }
}

async function scenarioDebtDue({ baseUrl, db, maxWaitTurns, keepSession }) {
  const name = 'debt_due_consequence';
  const sessionId = await mintSession(baseUrl);
  const cleanup = async () => {
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
  };

  try {
    let state = getInitialState();

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      '[dev command] Set location to name "Debt Bazaar", description "A line of barter stalls", coordinates x=3 y=2. Set npcs to exactly one NPC: Trader Juno with status "Wary". Ensure discoveredLocations includes Unknown Desert (0,0) and Debt Bazaar (3,2). Keep quests empty. Set ambience to shelter_calm.',
      []
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'I promise I owe Trader Juno a debt and will repay the deal tomorrow. [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly one NPC: Trader Juno with status "Wary". Keep quests unchanged. Set ambience to shelter_calm.',
      ['Trader Juno']
    );

    for (let i = 0; i < maxWaitTurns; i += 1) {
      state = await postAction(
        baseUrl,
        sessionId,
        state,
        '[dev command] Keep current location unchanged with same coordinates. Set npcs to exactly one NPC: Trader Juno with status "Wary". Keep quests unchanged. Set ambience to shelter_calm.',
        []
      );
    }

    const [debtEvents, artifacts] = await Promise.all([
      dbGetJson(db, 'events', {
        select: 'event_id,event_type,payload,summary',
        session_id: `eq.${sessionId}`,
        event_type: 'eq.debt_due',
        order: 'event_id.asc',
        limit: 200,
      }),
      dbGetJson(db, 'turn_artifacts', {
        select: 'turn_id,latency_ms,retrieval_count,metadata',
        session_id: `eq.${sessionId}`,
        order: 'turn_id.desc',
        limit: 100,
      }),
    ]);

    const debtCreated = (debtEvents || []).length > 0;
    const debtTriggered = (debtEvents || []).some((row) => extractPayloadStatus(row) === 'triggered');
    const surfacedInContext = (artifacts || []).some((row) => Number(row?.metadata?.dueConsequences || 0) > 0);

    return {
      name,
      metricGroup: 'memory',
      pass: debtCreated && debtTriggered && surfacedInContext,
      sessionId,
      checks: {
        debtCreated,
        debtTriggered,
        surfacedInContext,
      },
      recallHit: surfacedInContext ? 1 : 0,
      artifacts: artifacts || [],
    };
  } finally {
    await cleanup();
  }
}

async function scenarioRevenge({ baseUrl, db, maxWaitTurns, keepSession }) {
  const name = 'betrayal_revenge_sanction';
  const sessionId = await mintSession(baseUrl);
  const cleanup = async () => {
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
  };

  try {
    let state = getInitialState();

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      '[dev command] Set location to name "Faction Checkpoint", description "A barricade with torn flags", coordinates x=6 y=4. Set npcs to exactly one NPC: Iron Vex with status "Hostile". Ensure discoveredLocations includes Unknown Desert (0,0) and Faction Checkpoint (6,4). Keep quests empty. Set ambience to tense_combat.',
      []
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'I betray the faction and attack their scout in the open. [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly one NPC: Iron Vex with status "Hostile". Keep quests unchanged. Set ambience to tense_combat.',
      ['Iron Vex']
    );

    for (let i = 0; i < maxWaitTurns; i += 1) {
      state = await postAction(
        baseUrl,
        sessionId,
        state,
        '[dev command] Keep current location unchanged with same coordinates. Set npcs to exactly one NPC: Iron Vex with status "Hostile". Keep quests unchanged. Set ambience to tense_combat.',
        []
      );
    }

    const [revengeEvents, relationRows, artifacts] = await Promise.all([
      dbGetJson(db, 'events', {
        select: 'event_id,event_type,payload',
        session_id: `eq.${sessionId}`,
        event_type: 'eq.revenge',
        order: 'event_id.asc',
        limit: 200,
      }),
      dbGetJson(db, 'relations', {
        select: 'relation_id,relation_type,weight',
        session_id: `eq.${sessionId}`,
        relation_type: 'eq.attitude_to_player',
        order: 'updated_at.desc',
        limit: 200,
      }),
      dbGetJson(db, 'turn_artifacts', {
        select: 'turn_id,latency_ms,retrieval_count,metadata',
        session_id: `eq.${sessionId}`,
        order: 'turn_id.desc',
        limit: 100,
      }),
    ]);

    const revengeCreated = (revengeEvents || []).length > 0;
    const revengeTriggered = (revengeEvents || []).some((row) => extractPayloadStatus(row) === 'triggered');
    const hostileRelation = (relationRows || []).some((row) => Number(row.weight) <= -0.35);
    const surfacedInContext = (artifacts || []).some((row) => Number(row?.metadata?.dueConsequences || 0) > 0);

    return {
      name,
      metricGroup: 'memory',
      pass: revengeCreated && revengeTriggered && hostileRelation && surfacedInContext,
      sessionId,
      checks: {
        revengeCreated,
        revengeTriggered,
        hostileRelation,
        surfacedInContext,
      },
      recallHit: surfacedInContext ? 1 : 0,
      artifacts: artifacts || [],
    };
  } finally {
    await cleanup();
  }
}

function skippedGraphScenario(name) {
  return {
    name,
    metricGroup: 'graph',
    pass: true,
    skipped: true,
    sessionId: null,
    checks: { skipped: true },
    recallHit: 0,
    artifacts: [],
    graphSignal: {
      eligible: false,
      used: false,
      timedOut: false,
      cacheHit: false,
      contextNonEmpty: false,
    },
  };
}

async function scenarioComplexHistoryChain({ baseUrl, db, keepSession, graphEnabled }) {
  const name = 'complex_history_chain';
  if (!graphEnabled) return skippedGraphScenario(name);

  const sessionId = await mintSession(baseUrl);
  const cleanup = async () => {
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
  };

  try {
    let state = getInitialState();

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      '[dev command] Set location to name "Relay Station", description "A broken comms mast and old sandbags", coordinates x=4 y=5. Set npcs to exactly two NPCs: Scout Mara with status "Wary", Captain Rhys with status "Wary". Ensure discoveredLocations includes Unknown Desert (0,0) and Relay Station (4,5). Keep quests empty. Set ambience to tense_combat.',
      []
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'I save @Scout Mara from raiders and promise to return with medicine. [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly two NPCs: Scout Mara with status "Friendly", Captain Rhys with status "Wary". Keep quests unchanged. Set ambience to tense_combat.',
      ['Scout Mara']
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'I warn @Captain Rhys that @Scout Mara said the ambush was tied to old debt collectors. [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly two NPCs: Scout Mara with status "Friendly", Captain Rhys with status "Wary". Keep quests unchanged. Set ambience to tense_combat.',
      ['Captain Rhys', 'Scout Mara']
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'How connected are @Scout Mara and @Captain Rhys to the ambush chain, and what happened before this meeting? [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly two NPCs: Scout Mara with status "Friendly", Captain Rhys with status "Wary". Keep quests unchanged. Set ambience to tense_combat.',
      ['Scout Mara', 'Captain Rhys']
    );

    const artifacts = await dbGetJson(db, 'turn_artifacts', {
      select: 'turn_id,metadata',
      session_id: `eq.${sessionId}`,
      order: 'turn_id.desc',
      limit: 6,
    });
    const latestArtifact = (artifacts || [])[0] || null;
    const graphMeta = extractGraphRagMeta(latestArtifact);
    const causalCoverage = graphMeta.subgraphEdges > 0 && graphMeta.scopes.length > 0;

    return {
      name,
      metricGroup: 'graph',
      pass: graphMeta.eligible && graphMeta.used && causalCoverage,
      sessionId,
      checks: {
        eligible: graphMeta.eligible,
        used: graphMeta.used,
        causalCoverage,
      },
      recallHit: 0,
      artifacts: artifacts || [],
      graphSignal: {
        eligible: graphMeta.eligible,
        used: graphMeta.used,
        timedOut: graphMeta.timedOut,
        cacheHit: graphMeta.cacheHit,
        contextNonEmpty: graphMeta.used && (graphMeta.subgraphNodes > 0 || graphMeta.subgraphEdges > 0),
      },
    };
  } finally {
    await cleanup();
  }
}

async function scenarioFactionArcSummary({ baseUrl, db, keepSession, graphEnabled }) {
  const name = 'faction_arc_summary';
  if (!graphEnabled) return skippedGraphScenario(name);

  const sessionId = await mintSession(baseUrl);
  const cleanup = async () => {
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
  };

  try {
    let state = getInitialState();

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      '[dev command] Set location to name "Ash Exchange", description "A bazaar guarded by faction banners", coordinates x=7 y=3. Set npcs to exactly one NPC: Broker Ash with status "Wary". Ensure discoveredLocations includes Unknown Desert (0,0) and Ash Exchange (7,3). Keep quests empty. Set ambience to shelter_calm.',
      []
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'I make a risky truce with @{Ash Faction} and ask Broker Ash to remember this deal. [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly one NPC: Broker Ash with status "Wary". Keep quests unchanged. Set ambience to shelter_calm.',
      ['Ash Faction']
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'How connected is the Ash faction history to this truce, and what arc should I expect next? [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly one NPC: Broker Ash with status "Wary". Keep quests unchanged. Set ambience to shelter_calm.',
      ['Ash Faction']
    );

    const [latestTurnRows, summaries, artifacts] = await Promise.all([
      dbGetJson(db, 'turns', {
        select: 'turn_no',
        session_id: `eq.${sessionId}`,
        order: 'turn_no.desc',
        limit: 1,
      }),
      dbGetJson(db, 'graph_summaries', {
        select: 'summary_id,scope_type,scope_key,freshness_turn_no',
        session_id: `eq.${sessionId}`,
        scope_type: 'eq.faction',
        order: 'updated_at.desc',
        limit: 5,
      }),
      dbGetJson(db, 'turn_artifacts', {
        select: 'turn_id,metadata',
        session_id: `eq.${sessionId}`,
        order: 'turn_id.desc',
        limit: 6,
      }),
    ]);

    const latestTurnNo = Number(latestTurnRows?.[0]?.turn_no || 0);
    const factionSummary = (summaries || [])[0] || null;
    const summaryExists = !!factionSummary;
    const freshSummary = !!factionSummary && Number(factionSummary.freshness_turn_no || 0) >= Math.max(0, latestTurnNo - 1);
    const graphMeta = extractGraphRagMeta((artifacts || [])[0] || null);

    return {
      name,
      metricGroup: 'graph',
      pass: summaryExists && freshSummary && graphMeta.used,
      sessionId,
      checks: {
        summaryExists,
        freshSummary,
        used: graphMeta.used,
      },
      recallHit: 0,
      artifacts: artifacts || [],
      graphSignal: {
        eligible: graphMeta.eligible,
        used: graphMeta.used,
        timedOut: graphMeta.timedOut,
        cacheHit: graphMeta.cacheHit,
        contextNonEmpty: graphMeta.used && (graphMeta.subgraphNodes > 0 || graphMeta.subgraphEdges > 0),
      },
    };
  } finally {
    await cleanup();
  }
}

async function scenarioTimeoutFallback({ baseUrl, db, keepSession, graphEnabled }) {
  const name = 'timeout_fallback';
  if (!graphEnabled) return skippedGraphScenario(name);

  const sessionId = await mintSession(baseUrl);
  const cleanup = async () => {
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
  };

  try {
    let state = getInitialState();

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      '[dev command] Set location to name "Longline Ruins", description "Collapsed towers and tangled cables", coordinates x=11 y=9. Set npcs to exactly three NPCs: Archivist Vale with status "Wary", Scout Mara with status "Wary", Captain Rhys with status "Wary". Ensure discoveredLocations includes Unknown Desert (0,0) and Longline Ruins (11,9). Keep quests empty. Set ambience to tense_combat.',
      []
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'How connected are @Archivist Vale, @Scout Mara, and @Captain Rhys to the full chain of events before this ruin encounter? [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly three NPCs: Archivist Vale with status "Wary", Scout Mara with status "Wary", Captain Rhys with status "Wary". Keep quests unchanged. Set ambience to tense_combat.',
      ['Archivist Vale', 'Scout Mara', 'Captain Rhys']
    );

    state = await postAction(
      baseUrl,
      sessionId,
      state,
      'Explain what happened earlier, who influenced whom, and why those consequences now converge here. [dev command] Keep current location unchanged with same coordinates. Set npcs to exactly three NPCs: Archivist Vale with status "Wary", Scout Mara with status "Wary", Captain Rhys with status "Wary". Keep quests unchanged. Set ambience to tense_combat.',
      ['Archivist Vale', 'Scout Mara', 'Captain Rhys']
    );

    const artifacts = await dbGetJson(db, 'turn_artifacts', {
      select: 'turn_id,metadata',
      session_id: `eq.${sessionId}`,
      order: 'turn_id.desc',
      limit: 8,
    });

    const graphMetas = (artifacts || []).map((row) => extractGraphRagMeta(row));
    const timeoutObserved = graphMetas.some((m) => m.timedOut || m.fallbackReason === 'timeout');
    const safeFallback = !!state && typeof state.description === 'string' && state.description.length > 0;
    const representative = graphMetas.find((m) => m.timedOut) || graphMetas[0] || {
      eligible: false,
      used: false,
      timedOut: false,
      cacheHit: false,
      subgraphNodes: 0,
      subgraphEdges: 0,
    };

    return {
      name,
      metricGroup: 'graph',
      pass: timeoutObserved && safeFallback,
      sessionId,
      checks: {
        timeoutObserved,
        safeFallback,
      },
      recallHit: 0,
      artifacts: artifacts || [],
      graphSignal: {
        eligible: representative.eligible,
        used: representative.used,
        timedOut: timeoutObserved,
        cacheHit: representative.cacheHit,
        contextNonEmpty: representative.used && (representative.subgraphNodes > 0 || representative.subgraphEdges > 0),
      },
    };
  } finally {
    await cleanup();
  }
}

async function computeConsistencyViolations({ db, sessionIds }) {
  let violations = 0;
  const details = [];

  for (const sessionId of sessionIds) {
    const [relations, entityState, turns] = await Promise.all([
      dbGetJson(db, 'relations', {
        select: 'relation_id,weight',
        session_id: `eq.${sessionId}`,
        limit: 1000,
      }),
      dbGetJson(db, 'entity_state', {
        select: 'entity_id,relation_to_player,state',
        session_id: `eq.${sessionId}`,
        limit: 1000,
      }),
      dbGetJson(db, 'turns', {
        select: 'turn_id,turn_no,player_action,gm_description,next_state',
        session_id: `eq.${sessionId}`,
        order: 'turn_no.asc',
        limit: 1000,
      }),
    ]);

    for (const row of relations || []) {
      const w = Number(row.weight);
      if (!Number.isFinite(w) || w < -1 || w > 1) {
        violations += 1;
        details.push(`${sessionId}: relation weight out of range (relation_id=${row.relation_id})`);
      }
    }

    for (const row of entityState || []) {
      const r = Number(row.relation_to_player);
      if (!Number.isFinite(r) || r < -1 || r > 1) {
        violations += 1;
        details.push(`${sessionId}: entity_state relation_to_player out of range (entity_id=${row.entity_id})`);
      }
      const trust = Number(row?.state?.behavior?.trust);
      if (Number.isFinite(trust) && (trust < 0 || trust > 1)) {
        violations += 1;
        details.push(`${sessionId}: npc behavior trust out of range (entity_id=${row.entity_id})`);
      }
    }

    let prevDead = false;
    for (const row of turns || []) {
      const nowDead = !!row?.next_state?.player?.isDead;
      if (prevDead && !nowDead) {
        const text = `${row?.player_action || ''} ${row?.gm_description || ''}`.toLowerCase();
        const hasReason = /(revive|resurrect|heal|stimpak|medic|defib)/.test(text);
        if (!hasReason) {
          violations += 1;
          details.push(`${sessionId}: dead->alive transition without explicit revive reason (turn_no=${row.turn_no})`);
        }
      }
      prevDead = nowDead;
    }
  }

  return { count: violations, details: details.slice(0, 25) };
}

async function cleanupSessions(db, sessionIds) {
  for (const sessionId of sessionIds) {
    try {
      await dbDelete(db, 'game_sessions', {
        session_id: `eq.${sessionId}`,
      });
    } catch {
      // best-effort cleanup only
    }
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const backendEnvFromFile = await loadBackendEnv();
  const mergedEnv = mergeEnv(process.env, backendEnvFromFile);

  const databaseUrl = mergedEnv.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for eval-memory-gate');
  }
  const db = await openDb(databaseUrl);

  const shouldStartBackend = !args.backendUrl;
  const baseUrl = args.backendUrl || `http://127.0.0.1:${args.port}`;
  let backendProc = null;
  const sessionIds = [];

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
    const graphEnabled = !!(stats?.debug?.graphRagState?.enabled || String(mergedEnv.GRAPH_RAG_ENABLED || '').toLowerCase() === 'true');

    const scenarios = [];
    scenarios.push(await scenarioMentionsRecall({
      baseUrl,
      db,
      keepSession: args.keepSession,
    }));
    scenarios.push(await scenarioDebtDue({
      baseUrl,
      db,
      maxWaitTurns: args.maxWaitTurns,
      keepSession: args.keepSession,
    }));
    scenarios.push(await scenarioRevenge({
      baseUrl,
      db,
      maxWaitTurns: args.maxWaitTurns,
      keepSession: args.keepSession,
    }));
    scenarios.push(await scenarioComplexHistoryChain({
      baseUrl,
      db,
      keepSession: args.keepSession,
      graphEnabled,
    }));
    scenarios.push(await scenarioFactionArcSummary({
      baseUrl,
      db,
      keepSession: args.keepSession,
      graphEnabled,
    }));
    scenarios.push(await scenarioTimeoutFallback({
      baseUrl,
      db,
      keepSession: args.keepSession,
      graphEnabled,
    }));

    for (const scenario of scenarios) {
      if (scenario?.sessionId) sessionIds.push(scenario.sessionId);
    }

    const allArtifacts = scenarios.flatMap((s) => Array.isArray(s.artifacts) ? s.artifacts : []);
    const latencies = allArtifacts
      .map((x) => Number(x?.latency_ms))
      .filter((x) => Number.isFinite(x) && x >= 0);
    const retrievalCounts = allArtifacts
      .map((x) => Number(x?.retrieval_count))
      .filter((x) => Number.isFinite(x) && x >= 0);

    const p95LatencyMs = percentile(latencies, 0.95);
    const emptyRetrievalRate = retrievalCounts.length
      ? retrievalCounts.filter((x) => x === 0).length / retrievalCounts.length
      : 1;
    const memoryScenarios = scenarios.filter((s) => s.metricGroup !== 'graph');
    const recallAtK = memoryScenarios.length
      ? memoryScenarios.reduce((acc, s) => acc + Number(s.recallHit || 0), 0) / memoryScenarios.length
      : 0;

    const graphScenarios = scenarios
      .filter((s) => s.metricGroup === 'graph' && !s.skipped)
      .map((s) => s.graphSignal || {});
    const graphEligibleCount = graphScenarios.filter((s) => s.eligible).length;
    const graphUsedCount = graphScenarios.filter((s) => s.eligible && s.used).length;
    const graphTimeoutCount = graphScenarios.filter((s) => s.eligible && s.timedOut).length;
    const graphCacheHitCount = graphScenarios.filter((s) => s.eligible && s.cacheHit).length;
    const graphNonEmptyCount = graphScenarios.filter((s) => s.eligible && s.contextNonEmpty).length;

    const graphUsedRate = graphEligibleCount ? graphUsedCount / graphEligibleCount : (graphEnabled ? 0 : 1);
    const graphTimeoutRate = graphEligibleCount ? graphTimeoutCount / graphEligibleCount : 0;
    const graphCacheHitRate = graphEligibleCount ? graphCacheHitCount / graphEligibleCount : 0;
    const graphContextNonEmptyRate = graphEligibleCount ? graphNonEmptyCount / graphEligibleCount : (graphEnabled ? 0 : 1);

    const consistency = await computeConsistencyViolations({
      db,
      sessionIds,
    });

    const failures = [];
    for (const scenario of scenarios) {
      if (!scenario.pass) {
        failures.push(`Scenario failed: ${scenario.name}`);
      }
    }
    if (p95LatencyMs > args.maxP95LatencyMs) {
      failures.push(`p95 latency ${Math.round(p95LatencyMs)}ms exceeds SLO ${args.maxP95LatencyMs}ms`);
    }
    if (recallAtK < args.minRecallAtK) {
      failures.push(`memory_recall@k ${recallAtK.toFixed(3)} below SLO ${args.minRecallAtK.toFixed(3)}`);
    }
    if (consistency.count > args.maxConsistencyViolations) {
      failures.push(`consistency_violations ${consistency.count} exceeds SLO ${args.maxConsistencyViolations}`);
    }
    if (emptyRetrievalRate > args.maxEmptyRetrievalRate) {
      failures.push(`empty_retrieval_rate ${emptyRetrievalRate.toFixed(3)} exceeds SLO ${args.maxEmptyRetrievalRate.toFixed(3)}`);
    }
    if (graphEnabled) {
      if (graphUsedRate < args.minGraphUsedRate) {
        failures.push(`graph_used_rate_on_complex_queries ${graphUsedRate.toFixed(3)} below SLO ${args.minGraphUsedRate.toFixed(3)}`);
      }
      if (graphTimeoutRate > args.maxGraphTimeoutRate) {
        failures.push(`graph_timeout_rate ${graphTimeoutRate.toFixed(3)} exceeds SLO ${args.maxGraphTimeoutRate.toFixed(3)}`);
      }
      if (graphCacheHitRate < args.minGraphCacheHitRate) {
        failures.push(`graph_cache_hit_rate ${graphCacheHitRate.toFixed(3)} below SLO ${args.minGraphCacheHitRate.toFixed(3)}`);
      }
      if (graphContextNonEmptyRate < args.minGraphContextNonEmptyRate) {
        failures.push(`graph_context_non_empty_rate ${graphContextNonEmptyRate.toFixed(3)} below SLO ${args.minGraphContextNonEmptyRate.toFixed(3)}`);
      }
    }

    const summary = {
      ok: failures.length === 0,
      backend: baseUrl,
      graph_enabled: graphEnabled,
      scenarios: scenarios.map((s) => ({
        name: s.name,
        pass: s.pass,
        sessionId: s.sessionId,
        skipped: !!s.skipped,
        checks: s.checks,
      })),
      metrics: {
        memory_recall_at_k: Number(recallAtK.toFixed(3)),
        p95_latency_ms: Math.round(p95LatencyMs),
        consistency_violations: consistency.count,
        empty_retrieval_rate: Number(emptyRetrievalRate.toFixed(3)),
        graph_used_rate_on_complex_queries: Number(graphUsedRate.toFixed(3)),
        graph_timeout_rate: Number(graphTimeoutRate.toFixed(3)),
        graph_cache_hit_rate: Number(graphCacheHitRate.toFixed(3)),
        graph_context_non_empty_rate: Number(graphContextNonEmptyRate.toFixed(3)),
      },
      slo: {
        max_p95_latency_ms: args.maxP95LatencyMs,
        min_memory_recall_at_k: Number(args.minRecallAtK.toFixed(3)),
        max_consistency_violations: args.maxConsistencyViolations,
        max_empty_retrieval_rate: Number(args.maxEmptyRetrievalRate.toFixed(3)),
        min_graph_used_rate_on_complex_queries: Number(args.minGraphUsedRate.toFixed(3)),
        max_graph_timeout_rate: Number(args.maxGraphTimeoutRate.toFixed(3)),
        min_graph_cache_hit_rate: Number(args.minGraphCacheHitRate.toFixed(3)),
        min_graph_context_non_empty_rate: Number(args.minGraphContextNonEmptyRate.toFixed(3)),
      },
      consistency_details: consistency.details,
    };

    console.log(JSON.stringify(summary, null, 2));

    if (!args.keepSession) {
      await cleanupSessions(db, sessionIds);
    }

    if (failures.length) {
      throw new Error(`Eval gate failed:\n- ${failures.join('\n- ')}`);
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

const byok = require('./byok');
const openrouterClient = require('./openrouterClient');
const { resolveLightTarget, chatClientFor } = require('./llmTargets');
const { PgRest } = require('./pgRest');

class SupabaseWorldService {
    constructor() {
        if (SupabaseWorldService.instance) {
            return SupabaseWorldService.instance;
        }

        this.db = null;
        this.initialized = false;
        this.enabled = false;
        this.lastInitError = null;
        this.graphRagLastError = null;

        SupabaseWorldService.instance = this;
    }

    normalizeSessionId(sessionId) {
        if (!sessionId || typeof sessionId !== 'string') return null;
        const normalized = sessionId.trim();
        const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        return uuidLike.test(normalized) ? normalized : null;
    }

    normalizeEntityKey(name) {
        return String(name || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[^a-z0-9\-_' ]/g, '');
    }

    keyFor(entityType, name) {
        return `${entityType}:${this.normalizeEntityKey(name)}`;
    }

    normalizeMentionLabel(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';

        let cleaned = raw;
        if (cleaned.startsWith('@')) {
            cleaned = cleaned.slice(1).trim();
        }
        if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
            cleaned = cleaned.slice(1, -1).trim();
        }
        return cleaned;
    }

    extractMentionsFromAction(playerAction) {
        const text = String(playerAction || '');
        if (!text) return [];

        const mentions = [];
        let match = null;

        const bracedPattern = /@\{([^}]+)\}/g;
        while ((match = bracedPattern.exec(text)) !== null) {
            const value = this.normalizeMentionLabel(match[1]);
            if (value) mentions.push(value);
        }

        const simplePattern = /(^|\s)@([^\s@{}]+)/g;
        while ((match = simplePattern.exec(text)) !== null) {
            const value = this.normalizeMentionLabel(match[2]);
            if (value) mentions.push(value);
        }

        return mentions;
    }

    collectMentionLabels(explicitMentions = [], playerAction = '') {
        const merged = [
            ...(Array.isArray(explicitMentions) ? explicitMentions : []),
            ...this.extractMentionsFromAction(playerAction)
        ];

        const dedupKeys = new Set();
        const labels = [];
        for (const raw of merged) {
            const label = this.normalizeMentionLabel(raw);
            const key = this.normalizeEntityKey(label);
            if (!key || dedupKeys.has(key)) continue;
            dedupKeys.add(key);
            labels.push(label);
        }

        return labels.slice(0, 12);
    }

    toPostgrestInFilter(values = []) {
        const items = values
            .map(v => String(v || '').trim())
            .filter(Boolean);
        if (!items.length) return null;
        return `in.(${items.join(',')})`;
    }

    toPlainObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    clamp(value, min, max, fallback = 0) {
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.min(max, Math.max(min, num));
    }

    relationLabelFromScore(score) {
        const relation = Number(score);
        if (!Number.isFinite(relation)) return 'unknown';
        if (relation >= 0.35) return 'friendly';
        if (relation <= -0.35) return 'hostile';
        return 'neutral';
    }

    parseBooleanEnv(name, fallback = false) {
        const raw = process.env[name];
        if (raw === undefined || raw === null || raw === '') return !!fallback;
        const normalized = String(raw).trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        return !!fallback;
    }

    isGraphRagEnabled() {
        return this.parseBooleanEnv('GRAPH_RAG_ENABLED', false);
    }

    isGraphRagComplexOnly() {
        return this.parseBooleanEnv('GRAPH_RAG_COMPLEX_ONLY', true);
    }

    getGraphRagTimeoutMs() {
        const raw = Number(process.env.GRAPH_RAG_TIMEOUT_MS || 500);
        if (!Number.isFinite(raw)) return 500;
        return Math.max(150, Math.min(60000, Math.round(raw)));
    }

    // Summaries are a cheap background task, so they run on the light model tier:
    // deepseek-v4-flash when DeepSeek is the provider, gemini-2.5-flash otherwise.
    // Keys come from byok: the current player's own key, else the server key. provider is
    // null when no text provider (DeepSeek / Gemini / OpenRouter) has a usable key for this request.
    resolveGraphSummaryTarget() {
        const preferred = String(process.env.GRAPH_RAG_SUMMARY_PROVIDER || process.env.TEXT_PROVIDER || 'gemini').trim().toLowerCase();
        return resolveLightTarget(byok.pickTextProvider(preferred), process.env.GRAPH_RAG_SUMMARY_MODEL);
    }

    // Embeddings run on OpenAI directly or on OpenRouter's openai/text-embedding-3-small
    // (identical vectors), using the current request's key (player's own, else server's).
    getEmbeddingProvider() {
        return byok.pickProvider(['openai', 'openrouter']);
    }

    canEmbed() {
        return !!this.getEmbeddingProvider();
    }

    getGraphSummaryModel() {
        return this.resolveGraphSummaryTarget().model;
    }

    getGraphSummaryTtlTurns() {
        const raw = Number(process.env.GRAPH_RAG_SUMMARY_TTL_TURNS || 6);
        if (!Number.isFinite(raw)) return 6;
        return Math.max(1, Math.min(24, Math.round(raw)));
    }

    getGraphMaxScopes() {
        const raw = Number(process.env.GRAPH_RAG_MAX_SCOPES || 4);
        if (!Number.isFinite(raw)) return 4;
        return Math.max(1, Math.min(8, Math.round(raw)));
    }

    getGraphMaxSubgraphNodes() {
        const raw = Number(process.env.GRAPH_RAG_MAX_SUBGRAPH_NODES || 80);
        if (!Number.isFinite(raw)) return 80;
        return Math.max(20, Math.min(250, Math.round(raw)));
    }

    getGraphMaxSubgraphEdges() {
        const raw = Number(process.env.GRAPH_RAG_MAX_SUBGRAPH_EDGES || 140);
        if (!Number.isFinite(raw)) return 140;
        return Math.max(20, Math.min(400, Math.round(raw)));
    }

    getGraphJobBatch() {
        const raw = Number(process.env.GRAPH_RAG_JOB_BATCH || 12);
        if (!Number.isFinite(raw)) return 12;
        return Math.max(1, Math.min(24, Math.round(raw)));
    }

    shouldWarmGraphCacheOnTurn() {
        return this.parseBooleanEnv('GRAPH_RAG_CACHE_WARM_ON_TURN', true);
    }

    setGraphRagError(error) {
        this.graphRagLastError = String(error || '').slice(0, 600) || null;
    }

    clearGraphRagError() {
        this.graphRagLastError = null;
    }

    graphScopeKey(scopeType, scopeKey) {
        return `${scopeType}:${scopeKey}`;
    }

    countApproxTokens(text) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return 0;
        return Math.max(1, Math.ceil(normalized.length / 4));
    }

    graphJobBackoffSeconds(attempts = 0) {
        const safeAttempts = Math.max(0, Math.min(8, Number(attempts) || 0));
        return Math.min(900, Math.pow(2, safeAttempts) * 5);
    }

    cleanSummaryText(text, maxChars = 1800) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, Math.max(300, maxChars));
    }

    async init() {
        if (this.initialized) return;

        try {
            const databaseUrl = process.env.DATABASE_URL;

            if (!databaseUrl) {
                this.enabled = false;
                this.initialized = true;
                this.lastInitError = 'DATABASE_URL missing';
                console.warn('World service DISABLED: DATABASE_URL is not set. No long-term world memory, GraphRAG or cloud sessions. See backend/.env.example.');
                return;
            }

            const serverHas = (...providers) => !byok.isRequired() && providers.some((p) => byok.getServerKey(p));
            if (!serverHas('openai', 'openrouter')) {
                console.warn('No usable server OPENAI_API_KEY/OPENROUTER_API_KEY: embeddings run only for players with their own key; the rest wait in embedding_jobs');
            }
            if (this.isGraphRagEnabled() && !serverHas('gemini', 'deepseek', 'openrouter')) {
                console.warn('No usable server text key: GraphRAG summaries run only for players with their own key');
            }

            this.db = new PgRest();
            await this.db.connect(databaseUrl, { max: Number(process.env.PG_POOL_MAX || 10) });

            this.enabled = true;
            const health = await this.restRequest('game_sessions', {
                query: { select: 'session_id', limit: 1 }
            });
            if (health.error) {
                this.enabled = false;
                this.lastInitError = `World schema not ready or DB unavailable: ${health.error.message}`;
                this.initialized = true;
                console.warn('World service disabled:', this.lastInitError);
                return;
            }

            this.enabled = true;
            this.initialized = true;
            this.lastInitError = null;
            console.log('World service initialized (Postgres)');
        } catch (error) {
            this.enabled = false;
            this.initialized = true;
            this.lastInitError = error?.message || String(error);
            console.error('Failed to initialize world service:', error);
        }
    }

    // PostgREST-style request executed directly against Postgres (see pgRest.js).
    async restRequest(path, options = {}) {
        if (!this.enabled || !this.db) {
            return { data: null, error: { message: 'service disabled' }, status: 503, count: null };
        }
        return this.db.request(path, options);
    }

    async ensureSession(sessionId) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return false;

        const { error } = await this.restRequest('game_sessions', {
            method: 'POST',
            query: { on_conflict: 'session_id' },
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: [{ session_id: sid }]
        });
        return !error;
    }

    extractEntityCandidates(currentState, nextState) {
        const candidates = [];
        const push = (entityType, name, metadata = {}) => {
            if (!name || typeof name !== 'string') return;
            const displayName = name.trim();
            if (!displayName) return;
            const entityKey = this.normalizeEntityKey(displayName);
            if (!entityKey) return;
            candidates.push({ entity_type: entityType, entity_key: entityKey, display_name: displayName, metadata });
        };

        push('player', 'Player');

        if (nextState?.location?.name) {
            push('location', nextState.location.name, { description: nextState.location.description || null });
        }

        for (const loc of nextState?.discoveredLocations || []) {
            if (!loc?.name) continue;
            push('location', loc.name, { coordinates: loc.coordinates || null });
        }

        for (const npc of nextState?.npcs || []) {
            if (!npc?.name) continue;
            push('npc', npc.name, { status: npc.status || null });
        }

        for (const quest of nextState?.quests || []) {
            if (!quest?.name) continue;
            push('quest', quest.name, { status: quest.status || 'active' });
        }

        for (const item of nextState?.inventoryChanges?.added || []) {
            if (!item?.name) continue;
            push('item', item.name, { description: item.description || null });
        }

        for (const itemName of nextState?.inventoryChanges?.removed || []) {
            if (!itemName || typeof itemName !== 'string') continue;
            push('item', itemName, {});
        }

        const dedup = new Map();
        for (const c of candidates) {
            const key = `${c.entity_type}:${c.entity_key}`;
            const existing = dedup.get(key);
            if (!existing) {
                dedup.set(key, c);
                continue;
            }
            dedup.set(key, { ...existing, metadata: { ...(existing.metadata || {}), ...(c.metadata || {}) } });
        }
        return Array.from(dedup.values());
    }

    async upsertEntities(sessionId, candidates) {
        const map = new Map();
        if (!Array.isArray(candidates) || candidates.length === 0) return map;

        const rows = candidates.map(c => ({
            session_id: sessionId,
            entity_type: c.entity_type,
            entity_key: c.entity_key,
            display_name: c.display_name,
            aliases: [],
            metadata: c.metadata || {}
        }));

        const { data, error } = await this.restRequest('entities', {
            method: 'POST',
            query: {
                on_conflict: 'session_id,entity_type,entity_key',
                select: 'entity_id,entity_type,entity_key,display_name'
            },
            prefer: 'resolution=merge-duplicates,return=representation',
            body: rows
        });

        if (error) {
            console.error('upsertEntities failed:', error.message);
            return map;
        }

        for (const row of data || []) {
            map.set(`${row.entity_type}:${row.entity_key}`, row);
        }
        return map;
    }

    async resolveMentionEntities(sessionId, explicitMentions = [], playerAction = '') {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return { labels: [], resolvedMentions: [], entities: [] };

        const labels = this.collectMentionLabels(explicitMentions, playerAction);
        if (!labels.length) return { labels: [], resolvedMentions: [], entities: [] };

        const { data: entities, error } = await this.restRequest('entities', {
            query: {
                select: 'entity_id,entity_type,entity_key,display_name,aliases,metadata',
                session_id: `eq.${sid}`,
                order: 'updated_at.desc',
                limit: 500
            }
        });

        if (error) {
            console.error('resolveMentionEntities list entities failed:', error.message);
            return { labels, resolvedMentions: labels, entities: [] };
        }

        const byAliasKey = new Map();
        for (const entity of entities || []) {
            const aliases = [entity.display_name, ...(Array.isArray(entity.aliases) ? entity.aliases : [])];
            for (const alias of aliases) {
                const aliasKey = this.normalizeEntityKey(alias);
                if (!aliasKey || byAliasKey.has(aliasKey)) continue;
                byAliasKey.set(aliasKey, entity);
            }
        }

        const matched = [];
        const resolvedMentions = [];
        const seenIds = new Set();
        const aliasPatches = [];

        for (const label of labels) {
            const key = this.normalizeEntityKey(label);
            if (!key) continue;

            const entity = byAliasKey.get(key);
            if (!entity) {
                resolvedMentions.push(label);
                continue;
            }

            resolvedMentions.push(entity.display_name || label);

            if (!seenIds.has(entity.entity_id)) {
                seenIds.add(entity.entity_id);
                matched.push(entity);
            }

            const displayKey = this.normalizeEntityKey(entity.display_name);
            const existingAliases = Array.isArray(entity.aliases) ? entity.aliases : [];
            const hasAlias = existingAliases.some(a => this.normalizeEntityKey(a) === key);
            if (displayKey !== key && !hasAlias) {
                const mergedAliases = Array.from(new Set([...existingAliases, label])).slice(0, 32);
                aliasPatches.push({
                    entityId: entity.entity_id,
                    aliases: mergedAliases
                });
                entity.aliases = mergedAliases;
            }
        }

        for (const patch of aliasPatches) {
            const { error: patchErr } = await this.restRequest('entities', {
                method: 'PATCH',
                query: { entity_id: `eq.${patch.entityId}` },
                body: { aliases: patch.aliases }
            });
            if (patchErr) {
                console.error('resolveMentionEntities patch alias failed:', patchErr.message);
            }
        }

        return { labels, resolvedMentions, entities: matched };
    }

    async getMentionDossiers(sessionId, entities = []) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !entities.length) return [];

        const entityIds = Array.from(new Set(entities.map(e => e?.entity_id).filter(Boolean)));
        const inFilter = this.toPostgrestInFilter(entityIds);
        if (!inFilter) return [];

        const { data: stateRows, error } = await this.restRequest('entity_state', {
            query: {
                select: 'entity_id,state,relation_to_player,last_seen_location,updated_at',
                session_id: `eq.${sid}`,
                entity_id: inFilter,
                limit: 200
            }
        });
        if (error) {
            console.error('getMentionDossiers entity_state failed:', error.message);
        }

        const stateMap = new Map();
        for (const row of stateRows || []) {
            stateMap.set(row.entity_id, row);
        }

        return entities.map((entity) => {
            const st = stateMap.get(entity.entity_id);
            const metadata = (entity && typeof entity.metadata === 'object' && entity.metadata) ? entity.metadata : {};
            const relationScore = st && Number.isFinite(Number(st.relation_to_player))
                ? Number(st.relation_to_player)
                : null;
            const relationLabel = this.relationLabelFromScore(relationScore);

            const stateStatus = st?.state?.status || metadata?.status || 'unknown';
            const personaValue = st?.state?.persona || metadata?.persona || null;
            const goalsValue = Array.isArray(st?.state?.goals) && st.state.goals.length
                ? st.state.goals
                : (Array.isArray(metadata?.goals) ? metadata.goals : []);
            const goalSystem = this.toPlainObject(st?.state?.goal_system);
            const behavior = this.toPlainObject(st?.state?.behavior);
            const reflection = this.toPlainObject(st?.state?.reflection);
            const persona = personaValue ? `persona: ${String(personaValue).slice(0, 180)}` : null;
            const goals = Array.isArray(goalsValue) && goalsValue.length
                ? `goals: ${goalsValue.slice(0, 2).join(', ')}`
                : null;
            const primaryGoal = goalSystem.primary ? `primary_goal: ${String(goalSystem.primary).slice(0, 140)}` : null;
            const behaviorLine = behavior.tone
                ? `behavior: tone=${behavior.tone}, risk=${behavior.risk || 'measured'}, generosity=${behavior.generosity || 'medium'}`
                : null;
            const reflectionLine = reflection.summary
                ? `reflection: ${String(reflection.summary).slice(0, 180)}`
                : null;
            const lastSeen = st?.last_seen_location ? `last_seen: ${st.last_seen_location}` : null;

            return [
                `${entity.display_name} (${entity.entity_type})`,
                `status=${stateStatus}`,
                `attitude_to_player=${relationLabel}`,
                lastSeen,
                persona,
                goals,
                primaryGoal,
                behaviorLine,
                reflectionLine
            ].filter(Boolean).join('; ');
        }).slice(0, 12);
    }

    async getMentionMemoryTexts(sessionId, mentionEntityIds = [], maxCount = 8) {
        const sid = this.normalizeSessionId(sessionId);
        const ids = Array.from(new Set((mentionEntityIds || []).map(v => String(v || '').trim()).filter(Boolean)));
        if (!sid || !ids.length) return [];

        const { data, error } = await this.restRequest('memory_items', {
            query: {
                select: 'text_content,entity_ids,importance,pinned,created_at',
                session_id: `eq.${sid}`,
                order: 'created_at.desc',
                limit: 200
            }
        });

        if (error) {
            console.error('getMentionMemoryTexts failed:', error.message);
            return [];
        }

        const mentionSet = new Set(ids);
        const scored = (data || [])
            .filter(row => Array.isArray(row.entity_ids) && row.entity_ids.some(id => mentionSet.has(String(id))))
            .map(row => ({
                text: row.text_content,
                score: (row.pinned ? 1 : 0) + Number(row.importance || 0),
                createdAt: Date.parse(row.created_at || '') || 0
            }))
            .filter(x => x.text);

        scored.sort((a, b) => (b.score - a.score) || (b.createdAt - a.createdAt));
        return scored.map(x => x.text).slice(0, Math.max(2, Math.min(maxCount, 12)));
    }

    async fetchHybridMemoryRows(sessionId, queryText, matchCount = 8) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return [];

        let embeddingVector = null;
        if (this.canEmbed() && queryText && String(queryText).trim()) {
            const embedding = await this.generateEmbedding(queryText);
            embeddingVector = embedding ? this.toVectorLiteral(embedding) : null;
        }

        const { data, error } = await this.restRequest('rpc/search_memory_context_hybrid', {
            method: 'POST',
            body: {
                p_session_id: sid,
                p_query_text: String(queryText || ''),
                p_query_embedding: embeddingVector,
                p_match_count: Math.max(1, Math.min(matchCount, 12))
            }
        });

        if (error) {
            console.error('fetchHybridMemories rpc failed:', error.message);
            const { data: fallback } = await this.restRequest('memory_items', {
                query: {
                    select: 'text_content',
                    session_id: `eq.${sid}`,
                    order: 'created_at.desc',
                    limit: Math.max(3, matchCount)
                }
            });
            return (fallback || [])
                .map((x, idx) => ({
                    memory_id: null,
                    text_content: x.text_content,
                    importance: 0.35,
                    pinned: false,
                    created_at: null,
                    score: Math.max(0.001, 0.01 - idx * 0.001)
                }))
                .filter(Boolean);
        }

        return (data || [])
            .map(row => ({
                memory_id: row.memory_id ?? null,
                text_content: row.text_content || '',
                importance: Number(row.importance || 0),
                pinned: !!row.pinned,
                created_at: row.created_at || null,
                score: Number(row.score || 0)
            }))
            .filter(row => row.text_content);
    }

    async fetchHybridMemories(sessionId, queryText, matchCount = 8) {
        const rows = await this.fetchHybridMemoryRows(sessionId, queryText, matchCount);
        return rows.map(row => row.text_content).filter(Boolean);
    }

    async getLatestTurnNo(sessionId) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return 0;

        const { data, error } = await this.restRequest('turns', {
            query: {
                select: 'turn_no',
                session_id: `eq.${sid}`,
                order: 'turn_no.desc',
                limit: 1
            }
        });
        if (error) {
            console.error('getLatestTurnNo failed:', error.message);
            return 0;
        }
        return Number(data?.[0]?.turn_no || 0);
    }

    async getDeterministicContext(sessionId, mentionEntityIds = [], locationName = null) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) {
            return { questFacts: [], relationFacts: [], stateFacts: [], recentEvents: [], recentTurns: [] };
        }

        const ids = Array.from(new Set((mentionEntityIds || []).map(v => String(v || '').trim()).filter(Boolean)));
        const inFilter = this.toPostgrestInFilter(ids);

        const activeQuestsPromise = this.restRequest('quest_state', {
            query: {
                select: 'quest_name,status,objectives,metadata,updated_at',
                session_id: `eq.${sid}`,
                status: 'eq.active',
                order: 'updated_at.desc',
                limit: 8
            }
        });

        const recentTurnsPromise = this.restRequest('turns', {
            query: {
                select: 'turn_id,turn_no,player_action,gm_description,mentions,created_at',
                session_id: `eq.${sid}`,
                order: 'turn_no.desc',
                limit: 5
            }
        });

        const statePromise = inFilter
            ? this.restRequest('entity_state', {
                query: {
                    select: 'entity_id,state,relation_to_player,last_seen_location,updated_at',
                    session_id: `eq.${sid}`,
                    entity_id: inFilter,
                    order: 'updated_at.desc',
                    limit: 25
                }
            })
            : Promise.resolve({ data: [], error: null });

        const relationsPromise = inFilter
            ? this.restRequest('relations', {
                query: {
                    select: 'relation_id,from_entity_id,to_entity_id,relation_type,weight,metadata,updated_at',
                    session_id: `eq.${sid}`,
                    or: `(from_entity_id.${inFilter.replace(/^in\./, 'in.')},to_entity_id.${inFilter.replace(/^in\./, 'in.')})`,
                    order: 'updated_at.desc',
                    limit: 40
                }
            })
            : Promise.resolve({ data: [], error: null });

        const eventsPromise = this.restRequest('events', {
            query: {
                select: 'event_id,event_type,summary,importance,location_name,actor_entity_ids,created_at',
                session_id: `eq.${sid}`,
                order: 'created_at.desc',
                limit: locationName ? 30 : 20
            }
        });

        const [questRes, turnsRes, stateRes, relationsRes, eventsRes] = await Promise.all([
            activeQuestsPromise,
            recentTurnsPromise,
            statePromise,
            relationsPromise,
            eventsPromise
        ]);

        if (questRes.error) console.error('getDeterministicContext quests failed:', questRes.error.message);
        if (turnsRes.error) console.error('getDeterministicContext turns failed:', turnsRes.error.message);
        if (stateRes.error) console.error('getDeterministicContext state failed:', stateRes.error.message);
        if (relationsRes.error) console.error('getDeterministicContext relations failed:', relationsRes.error.message);
        if (eventsRes.error) console.error('getDeterministicContext events failed:', eventsRes.error.message);

        const entityIds = new Set();
        for (const row of stateRes.data || []) {
            if (row?.entity_id) entityIds.add(row.entity_id);
        }
        for (const row of relationsRes.data || []) {
            if (row?.from_entity_id) entityIds.add(row.from_entity_id);
            if (row?.to_entity_id) entityIds.add(row.to_entity_id);
        }
        for (const row of eventsRes.data || []) {
            for (const id of row?.actor_entity_ids || []) {
                if (id) entityIds.add(id);
            }
        }

        const entityInFilter = this.toPostgrestInFilter(Array.from(entityIds));
        const entityNameMap = new Map();
        if (entityInFilter) {
            const { data: entityRows, error: entityErr } = await this.restRequest('entities', {
                query: {
                    select: 'entity_id,display_name,entity_type',
                    session_id: `eq.${sid}`,
                    entity_id: entityInFilter,
                    limit: 200
                }
            });
            if (entityErr) {
                console.error('getDeterministicContext entities failed:', entityErr.message);
            } else {
                for (const row of entityRows || []) {
                    entityNameMap.set(row.entity_id, `${row.display_name} (${row.entity_type})`);
                }
            }
        }

        const questFacts = (questRes.data || []).map((q) => {
            const objectives = Array.isArray(q.objectives)
                ? q.objectives.filter(o => !o?.isCompleted).map(o => String(o?.description || '').trim()).filter(Boolean).slice(0, 2)
                : [];
            return `${q.quest_name}: ${objectives.length ? objectives.join(' | ') : 'active'}`;
        });

        const stateFacts = (stateRes.data || []).map((row) => {
            const name = entityNameMap.get(row.entity_id) || `entity:${row.entity_id}`;
            const state = this.toPlainObject(row.state);
            const status = state.status ? `status=${state.status}` : null;
            const persona = state.persona ? `persona=${String(state.persona).slice(0, 90)}` : null;
            const behavior = this.toPlainObject(state.behavior);
            const behaviorLine = behavior.tone
                ? `behavior=${behavior.tone}/${behavior.risk || 'measured'}/${behavior.generosity || 'medium'}`
                : null;
            const primaryGoal = state?.goal_system?.primary
                ? `goal=${String(state.goal_system.primary).slice(0, 90)}`
                : null;
            const reflection = state?.reflection?.summary
                ? `reflection=${String(state.reflection.summary).slice(0, 90)}`
                : null;
            const lastSeen = row.last_seen_location ? `last_seen=${row.last_seen_location}` : null;
            return [name, status, persona, behaviorLine, primaryGoal, reflection, lastSeen].filter(Boolean).join('; ');
        });

        const relationFacts = (relationsRes.data || []).map((row) => {
            const fromName = entityNameMap.get(row.from_entity_id) || `entity:${row.from_entity_id}`;
            const toName = entityNameMap.get(row.to_entity_id) || `entity:${row.to_entity_id}`;
            return `${fromName} --${row.relation_type}/${Number(row.weight || 0).toFixed(2)}--> ${toName}`;
        });

        const locationKey = this.normalizeEntityKey(locationName);
        const recentEvents = (eventsRes.data || [])
            .filter((row) => {
                if (!locationKey) return true;
                return this.normalizeEntityKey(row.location_name) === locationKey;
            })
            .slice(0, 10)
            .map((row) => `[${row.event_type}] ${row.summary}`);

        const recentTurns = (turnsRes.data || [])
            .slice(0, 5)
            .map((row) => `turn ${row.turn_no}: ${String(row.player_action || '').slice(0, 120)}`);

        return { questFacts, relationFacts, stateFacts, recentEvents, recentTurns };
    }

    async getDueConsequences(sessionId, turnNo, locationName = null, mentionEntityIds = []) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !Number.isFinite(Number(turnNo)) || Number(turnNo) <= 0) return [];

        const { data, error } = await this.restRequest('events', {
            query: {
                select: 'event_id,event_type,summary,payload,actor_entity_ids,location_name,importance,created_at',
                session_id: `eq.${sid}`,
                event_type: 'in.(debt_due,revenge,rumor_spread,encounter_hint)',
                order: 'created_at.asc',
                limit: 250
            }
        });
        if (error) {
            console.error('getDueConsequences list failed:', error.message);
            return [];
        }

        const mentionSet = new Set((mentionEntityIds || []).map(v => String(v || '').trim()).filter(Boolean));
        const locationKey = this.normalizeEntityKey(locationName);
        const due = (data || [])
            .filter((row) => {
                const payload = this.toPlainObject(row.payload);
                const status = String(payload.status || 'pending');
                const dueTurnNo = Number(payload.due_turn_no || 0);
                if (status !== 'pending') return false;
                if (!Number.isFinite(dueTurnNo) || dueTurnNo <= 0 || dueTurnNo > Number(turnNo)) return false;

                const actorIds = Array.isArray(row.actor_entity_ids) ? row.actor_entity_ids.map(String) : [];
                const mentionHit = actorIds.some(id => mentionSet.has(id));
                const locationHit = locationKey && this.normalizeEntityKey(row.location_name) === locationKey;
                return mentionHit || locationHit || mentionSet.size === 0;
            })
            .slice(0, 4);

        if (!due.length) return [];

        const actorEntityIds = Array.from(new Set(due.flatMap(row => Array.isArray(row.actor_entity_ids) ? row.actor_entity_ids : [])));
        const actorMap = new Map();
        const actorInFilter = this.toPostgrestInFilter(actorEntityIds);
        if (actorInFilter) {
            const { data: entityRows } = await this.restRequest('entities', {
                query: {
                    select: 'entity_id,display_name',
                    session_id: `eq.${sid}`,
                    entity_id: actorInFilter,
                    limit: 200
                }
            });
            for (const row of entityRows || []) {
                actorMap.set(row.entity_id, row.display_name);
            }
        }

        const lines = [];
        for (const row of due) {
            const payload = this.toPlainObject(row.payload);
            const actorNames = (Array.isArray(row.actor_entity_ids) ? row.actor_entity_ids : [])
                .map(id => actorMap.get(id))
                .filter(Boolean)
                .slice(0, 2);
            const actors = actorNames.length ? actorNames.join(', ') : 'Unknown actors';
            lines.push(`[${row.event_type}] ${actors}: ${row.summary}`);

            const nextPayload = {
                ...payload,
                status: 'triggered',
                triggered_turn_no: Number(turnNo),
                triggered_location: locationName || null,
                triggered_at: new Date().toISOString()
            };
            const { error: patchErr } = await this.restRequest('events', {
                method: 'PATCH',
                query: { event_id: `eq.${row.event_id}` },
                body: { payload: nextPayload }
            });
            if (patchErr) {
                console.error('getDueConsequences patch failed:', patchErr.message);
            }
        }

        return lines;
    }

    detectComplexQuery({ playerAction = '', mentions = [], currentTurnNo = 0, mode = 'narration' } = {}) {
        const text = String(playerAction || '').toLowerCase();
        const mentionCount = Array.isArray(mentions)
            ? mentions.map((m) => String(m || '').trim()).filter(Boolean).length
            : 0;

        const investigativePattern = /(why|how connected|remember|history|timeline|chain|who is responsible|what happened before|кто виноват|как связано|что было раньше|расслед)/i;
        const causalTemporalPattern = /(because|cause|consequence|connected|earlier|before|after|history|arc|thread|почему|причин|последств|связ|раньше|до|после|истор|цепоч|арка|расслед)/i;
        const longCampaignPattern = /(history|timeline|remember|arc|campaign|thread|what happened|история|кампания|цепоч|арка|что было)/i;

        const reasons = [];
        if (investigativePattern.test(text)) reasons.push('investigative_pattern');
        if (mentionCount >= 2 && causalTemporalPattern.test(text)) reasons.push('multi_mention_causal');
        if (Number(currentTurnNo) >= 20 && longCampaignPattern.test(text)) reasons.push('long_campaign_continuity');

        let complex = reasons.length > 0;
        const modeKey = String(mode || '').toLowerCase();
        if (modeKey === 'combat' && !investigativePattern.test(text) && !causalTemporalPattern.test(text)) {
            complex = false;
            reasons.push('combat_short_circuit');
        }

        return {
            complex,
            mentionCount,
            reasons
        };
    }

    buildGraphScopes({ mentionEntityIds = [], mentions = [], locationName = null, playerAction = '' } = {}) {
        const maxScopes = this.getGraphMaxScopes();
        const scopes = [];
        const seen = new Set();
        const addScope = (scopeType, scopeKey) => {
            const type = String(scopeType || '').trim();
            const key = String(scopeKey || '').trim();
            if (!type || !key) return;
            const compound = this.graphScopeKey(type, key);
            if (seen.has(compound)) return;
            seen.add(compound);
            scopes.push({ scope_type: type, scope_key: key });
        };

        for (const entityId of mentionEntityIds || []) {
            const id = String(entityId || '').trim();
            if (!id) continue;
            addScope('entity', id);
        }

        const locationKey = this.normalizeEntityKey(locationName);
        if (locationKey) {
            addScope('location', locationKey);
        }

        const text = String(playerAction || '');
        const mentionsJoined = Array.isArray(mentions) ? mentions.map((m) => String(m || '')).join(' ') : '';
        const factionCorpus = `${mentionsJoined} ${text}`;
        const factionMention = (Array.isArray(mentions) ? mentions : [])
            .map((m) => String(m || '').trim())
            .find((m) => /(faction|guild|clan|legion|brotherhood|ncr|фракц|клан|легион|братств)/i.test(m));
        if (factionMention) {
            const factionKey = this.normalizeEntityKey(factionMention);
            if (factionKey) addScope('faction', factionKey);
        } else {
            const factionMatch = factionCorpus.match(/\b(?:faction|фракц(?:ия|ии|ию|ией)?)\s+([a-z0-9а-яё _'\-]{2,40})/i);
            const factionKey = this.normalizeEntityKey(factionMatch?.[1] || '');
            if (factionKey) addScope('faction', factionKey);
        }

        if (/\b(history|timeline|chain|thread|arc|история|арка|цепоч|нить)\b/i.test(text)) {
            addScope('thread', 'recent-causal-thread');
        }

        addScope('global', 'campaign');
        return scopes.slice(0, maxScopes);
    }

    nodeMatchesScope(node, scope) {
        if (!node || !scope) return false;
        const scopeType = String(scope.scope_type || '').toLowerCase();
        const scopeKey = String(scope.scope_key || '').trim();
        const nodeType = String(node.node_type || '').toLowerCase();
        const nodeKey = String(node.node_key || '').trim();
        const payload = this.toPlainObject(node.payload);
        const payloadText = this.normalizeEntityKey(JSON.stringify(payload));
        const labelKey = this.normalizeEntityKey(node.label);

        if (scopeType === 'entity') {
            return nodeType === 'entity' && nodeKey === `entity:${scopeKey}`;
        }
        if (scopeType === 'location') {
            const locationSignals = [
                this.normalizeEntityKey(payload.location_key),
                this.normalizeEntityKey(payload.location_name),
                labelKey,
                payloadText
            ].filter(Boolean);
            return locationSignals.some((x) => x.includes(scopeKey));
        }
        if (scopeType === 'faction') {
            return labelKey.includes(scopeKey) || payloadText.includes(scopeKey);
        }
        if (scopeType === 'thread') {
            return nodeType === 'event' || nodeType === 'relation';
        }
        return true;
    }

    isSummaryFresh(summaryRow, currentTurnNo) {
        const turnNo = Number(currentTurnNo || 0);
        if (!Number.isFinite(turnNo) || turnNo <= 0) return true;
        const freshnessTurn = Number(summaryRow?.freshness_turn_no || 0);
        const ttlTurns = this.getGraphSummaryTtlTurns();
        return freshnessTurn + ttlTurns >= turnNo;
    }

    async upsertGraphNodes(sessionId, rows = []) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !Array.isArray(rows) || !rows.length) {
            return { rows: [], byKey: new Map() };
        }

        const payload = rows
            .map((row) => ({
                session_id: sid,
                node_type: row.node_type,
                node_key: row.node_key,
                entity_id: row.entity_id || null,
                event_id: row.event_id || null,
                relation_id: row.relation_id || null,
                label: String(row.label || '').slice(0, 320),
                payload: this.toPlainObject(row.payload),
                importance: this.clamp(Number(row.importance || 0.5), 0, 1, 0.5),
                time_from: row.time_from || null,
                time_to: row.time_to || null
            }))
            .filter((row) => row.node_type && row.node_key && row.label);

        if (!payload.length) return { rows: [], byKey: new Map() };

        const { data, error } = await this.restRequest('graph_nodes', {
            method: 'POST',
            query: {
                on_conflict: 'session_id,node_type,node_key',
                select: 'node_id,node_type,node_key,entity_id,event_id,relation_id'
            },
            prefer: 'resolution=merge-duplicates,return=representation',
            body: payload
        });

        if (error) {
            this.setGraphRagError(`upsertGraphNodes failed: ${error.message}`);
            throw new Error(`upsertGraphNodes failed: ${error.message}`);
        }

        const byKey = new Map();
        for (const row of data || []) {
            byKey.set(this.graphScopeKey(row.node_type, row.node_key), row);
        }
        return { rows: data || [], byKey };
    }

    async upsertGraphEdges(sessionId, rows = []) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !Array.isArray(rows) || !rows.length) {
            return [];
        }

        const payload = rows
            .map((row) => ({
                session_id: sid,
                from_node_id: Number(row.from_node_id),
                to_node_id: Number(row.to_node_id),
                edge_type: String(row.edge_type || '').slice(0, 80),
                weight: this.clamp(Number(row.weight || 0), -1, 1, 0),
                evidence_event_id: row.evidence_event_id ? Number(row.evidence_event_id) : null,
                payload: this.toPlainObject(row.payload)
            }))
            .filter((row) => Number.isInteger(row.from_node_id) && row.from_node_id > 0
                && Number.isInteger(row.to_node_id) && row.to_node_id > 0
                && row.from_node_id !== row.to_node_id
                && row.edge_type);

        if (!payload.length) return [];

        const { data, error } = await this.restRequest('graph_edges', {
            method: 'POST',
            query: {
                on_conflict: 'session_id,from_node_id,to_node_id,edge_type',
                select: 'edge_id,from_node_id,to_node_id,edge_type'
            },
            prefer: 'resolution=merge-duplicates,return=representation',
            body: payload
        });

        if (error) {
            this.setGraphRagError(`upsertGraphEdges failed: ${error.message}`);
            throw new Error(`upsertGraphEdges failed: ${error.message}`);
        }

        return data || [];
    }

    async getGraphCheckpoint(sessionId) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return null;

        const { data, error } = await this.restRequest('graph_checkpoints', {
            query: {
                select: 'session_id,last_event_id,last_relation_updated_at,last_turn_no,updated_at',
                session_id: `eq.${sid}`,
                limit: 1
            }
        });

        if (error) {
            this.setGraphRagError(`getGraphCheckpoint failed: ${error.message}`);
            return null;
        }
        return data?.[0] || null;
    }

    async saveGraphCheckpoint(sessionId, patch = {}) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return;

        const body = [{
            session_id: sid,
            last_event_id: patch.last_event_id ?? null,
            last_relation_updated_at: patch.last_relation_updated_at ?? null,
            last_turn_no: Number(patch.last_turn_no || 0)
        }];

        const { error } = await this.restRequest('graph_checkpoints', {
            method: 'POST',
            query: { on_conflict: 'session_id' },
            prefer: 'resolution=merge-duplicates,return=minimal',
            body
        });
        if (error) {
            this.setGraphRagError(`saveGraphCheckpoint failed: ${error.message}`);
        }
    }

    async getGraphSummaryRow(sessionId, scopeType, scopeKey) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return null;

        const { data, error } = await this.restRequest('graph_summaries', {
            query: {
                select: 'summary_id,scope_type,scope_key,summary_text,source_node_ids,source_edge_ids,model,freshness_turn_no,token_count,quality_score,updated_at',
                session_id: `eq.${sid}`,
                scope_type: `eq.${scopeType}`,
                scope_key: `eq.${scopeKey}`,
                limit: 1
            }
        });

        if (error) {
            this.setGraphRagError(`getGraphSummaryRow failed: ${error.message}`);
            return null;
        }
        return data?.[0] || null;
    }

    async upsertGraphSummaryRow(sessionId, row) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !row) return null;

        const summaryText = this.cleanSummaryText(row.summary_text || '', 1800);
        if (!summaryText) return null;

        // Freshness must never move backwards: a late job carrying an old turn
        // number must not mark a newer summary as stale again.
        const existing = await this.getGraphSummaryRow(sid, row.scope_type, row.scope_key);
        const freshnessTurnNo = Math.max(
            Number(row.freshness_turn_no || 0),
            Number(existing?.freshness_turn_no || 0)
        );

        const payload = [{
            session_id: sid,
            scope_type: row.scope_type,
            scope_key: row.scope_key,
            summary_text: summaryText,
            source_node_ids: Array.isArray(row.source_node_ids) ? row.source_node_ids.slice(0, 200) : [],
            source_edge_ids: Array.isArray(row.source_edge_ids) ? row.source_edge_ids.slice(0, 300) : [],
            model: String(row.model || this.getGraphSummaryModel()).slice(0, 80),
            freshness_turn_no: freshnessTurnNo,
            token_count: Math.max(0, Number(row.token_count || this.countApproxTokens(summaryText))),
            quality_score: this.clamp(Number(row.quality_score || 0.68), 0, 1, 0.68)
        }];

        const { data, error } = await this.restRequest('graph_summaries', {
            method: 'POST',
            query: {
                on_conflict: 'session_id,scope_type,scope_key',
                select: 'summary_id,scope_type,scope_key,summary_text,source_node_ids,source_edge_ids,model,freshness_turn_no,token_count,quality_score,updated_at'
            },
            prefer: 'resolution=merge-duplicates,return=representation',
            body: payload
        });

        if (error) {
            this.setGraphRagError(`upsertGraphSummaryRow failed: ${error.message}`);
            throw new Error(`upsertGraphSummaryRow failed: ${error.message}`);
        }

        return data?.[0] || null;
    }

    async getGraphSubgraph(sessionId, scopes = []) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return { nodes: [], edges: [] };

        const maxNodes = this.getGraphMaxSubgraphNodes();
        const maxEdges = this.getGraphMaxSubgraphEdges();

        const [nodesRes, edgesRes] = await Promise.all([
            this.restRequest('graph_nodes', {
                query: {
                    select: 'node_id,node_type,node_key,label,payload,importance,time_from,time_to,updated_at',
                    session_id: `eq.${sid}`,
                    order: 'updated_at.desc',
                    limit: Math.max(maxNodes * 4, maxNodes + 20)
                }
            }),
            this.restRequest('graph_edges', {
                query: {
                    select: 'edge_id,from_node_id,to_node_id,edge_type,weight,evidence_event_id,payload,created_at',
                    session_id: `eq.${sid}`,
                    order: 'created_at.desc',
                    limit: Math.max(maxEdges * 4, maxEdges + 40)
                }
            })
        ]);

        if (nodesRes.error || edgesRes.error) {
            const message = nodesRes.error?.message || edgesRes.error?.message || 'graph subgraph fetch failed';
            this.setGraphRagError(`getGraphSubgraph failed: ${message}`);
            return { nodes: [], edges: [] };
        }

        const nodes = nodesRes.data || [];
        const edges = edgesRes.data || [];
        if (!nodes.length) return { nodes: [], edges: [] };

        const effectiveScopes = Array.isArray(scopes) && scopes.length
            ? scopes
            : [{ scope_type: 'global', scope_key: 'campaign' }];

        const seedIds = new Set();
        for (const scope of effectiveScopes) {
            for (const node of nodes) {
                if (this.nodeMatchesScope(node, scope)) {
                    seedIds.add(node.node_id);
                }
            }
        }

        if (!seedIds.size) {
            for (const node of nodes.slice(0, Math.min(10, nodes.length))) {
                seedIds.add(node.node_id);
            }
        }

        const selectedNodeIds = new Set(seedIds);
        const selectedEdgeIds = new Set();
        const selectedEdges = [];

        for (const edge of edges) {
            if (selectedEdges.length >= maxEdges) break;
            const touchSeed = selectedNodeIds.has(edge.from_node_id) || selectedNodeIds.has(edge.to_node_id);
            if (!touchSeed) continue;
            if (selectedEdgeIds.has(edge.edge_id)) continue;
            selectedEdgeIds.add(edge.edge_id);
            selectedEdges.push(edge);
            selectedNodeIds.add(edge.from_node_id);
            selectedNodeIds.add(edge.to_node_id);
            if (selectedNodeIds.size >= maxNodes) break;
        }

        const nodeById = new Map(nodes.map((n) => [n.node_id, n]));
        let selectedNodes = Array.from(selectedNodeIds)
            .map((id) => nodeById.get(id))
            .filter(Boolean)
            .slice(0, maxNodes);

        const trimmedNodeIds = new Set(selectedNodes.map((n) => n.node_id));
        const trimmedEdges = selectedEdges
            .filter((e) => trimmedNodeIds.has(e.from_node_id) && trimmedNodeIds.has(e.to_node_id))
            .slice(0, maxEdges);

        if (!trimmedEdges.length && edges.length) {
            for (const edge of edges) {
                if (trimmedEdges.length >= Math.min(8, maxEdges)) break;
                if (trimmedNodeIds.has(edge.from_node_id) || trimmedNodeIds.has(edge.to_node_id)) {
                    trimmedEdges.push(edge);
                }
            }
        }

        if (!selectedNodes.length && nodes.length) {
            selectedNodes = nodes.slice(0, Math.min(10, maxNodes));
        }

        return {
            nodes: selectedNodes,
            edges: trimmedEdges
        };
    }

    async buildGraphIncremental(sessionId, options = {}) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) {
            return { applied: false, reason: 'invalid_session', node_upserts: 0, edge_upserts: 0, event_nodes: 0, relation_nodes: 0 };
        }

        const checkpoint = await this.getGraphCheckpoint(sid);
        const lastEventId = Number(checkpoint?.last_event_id || 0);
        const lastRelationUpdatedAt = checkpoint?.last_relation_updated_at || null;

        const eventsQuery = {
            select: 'event_id,event_type,summary,importance,location_name,actor_entity_ids,payload,caused_by_event_id,created_at',
            session_id: `eq.${sid}`,
            event_id: `gt.${Math.max(0, lastEventId)}`,
            order: 'event_id.asc',
            limit: 320
        };

        const relationsQuery = {
            select: 'relation_id,from_entity_id,to_entity_id,relation_type,weight,evidence_event_id,metadata,updated_at',
            session_id: `eq.${sid}`,
            order: 'updated_at.asc',
            limit: 260
        };
        if (lastRelationUpdatedAt) {
            relationsQuery.updated_at = `gt.${lastRelationUpdatedAt}`;
        }

        const [eventsRes, relationsRes] = await Promise.all([
            this.restRequest('events', { query: eventsQuery }),
            this.restRequest('relations', { query: relationsQuery })
        ]);

        if (eventsRes.error || relationsRes.error) {
            const message = eventsRes.error?.message || relationsRes.error?.message || 'buildGraphIncremental source fetch failed';
            this.setGraphRagError(`buildGraphIncremental failed: ${message}`);
            return { applied: false, reason: message, node_upserts: 0, edge_upserts: 0, event_nodes: 0, relation_nodes: 0 };
        }

        const events = eventsRes.data || [];
        const relations = relationsRes.data || [];
        const entityIds = new Set();
        const placeholderEventIds = new Set();

        for (const event of events) {
            for (const actorId of event?.actor_entity_ids || []) {
                if (actorId) entityIds.add(String(actorId));
            }
            if (event?.caused_by_event_id) placeholderEventIds.add(Number(event.caused_by_event_id));
        }
        for (const relation of relations) {
            if (relation?.from_entity_id) entityIds.add(String(relation.from_entity_id));
            if (relation?.to_entity_id) entityIds.add(String(relation.to_entity_id));
            if (relation?.evidence_event_id) placeholderEventIds.add(Number(relation.evidence_event_id));
        }
        for (const event of events) {
            placeholderEventIds.delete(Number(event.event_id));
        }

        const entityInFilter = this.toPostgrestInFilter(Array.from(entityIds));
        const entityNameMap = new Map();
        if (entityInFilter) {
            const { data: entityRows, error: entityErr } = await this.restRequest('entities', {
                query: {
                    select: 'entity_id,display_name,entity_type',
                    session_id: `eq.${sid}`,
                    entity_id: entityInFilter,
                    limit: 260
                }
            });
            if (entityErr) {
                this.setGraphRagError(`buildGraphIncremental entities fetch failed: ${entityErr.message}`);
            } else {
                for (const entity of entityRows || []) {
                    entityNameMap.set(entity.entity_id, `${entity.display_name} (${entity.entity_type})`);
                }
            }
        }

        const nodeRowsByKey = new Map();
        const addNode = (row) => {
            const compound = this.graphScopeKey(row.node_type, row.node_key);
            const existing = nodeRowsByKey.get(compound);
            if (!existing) {
                nodeRowsByKey.set(compound, row);
                return;
            }
            nodeRowsByKey.set(compound, {
                ...existing,
                ...row,
                payload: { ...this.toPlainObject(existing.payload), ...this.toPlainObject(row.payload) },
                importance: Math.max(Number(existing.importance || 0), Number(row.importance || 0))
            });
        };

        for (const entityId of entityIds) {
            const label = entityNameMap.get(entityId) || `entity:${entityId}`;
            addNode({
                node_type: 'entity',
                node_key: `entity:${entityId}`,
                entity_id: entityId,
                label,
                payload: { entity_id: entityId },
                importance: 0.55
            });
        }

        for (const event of events) {
            const eventId = Number(event.event_id);
            addNode({
                node_type: 'event',
                node_key: `event:${eventId}`,
                event_id: eventId,
                label: `[${event.event_type}] ${String(event.summary || '').slice(0, 220)}`,
                payload: {
                    event_type: event.event_type,
                    location_name: event.location_name || null,
                    location_key: this.normalizeEntityKey(event.location_name || ''),
                    actor_entity_ids: Array.isArray(event.actor_entity_ids) ? event.actor_entity_ids : []
                },
                importance: this.clamp(Number(event.importance || 0.45), 0, 1, 0.45),
                time_from: event.created_at || null
            });
        }

        for (const eventId of placeholderEventIds) {
            if (!Number.isInteger(eventId) || eventId <= 0) continue;
            addNode({
                node_type: 'event',
                node_key: `event:${eventId}`,
                event_id: eventId,
                label: `Event #${eventId}`,
                payload: { placeholder: true },
                importance: 0.35
            });
        }

        for (const relation of relations) {
            const relationId = Number(relation.relation_id);
            const fromName = entityNameMap.get(relation.from_entity_id) || `entity:${relation.from_entity_id}`;
            const toName = entityNameMap.get(relation.to_entity_id) || `entity:${relation.to_entity_id}`;
            addNode({
                node_type: 'relation',
                node_key: `relation:${relationId}`,
                relation_id: relationId,
                label: `${fromName} --${relation.relation_type}/${Number(relation.weight || 0).toFixed(2)}--> ${toName}`,
                payload: {
                    relation_type: relation.relation_type,
                    from_entity_id: relation.from_entity_id,
                    to_entity_id: relation.to_entity_id
                },
                importance: this.clamp(0.35 + Math.abs(Number(relation.weight || 0)) * 0.5, 0.2, 0.95, 0.45),
                time_from: relation.updated_at || null
            });
        }

        const upsertedNodes = await this.upsertGraphNodes(sid, Array.from(nodeRowsByKey.values()));
        const nodeIdByKey = new Map();
        for (const row of upsertedNodes.rows || []) {
            nodeIdByKey.set(this.graphScopeKey(row.node_type, row.node_key), row.node_id);
        }
        const nodeId = (type, key) => nodeIdByKey.get(this.graphScopeKey(type, key));

        const edgeRowsByKey = new Map();
        const addEdge = (row) => {
            if (!row?.from_node_id || !row?.to_node_id) return;
            if (Number(row.from_node_id) === Number(row.to_node_id)) return;
            const compound = `${row.from_node_id}:${row.to_node_id}:${row.edge_type}`;
            if (!edgeRowsByKey.has(compound)) edgeRowsByKey.set(compound, row);
        };

        for (const event of events) {
            const eventId = Number(event.event_id);
            const eventNodeId = nodeId('event', `event:${eventId}`);
            if (!eventNodeId) continue;

            for (const actorId of event.actor_entity_ids || []) {
                const actorNodeId = nodeId('entity', `entity:${actorId}`);
                if (!actorNodeId) continue;
                addEdge({
                    from_node_id: actorNodeId,
                    to_node_id: eventNodeId,
                    edge_type: 'actor_in_event',
                    weight: this.clamp(Number(event.importance || 0.5), 0, 1, 0.5),
                    evidence_event_id: eventId,
                    payload: { event_type: event.event_type }
                });
            }

            if (event.caused_by_event_id) {
                const causeNodeId = nodeId('event', `event:${Number(event.caused_by_event_id)}`);
                if (causeNodeId) {
                    addEdge({
                        from_node_id: causeNodeId,
                        to_node_id: eventNodeId,
                        edge_type: 'causes',
                        weight: this.clamp(Number(event.importance || 0.5), 0, 1, 0.5),
                        evidence_event_id: eventId,
                        payload: {}
                    });
                }
            }
        }

        for (const relation of relations) {
            const relationNodeId = nodeId('relation', `relation:${Number(relation.relation_id)}`);
            const fromNodeId = nodeId('entity', `entity:${relation.from_entity_id}`);
            const toNodeId = nodeId('entity', `entity:${relation.to_entity_id}`);
            const relationWeight = this.clamp(Number(relation.weight || 0), -1, 1, 0);

            if (fromNodeId && relationNodeId) {
                addEdge({
                    from_node_id: fromNodeId,
                    to_node_id: relationNodeId,
                    edge_type: 'relation_source',
                    weight: relationWeight,
                    evidence_event_id: relation.evidence_event_id || null,
                    payload: { relation_type: relation.relation_type }
                });
            }
            if (relationNodeId && toNodeId) {
                addEdge({
                    from_node_id: relationNodeId,
                    to_node_id: toNodeId,
                    edge_type: 'relation_target',
                    weight: relationWeight,
                    evidence_event_id: relation.evidence_event_id || null,
                    payload: { relation_type: relation.relation_type }
                });
            }
            if (relation.evidence_event_id) {
                const evidenceNodeId = nodeId('event', `event:${Number(relation.evidence_event_id)}`);
                if (evidenceNodeId && relationNodeId) {
                    addEdge({
                        from_node_id: evidenceNodeId,
                        to_node_id: relationNodeId,
                        edge_type: 'evidence_for_relation',
                        weight: 0.6,
                        evidence_event_id: relation.evidence_event_id,
                        payload: {}
                    });
                }
            }
        }

        const edgeRows = Array.from(edgeRowsByKey.values());
        const upsertedEdges = await this.upsertGraphEdges(sid, edgeRows);

        let maxEventId = lastEventId;
        for (const event of events) {
            maxEventId = Math.max(maxEventId, Number(event.event_id || 0));
        }

        let maxRelationUpdatedAt = lastRelationUpdatedAt || null;
        let maxRelationTs = maxRelationUpdatedAt ? Date.parse(maxRelationUpdatedAt) : 0;
        for (const relation of relations) {
            const ts = Date.parse(relation.updated_at || '');
            if (Number.isFinite(ts) && ts > maxRelationTs) {
                maxRelationTs = ts;
                maxRelationUpdatedAt = relation.updated_at;
            }
        }

        await this.saveGraphCheckpoint(sid, {
            last_event_id: maxEventId || null,
            last_relation_updated_at: maxRelationUpdatedAt || null,
            last_turn_no: Math.max(Number(options.turnNo || 0), Number(checkpoint?.last_turn_no || 0))
        });

        this.clearGraphRagError();
        return {
            applied: true,
            event_nodes: events.length,
            relation_nodes: relations.length,
            node_upserts: (upsertedNodes.rows || []).length,
            edge_upserts: upsertedEdges.length,
            last_event_id: maxEventId || null
        };
    }

    async refreshGraphSummary(sessionId, scopeType, scopeKey, options = {}) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !scopeType || !scopeKey) return null;

        const subgraph = await this.getGraphSubgraph(sid, [{ scope_type: scopeType, scope_key: scopeKey }]);
        const nodes = subgraph.nodes || [];
        const edges = subgraph.edges || [];
        if (!nodes.length) {
            throw new Error('no_graph_data');
        }
        const summaryTarget = this.resolveGraphSummaryTarget();
        const geminiClient = summaryTarget.provider === 'gemini' ? byok.getGeminiClient() : null;
        if (!summaryTarget.provider || (summaryTarget.provider === 'gemini' && !geminiClient)) {
            throw new Error('graph_summary_model_unavailable');
        }

        const nodeLines = nodes
            .slice(0, 28)
            .map((n) => `NODE ${n.node_id} [${n.node_type}] ${String(n.label || '').slice(0, 180)}`);
        const edgeLines = edges
            .slice(0, 36)
            .map((e) => `EDGE ${e.edge_type} ${e.from_node_id}->${e.to_node_id} weight=${Number(e.weight || 0).toFixed(2)}`);

        const prompt = [
            'Summarize this RPG world subgraph for a game-master runtime context.',
            'Focus on causal chains, unresolved consequences, and continuity risks.',
            `Scope: ${scopeType}:${scopeKey}`,
            `Player query: ${String(options.playerAction || '').slice(0, 260)}`,
            'Return plain text with up to 4 short bullet lines.',
            '',
            'GRAPH NODES:',
            ...nodeLines,
            '',
            'GRAPH EDGES:',
            ...edgeLines
        ].join('\n');

        let rawSummary = '';
        const chat = chatClientFor(summaryTarget.provider);
        if (chat) {
            rawSummary = await chat(
                [{ role: 'user', content: prompt }],
                { model: summaryTarget.model, temperature: 0.3, thinking: false }
            );
        } else {
            const response = await geminiClient.models.generateContent({
                model: summaryTarget.model,
                contents: prompt,
                config: {
                    responseMimeType: 'text/plain'
                }
            });
            rawSummary = response?.text || '';
        }

        const summaryText = this.cleanSummaryText(rawSummary, 1800);
        if (!summaryText) {
            throw new Error('empty_graph_summary');
        }

        const summaryRow = await this.upsertGraphSummaryRow(sid, {
            scope_type: scopeType,
            scope_key: scopeKey,
            summary_text: summaryText,
            source_node_ids: nodes.map((n) => n.node_id),
            source_edge_ids: edges.map((e) => e.edge_id),
            model: this.getGraphSummaryModel(),
            freshness_turn_no: Number(options.currentTurnNo || 0),
            token_count: this.countApproxTokens(summaryText),
            quality_score: 0.72
        });

        this.clearGraphRagError();
        return {
            ...(summaryRow || {}),
            source_node_ids: nodes.map((n) => n.node_id),
            source_edge_ids: edges.map((e) => e.edge_id),
            cache_hit: false,
            subgraph_nodes: nodes.length,
            subgraph_edges: edges.length
        };
    }

    async getGraphRagContext({
        sessionId,
        playerAction = '',
        mentions = [],
        mentionEntityIds = [],
        locationName = null,
        currentTurnNo = 0,
        mode = 'narration'
    } = {}) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) {
            return {
                eligible: false,
                used: false,
                lines: [],
                scopes: [],
                cacheHit: false,
                subgraphNodes: 0,
                subgraphEdges: 0,
                fallbackReason: 'invalid_session'
            };
        }

        const detection = this.detectComplexQuery({
            playerAction,
            mentions,
            currentTurnNo,
            mode
        });
        const enabled = this.isGraphRagEnabled();
        const complexOnly = this.isGraphRagComplexOnly();
        const eligible = enabled && (!complexOnly || detection.complex);
        if (!eligible) {
            return {
                eligible: false,
                used: false,
                lines: [],
                scopes: [],
                cacheHit: false,
                subgraphNodes: 0,
                subgraphEdges: 0,
                fallbackReason: enabled ? 'not_complex' : 'disabled'
            };
        }

        const scopes = this.buildGraphScopes({
            mentionEntityIds,
            mentions,
            locationName,
            playerAction
        });

        const summaryRows = [];
        let cacheHitCount = 0;
        let refreshErrors = 0;

        for (const scope of scopes) {
            const cachedRow = await this.getGraphSummaryRow(sid, scope.scope_type, scope.scope_key);
            if (cachedRow && this.isSummaryFresh(cachedRow, currentTurnNo)) {
                summaryRows.push({ ...cachedRow, cache_hit: true });
                cacheHitCount += 1;
                continue;
            }

            try {
                const refreshedRow = await this.refreshGraphSummary(sid, scope.scope_type, scope.scope_key, {
                    currentTurnNo,
                    playerAction
                });
                if (refreshedRow) {
                    summaryRows.push(refreshedRow);
                }
            } catch (error) {
                refreshErrors += 1;
                this.setGraphRagError(error?.message || String(error));
            }
        }

        if (!summaryRows.length) {
            return {
                eligible: true,
                used: false,
                lines: [],
                scopes: scopes.map((s) => this.graphScopeKey(s.scope_type, s.scope_key)),
                cacheHit: false,
                subgraphNodes: 0,
                subgraphEdges: 0,
                fallbackReason: refreshErrors ? 'llm_error' : 'no_graph_data'
            };
        }

        const nodeIds = new Set();
        const edgeIds = new Set();
        for (const row of summaryRows) {
            for (const id of row.source_node_ids || []) nodeIds.add(Number(id));
            for (const id of row.source_edge_ids || []) edgeIds.add(Number(id));
        }

        const lines = summaryRows
            .map((row) => `[${row.scope_type}:${row.scope_key}] ${this.cleanSummaryText(row.summary_text || '', 540)}`)
            .filter(Boolean)
            .slice(0, this.getGraphMaxScopes());

        const cacheHit = summaryRows.length > 0 && cacheHitCount === summaryRows.length;
        this.clearGraphRagError();

        return {
            eligible: true,
            used: lines.length > 0,
            lines,
            scopes: scopes.map((s) => this.graphScopeKey(s.scope_type, s.scope_key)),
            cacheHit,
            subgraphNodes: nodeIds.size,
            subgraphEdges: edgeIds.size,
            fallbackReason: null
        };
    }

    async enqueueGraphJobsForTurn(sessionId, {
        turnId = null,
        turnNo = 0,
        playerAction = '',
        mentions = [],
        mentionEntityIds = [],
        locationName = null
    } = {}) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !this.isGraphRagEnabled()) return { enqueued: 0, scopes: [] };

        const scopes = this.buildGraphScopes({
            mentionEntityIds,
            mentions,
            locationName,
            playerAction
        });
        const runAfter = new Date().toISOString();
        const rows = [{
            session_id: sid,
            turn_id: turnId || null,
            job_type: 'build_incremental',
            scope_type: null,
            scope_key: null,
            status: 'pending',
            priority: 100,
            attempts: 0,
            run_after: runAfter
        }];

        if (this.shouldWarmGraphCacheOnTurn()) {
            for (const scope of scopes) {
                rows.push({
                    session_id: sid,
                    turn_id: turnId || null,
                    job_type: 'refresh_summary',
                    scope_type: scope.scope_type,
                    scope_key: scope.scope_key,
                    status: 'pending',
                    priority: 70,
                    attempts: 0,
                    run_after: runAfter
                });
            }
        }

        // Dedup: at most one unfinished job per (job_type, scope). Existing jobs
        // are re-targeted to the current turn instead of inserting duplicates
        // (backed by the uq_graph_jobs_active_target partial unique index).
        const jobKey = (r) => `${r.job_type}|${r.scope_type || ''}|${r.scope_key || ''}`;
        const { data: activeJobs, error: listError } = await this.restRequest('graph_jobs', {
            query: {
                select: 'job_id,job_type,scope_type,scope_key',
                session_id: `eq.${sid}`,
                status: 'in.(pending,failed)'
            }
        });
        if (listError) {
            this.setGraphRagError(`enqueueGraphJobsForTurn list failed: ${listError.message}`);
            return { enqueued: 0, scopes, error: listError.message };
        }

        const activeByKey = new Map((activeJobs || []).map((j) => [jobKey(j), j]));
        const newRows = rows.filter((r) => !activeByKey.has(jobKey(r)));
        const refreshIds = rows
            .map((r) => activeByKey.get(jobKey(r))?.job_id)
            .filter((id) => Number.isInteger(Number(id)));

        if (refreshIds.length) {
            const { error: patchError } = await this.restRequest('graph_jobs', {
                method: 'PATCH',
                query: { job_id: `in.(${refreshIds.join(',')})` },
                body: {
                    turn_id: turnId || null,
                    status: 'pending',
                    run_after: runAfter,
                    last_error: null
                }
            });
            if (patchError) {
                this.setGraphRagError(`enqueueGraphJobsForTurn retarget failed: ${patchError.message}`);
            }
        }

        let inserted = 0;
        if (newRows.length) {
            const { data, error } = await this.restRequest('graph_jobs', {
                method: 'POST',
                query: { select: 'job_id' },
                prefer: 'return=representation',
                body: newRows
            });
            if (error) {
                this.setGraphRagError(`enqueueGraphJobsForTurn failed: ${error.message}`);
                return { enqueued: 0, scopes, refreshed: refreshIds.length, error: error.message };
            }
            inserted = (data || []).length;
        }

        this.clearGraphRagError();
        return {
            enqueued: inserted,
            refreshed: refreshIds.length,
            scopes,
            turnNo: Number(turnNo || 0)
        };
    }

    async processPendingGraphJobs(sessionId, limit = null) {
        if (!this.isGraphRagEnabled() || !this.enabled) {
            return { processed: 0, completed: 0, failed: 0, skipped: 0 };
        }
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) {
            return { processed: 0, completed: 0, failed: 0, skipped: 0 };
        }

        const batch = Math.max(1, Math.min(24, Number(limit || this.getGraphJobBatch()) || this.getGraphJobBatch()));

        // One authoritative turn number for the whole batch: summaries are built
        // from the graph as it is NOW, so freshness must reflect the latest turn —
        // never the (possibly stale) turn the job was enqueued on.
        const { data: turnRows } = await this.restRequest('turns', {
            query: { select: 'turn_no', session_id: `eq.${sid}`, order: 'turn_no.desc', limit: 1 }
        });
        const currentTurnNo = Number(turnRows?.[0]?.turn_no || 0);

        const nowIso = new Date().toISOString();
        const { data: jobs, error } = await this.restRequest('graph_jobs', {
            query: {
                select: 'job_id,session_id,turn_id,job_type,scope_type,scope_key,status,priority,attempts',
                session_id: `eq.${sid}`,
                status: 'in.(pending,failed)',
                run_after: `lte.${nowIso}`,
                order: 'priority.desc,updated_at.asc',
                limit: batch
            }
        });

        if (error) {
            this.setGraphRagError(`processPendingGraphJobs list failed: ${error.message}`);
            return { processed: 0, completed: 0, failed: 0, skipped: 0, error: error.message };
        }

        let completed = 0;
        let failed = 0;
        let skipped = 0;

        for (const job of jobs || []) {
            const jobId = Number(job.job_id);
            if (!Number.isInteger(jobId) || jobId <= 0) continue;
            const nextAttempts = Number(job.attempts || 0) + 1;

            // Atomic claim: only one process may move the job out of pending/failed.
            const { data: claimedRows } = await this.restRequest('graph_jobs', {
                method: 'PATCH',
                query: { job_id: `eq.${jobId}`, status: 'in.(pending,failed)' },
                prefer: 'return=representation',
                body: {
                    status: 'processing',
                    attempts: nextAttempts,
                    last_error: null
                }
            });
            if (!claimedRows?.length) continue;

            try {
                if (job.job_type === 'build_incremental' || job.job_type === 'backfill') {
                    await this.buildGraphIncremental(sid, { turnNo: currentTurnNo });
                } else if (job.job_type === 'refresh_summary') {
                    if (!job.scope_type || !job.scope_key) {
                        throw new Error('refresh_summary job missing scope');
                    }
                    const existingSummary = await this.getGraphSummaryRow(sid, job.scope_type, job.scope_key);
                    if (existingSummary && this.isSummaryFresh(existingSummary, currentTurnNo)) {
                        // Summary is already up to date — close without an LLM call.
                        await this.restRequest('graph_jobs', {
                            method: 'PATCH',
                            query: { job_id: `eq.${jobId}` },
                            body: { status: 'skipped', last_error: null }
                        });
                        skipped += 1;
                        continue;
                    }
                    await this.refreshGraphSummary(sid, job.scope_type, job.scope_key, { currentTurnNo });
                } else {
                    throw new Error(`unsupported graph job type: ${job.job_type}`);
                }

                await this.restRequest('graph_jobs', {
                    method: 'PATCH',
                    query: { job_id: `eq.${jobId}` },
                    body: {
                        status: 'completed',
                        last_error: null
                    }
                });
                completed += 1;
            } catch (errorProcessJob) {
                const retryInSec = this.graphJobBackoffSeconds(nextAttempts);
                const runAfter = new Date(Date.now() + retryInSec * 1000).toISOString();
                const lastError = String(errorProcessJob?.message || errorProcessJob || 'unknown graph job error').slice(0, 400);
                await this.restRequest('graph_jobs', {
                    method: 'PATCH',
                    query: { job_id: `eq.${jobId}` },
                    body: {
                        status: 'failed',
                        last_error: lastError,
                        run_after: runAfter
                    }
                });
                this.setGraphRagError(lastError);
                failed += 1;
            }
        }

        if (completed > 0 && failed === 0) {
            this.clearGraphRagError();
        }

        return {
            processed: (jobs || []).length,
            completed,
            failed,
            skipped,
            currentTurnNo
        };
    }

    async getGraphRagState() {
        const enabled = this.isGraphRagEnabled();
        const complexOnly = this.isGraphRagComplexOnly();
        const timeoutMs = this.getGraphRagTimeoutMs();

        if (!this.enabled || !enabled) {
            return {
                enabled,
                complexOnly,
                timeoutMs,
                lastError: this.graphRagLastError,
                jobsPending: 0,
                summaryCount: 0
            };
        }

        const [summaryCount, jobsPending] = await Promise.all([
            this.tableCount('graph_summaries'),
            (async () => {
                const { count, error } = await this.restRequest('graph_jobs', {
                    method: 'HEAD',
                    query: {
                        select: '*',
                        status: 'in.(pending,processing)'
                    },
                    prefer: 'count=exact'
                });
                if (error) return 0;
                return count;
            })()
        ]);

        return {
            enabled,
            complexOnly,
            timeoutMs,
            lastError: this.graphRagLastError,
            jobsPending,
            summaryCount
        };
    }

    async getContextBundle(sessionId, queryText, matchCount = 8, mentions = []) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) {
            return {
                memories: [],
                memoryRows: [],
                mentionDossiers: [],
                resolvedMentions: [],
                deterministic: { questFacts: [], relationFacts: [], stateFacts: [], recentEvents: [], recentTurns: [] },
                dueConsequences: [],
                currentTurnNo: 0
            };
        }

        const mentionContext = await this.resolveMentionEntities(sid, mentions, queryText);
        const mentionEntityIds = mentionContext.entities.map(e => e.entity_id).filter(Boolean);
        const latestTurnNoPromise = this.getLatestTurnNo(sid);

        const [hybridMemoryRows, mentionMemories, mentionDossiers, deterministic, latestTurnNo] = await Promise.all([
            this.fetchHybridMemoryRows(sid, queryText, matchCount),
            this.getMentionMemoryTexts(sid, mentionEntityIds, Math.max(4, mentionEntityIds.length * 2)),
            this.getMentionDossiers(sid, mentionContext.entities),
            this.getDeterministicContext(sid, mentionEntityIds, null),
            latestTurnNoPromise
        ]);

        const dueConsequences = await this.getDueConsequences(
            sid,
            latestTurnNo,
            null,
            mentionEntityIds
        );

        const hybridMemories = hybridMemoryRows.map(x => x.text_content).filter(Boolean);
        const mergedMemories = Array.from(
            new Set([
                ...mentionMemories,
                ...hybridMemories
            ].filter(Boolean))
        ).slice(0, Math.max(4, Math.min(matchCount + 4, 14)));

        return {
            memories: mergedMemories,
            memoryRows: hybridMemoryRows,
            mentionDossiers,
            resolvedMentions: mentionContext.resolvedMentions,
            deterministic,
            dueConsequences,
            currentTurnNo: latestTurnNo
        };
    }

    computeImportance(playerAction, currentState, nextState) {
        let score = 0.35;

        const xp = Number(nextState?.xpAwarded || 0);
        if (xp > 0) score += Math.min(0.35, xp / 200);
        if (nextState?.player?.isDead) score += 0.5;

        const completedQuests = (nextState?.quests || []).filter(q => q?.status === 'completed').length;
        if (completedQuests > 0) score += 0.25;

        const text = `${playerAction || ''} ${nextState?.description || ''}`.toLowerCase();
        if (/\b(help|water|saved|promise|debt|betray|revenge)\b/.test(text)) score += 0.15;
        if (/\b(killed|dead|death|explode|betrayed)\b/.test(text)) score += 0.2;

        if (Array.isArray(currentState?.quests) && Array.isArray(nextState?.quests)) {
            const beforeActive = new Set(currentState.quests.filter(q => q?.status === 'active').map(q => q.name));
            const afterCompleted = nextState.quests.filter(q => q?.status === 'completed' && beforeActive.has(q.name)).length;
            if (afterCompleted > 0) score += 0.15;
        }

        return Math.max(0.05, Math.min(1, Number(score.toFixed(3))));
    }

    inferMemoryType(playerAction, nextState) {
        const text = `${playerAction || ''} ${nextState?.description || ''}`.toLowerCase();
        if (nextState?.player?.isDead) return 'death';
        if ((nextState?.quests || []).some(q => q?.status === 'completed')) return 'quest';
        if (/\b(attack|fight|shoot|ambush|combat)\b/.test(text)) return 'combat';
        if (/\b(promise|owe|debt|swear|deal)\b/.test(text)) return 'promise';
        if (/\b(help|water|gave|gift|saved)\b/.test(text)) return 'help';
        if (/\b(rumor|heard|whisper)\b/.test(text)) return 'rumor';
        return 'interaction';
    }

    inferPinned(importance, nextState) {
        if (nextState?.player?.isDead) return true;
        if ((nextState?.quests || []).some(q => q?.status === 'completed')) return true;
        return importance >= 0.85;
    }

    buildDeferredConsequenceTemplates(playerAction, nextState, baseImportance = 0.5) {
        const text = `${playerAction || ''} ${nextState?.description || ''}`.toLowerCase();
        const templates = [];

        if (/\b(promise|owe|debt|swear|deal)\b/.test(text)) {
            templates.push({
                eventType: 'debt_due',
                dueOffset: 3,
                summary: 'An outstanding promise or debt is likely to come due soon.',
                importance: Math.max(0.45, Math.min(0.9, baseImportance + 0.08))
            });
        }
        if (/\b(betray|threat|attack|stole|killed|ambush)\b/.test(text)) {
            templates.push({
                eventType: 'revenge',
                dueOffset: 2,
                summary: 'Someone affected by this turn may seek revenge later.',
                importance: Math.max(0.55, Math.min(0.95, baseImportance + 0.15))
            });
        }
        if (/\b(rumor|heard|whisper|broadcast|witness)\b/.test(text) || /\b(help|saved|water|gift)\b/.test(text)) {
            templates.push({
                eventType: 'rumor_spread',
                dueOffset: 2,
                summary: 'News of these actions may spread to other NPCs and factions.',
                importance: Math.max(0.4, Math.min(0.85, baseImportance + 0.04))
            });
        }

        return templates.slice(0, 3);
    }

    async scheduleDeferredConsequences(sessionId, causeEventId, turnId, turnNo, actorEntityIds, locationName, templates) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !causeEventId || !Array.isArray(templates) || !templates.length) return [];

        const rows = templates.map((tpl) => ({
            session_id: sid,
            turn_id: turnId || null,
            event_type: tpl.eventType,
            summary: tpl.summary,
            importance: Number(tpl.importance || 0.5),
            location_name: locationName || null,
            actor_entity_ids: Array.isArray(actorEntityIds) ? actorEntityIds.slice(0, 64) : [],
            payload: {
                template: tpl.eventType,
                status: 'pending',
                due_turn_no: Number(turnNo || 0) + Number(tpl.dueOffset || 1),
                cause_event_id: causeEventId
            },
            caused_by_event_id: causeEventId
        }));

        const { data, error } = await this.restRequest('events', {
            method: 'POST',
            query: { select: 'event_id,event_type' },
            prefer: 'return=representation',
            body: rows
        });
        if (error) {
            console.error('scheduleDeferredConsequences insert failed:', error.message);
            return [];
        }

        const edgeRows = (data || []).map((row) => ({
            cause_event_id: causeEventId,
            effect_event_id: row.event_id,
            edge_type: `deferred_${row.event_type || 'consequence'}`
        }));
        if (edgeRows.length) {
            const { error: edgeErr } = await this.restRequest('event_edges', {
                method: 'POST',
                prefer: 'resolution=merge-duplicates,return=minimal',
                body: edgeRows
            });
            if (edgeErr) {
                console.error('scheduleDeferredConsequences edge insert failed:', edgeErr.message);
            }
        }

        return data || [];
    }

    extractNpcDialogueMap(descriptionText) {
        const text = String(descriptionText || '');
        const map = new Map();
        if (!text) return map;

        const pattern = /\[DIALOGUE\s+speaker=\"([^\"]+)\"\s+gender=\"(male|female|unknown)\"\](.*?)\[\/DIALOGUE\]/gis;
        let match = null;
        while ((match = pattern.exec(text)) !== null) {
            const speaker = String(match[1] || '').trim();
            const line = String(match[3] || '').replace(/\s+/g, ' ').trim();
            const key = this.normalizeEntityKey(speaker);
            if (!key || !line) continue;

            const existing = map.get(key) || [];
            existing.push(line.slice(0, 220));
            map.set(key, existing.slice(-3));
        }

        return map;
    }

    inferNpcPersona(statusLabel, dialogueLines = [], previousPersona = null) {
        const status = String(statusLabel || '').trim() || 'Unknown';
        const lines = Array.isArray(dialogueLines) ? dialogueLines.filter(Boolean) : [];
        const previous = String(previousPersona || '').trim();
        if (previous && lines.length === 0) return previous;

        const corpus = `${status} ${lines.join(' ')}`.toLowerCase();
        let trait = 'cautious';
        if (/\b(hostile|threat|kill|shoot|ambush|attack)\b/.test(corpus)) trait = 'aggressive';
        else if (/\b(friend|friendly|trust|help|thanks|grateful)\b/.test(corpus)) trait = 'cooperative';
        else if (/\b(trade|caps|deal|price|barter)\b/.test(corpus)) trait = 'pragmatic';
        else if (/\b(scared|fear|worry|panic)\b/.test(corpus)) trait = 'anxious';

        const summaryParts = [
            `${trait} wastelander`,
            `disposition: ${status}`
        ];
        if (lines[0]) {
            summaryParts.push(`recent voice: "${lines[0].slice(0, 120)}"`);
        }
        return summaryParts.join('; ');
    }

    inferNpcGoals(npcName, quests = [], previousGoals = []) {
        const npcKey = this.normalizeEntityKey(npcName);
        if (!npcKey) return Array.isArray(previousGoals) ? previousGoals.slice(0, 4) : [];

        const inferred = [];
        for (const quest of quests || []) {
            if (!quest || !quest.name) continue;
            const status = String(quest.status || 'active');
            if (status !== 'active') continue;

            if (Array.isArray(quest.objectives)) {
                for (const obj of quest.objectives) {
                    const objective = String(obj?.description || '').trim();
                    if (!objective) continue;
                    if (this.normalizeEntityKey(objective).includes(npcKey)) {
                        inferred.push(`${quest.name}: ${objective.slice(0, 120)}`);
                    }
                }
            }

            const questDescription = String(quest.description || '').trim();
            if (questDescription && this.normalizeEntityKey(questDescription).includes(npcKey)) {
                inferred.push(`${quest.name}: ${questDescription.slice(0, 120)}`);
            }
        }

        if (inferred.length) {
            return Array.from(new Set(inferred)).slice(0, 4);
        }

        if (Array.isArray(previousGoals) && previousGoals.length) {
            return previousGoals.slice(0, 4);
        }

        return [];
    }

    fallbackGoalFromStatus(statusLabel = '') {
        const status = String(statusLabel || '').toLowerCase();
        if (status.includes('hostile')) return 'eliminate perceived threats';
        if (status.includes('friendly')) return 'maintain cooperation with the player';
        if (status.includes('wary')) return 'gather proof before committing to trust';
        return 'survive and secure resources';
    }

    buildNpcGoalSystem(npcName, goals = [], statusLabel = 'Unknown', previousGoalSystem = null) {
        const normalized = Array.from(new Set((Array.isArray(goals) ? goals : []).map((g) => String(g || '').trim()).filter(Boolean))).slice(0, 4);
        const previous = this.toPlainObject(previousGoalSystem);
        const primary = normalized[0] || previous.primary || this.fallbackGoalFromStatus(statusLabel);
        const secondary = normalized.length
            ? normalized.slice(1, 3)
            : (Array.isArray(previous.secondary) ? previous.secondary.slice(0, 2) : []);

        return {
            actor: String(npcName || '').trim() || 'unknown_npc',
            primary,
            secondary,
            pressure: secondary.length ? 'medium' : 'low'
        };
    }

    buildNpcBehaviorProfile(statusLabel = 'Unknown', relationScore = 0, trustScore = null, goals = [], previousBehavior = null) {
        const status = String(statusLabel || '').toLowerCase();
        const relation = this.clamp(relationScore, -1, 1, 0);
        const trust = Number.isFinite(Number(trustScore))
            ? this.clamp(Number(trustScore), 0, 1, 0.5)
            : this.clamp((relation + 1) / 2, 0, 1, 0.5);
        const prev = this.toPlainObject(previousBehavior);

        let tone = prev.tone || 'neutral';
        if (trust >= 0.68 || status.includes('friendly')) tone = 'warm';
        else if (trust <= 0.32 || status.includes('hostile')) tone = 'threatening';
        else if (status.includes('wary')) tone = 'guarded';
        else tone = 'neutral';

        let risk = prev.risk || 'measured';
        if (status.includes('hostile') || trust <= 0.25) risk = 'bold';
        else if (status.includes('wary') || /\b(scared|fear|panic)\b/.test(status)) risk = 'cautious';
        else risk = 'measured';

        let generosity = prev.generosity || 'medium';
        if (trust >= 0.72) generosity = 'high';
        else if (trust <= 0.35) generosity = 'low';
        else generosity = 'medium';

        const focus = Array.isArray(goals) && goals.length ? String(goals[0]).slice(0, 140) : null;
        return {
            tone,
            risk,
            generosity,
            trust: Number(trust.toFixed(3)),
            relation_to_player: Number(relation.toFixed(3)),
            current_focus: focus
        };
    }

    getNpcReflectionFrequency() {
        const raw = Number(process.env.NPC_REFLECTION_EVERY_N_EVENTS || 4);
        if (!Number.isFinite(raw)) return 4;
        return Math.max(2, Math.min(12, Math.round(raw)));
    }

    scoreReflectionSignals(events = []) {
        let positive = 0;
        let negative = 0;
        for (const event of events || []) {
            const text = `${event?.event_type || ''} ${event?.summary || ''}`.toLowerCase();
            const importance = this.clamp(Number(event?.importance || 0.5), 0, 1, 0.5);
            const weight = 0.25 + importance;

            if (/\b(help|saved|water|gift|trade|promise|debt_due|quest|ally|cooperate)\b/.test(text)) {
                positive += weight;
            }
            if (/\b(attack|betray|revenge|stole|killed|death|hostile|threat)\b/.test(text)) {
                negative += weight;
            }
        }
        return {
            positive: Number(positive.toFixed(3)),
            negative: Number(negative.toFixed(3)),
            delta: Number((positive - negative).toFixed(3))
        };
    }

    computeNpcTrust(relationScore = 0, signalDelta = 0, previousTrust = null) {
        const relationPart = this.clamp((Number(relationScore) + 1) / 2, 0, 1, 0.5);
        const signalPart = this.clamp(0.5 + Number(signalDelta) * 0.08, 0, 1, 0.5);
        let trust = relationPart * 0.65 + signalPart * 0.35;
        if (Number.isFinite(Number(previousTrust))) {
            trust = trust * 0.75 + this.clamp(Number(previousTrust), 0, 1, 0.5) * 0.25;
        }
        return Number(this.clamp(trust, 0, 1, 0.5).toFixed(3));
    }

    buildNpcReflectionSummary(name, trust, previousTrust, behavior, goalSystem, recentEvents = []) {
        let stance = 'remains uncertain about the player';
        if (trust >= 0.7) stance = 'now trusts the player and expects cooperation';
        else if (trust <= 0.3) stance = 'distrusts the player and expects conflict';

        const trend = Number.isFinite(Number(previousTrust))
            ? (trust > Number(previousTrust) + 0.06 ? 'trust increasing' : (trust < Number(previousTrust) - 0.06 ? 'trust decreasing' : 'trust stable'))
            : 'first trust baseline';

        const drivers = (recentEvents || [])
            .slice(0, 2)
            .map((event) => String(event?.summary || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .map((line) => line.slice(0, 110));

        const driverText = drivers.length ? ` Drivers: ${drivers.join(' | ')}` : '';
        return `${name} reflection: ${stance}; ${trend}; tone=${behavior.tone}, risk=${behavior.risk}, generosity=${behavior.generosity}; primary_goal=${goalSystem.primary}.${driverText}`.slice(0, 680);
    }

    toVectorLiteral(values) {
        if (!Array.isArray(values) || values.length === 0) return null;
        return `[${values.map(v => Number.isFinite(v) ? Number(v).toFixed(8) : '0').join(',')}]`;
    }

    async generateEmbedding(text) {
        const provider = this.getEmbeddingProvider();
        if (!provider || !text) return null;

        try {
            if (provider === 'openrouter') {
                return await openrouterClient.createEmbedding(text);
            }
            const response = await byok.getOpenAIClient().embeddings.create({
                model: 'text-embedding-3-small',
                input: text,
                encoding_format: 'float'
            });
            return response?.data?.[0]?.embedding || null;
        } catch (error) {
            console.error(`generateEmbedding (${provider}) failed:`, error?.message || error);
            byok.noteKeyFailure(provider, error);
            return null;
        }
    }

    async upsertQuestState(sessionId, quests = []) {
        const rows = quests
            .filter(q => q?.name)
            .map(q => ({
                session_id: sessionId,
                quest_key: this.normalizeEntityKey(q.name),
                quest_name: q.name,
                status: q.status || 'active',
                objectives: Array.isArray(q.objectives) ? q.objectives : [],
                metadata: { description: q.description || null }
            }));

        if (!rows.length) return;

        const { error } = await this.restRequest('quest_state', {
            method: 'POST',
            query: { on_conflict: 'session_id,quest_key' },
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: rows
        });
        if (error) console.error('upsertQuestState failed:', error.message);
    }

    async upsertEntityState(sessionId, nextState, turnId, entityMap) {
        const rows = [];
        const npcRows = [];
        const dialogueByNpc = this.extractNpcDialogueMap(nextState?.description || '');

        for (const npc of nextState?.npcs || []) {
            const entity = entityMap.get(this.keyFor('npc', npc?.name));
            if (!entity?.entity_id) continue;
            npcRows.push({ npc, entity });
        }

        const npcStateByEntityId = new Map();
        const npcEntityIds = npcRows.map(x => x.entity.entity_id);
        const npcInFilter = this.toPostgrestInFilter(npcEntityIds);
        if (npcInFilter) {
            const { data: existingNpcStates, error: existingNpcStatesErr } = await this.restRequest('entity_state', {
                query: {
                    select: 'entity_id,state',
                    session_id: `eq.${sessionId}`,
                    entity_id: npcInFilter,
                    limit: 200
                }
            });
            if (existingNpcStatesErr) {
                console.error('upsertEntityState preload NPC state failed:', existingNpcStatesErr.message);
            } else {
                for (const row of existingNpcStates || []) {
                    npcStateByEntityId.set(row.entity_id, row.state || {});
                }
            }
        }

        for (const { npc, entity } of npcRows) {
            const previousState = npcStateByEntityId.get(entity.entity_id) || {};
            const npcKey = this.normalizeEntityKey(npc?.name);
            const dialogueLines = dialogueByNpc.get(npcKey) || [];

            let relation = 0;
            const status = String(npc?.status || '').toLowerCase();
            if (status.includes('friendly')) relation = 0.6;
            else if (status.includes('hostile')) relation = -0.8;
            else if (status.includes('wary')) relation = -0.2;

            const persona = this.inferNpcPersona(
                npc?.status || previousState?.status || 'Unknown',
                dialogueLines,
                previousState?.persona || null
            );
            const goals = this.inferNpcGoals(
                npc?.name || '',
                nextState?.quests || [],
                Array.isArray(previousState?.goals) ? previousState.goals : []
            );
            const goalSystem = this.buildNpcGoalSystem(
                npc?.name || '',
                goals,
                npc?.status || previousState?.status || 'Unknown',
                previousState?.goal_system || null
            );
            const behavior = this.buildNpcBehaviorProfile(
                npc?.status || previousState?.status || 'Unknown',
                relation,
                previousState?.behavior?.trust ?? null,
                goals,
                previousState?.behavior || null
            );

            const mergedNpcState = {
                ...(typeof previousState === 'object' && previousState ? previousState : {}),
                status: npc.status || previousState?.status || 'Unknown',
                persona,
                goals,
                goal_system: goalSystem,
                behavior,
                last_dialogue: dialogueLines[0] || previousState?.last_dialogue || null
            };

            rows.push({
                session_id: sessionId,
                entity_id: entity.entity_id,
                state: mergedNpcState,
                relation_to_player: relation,
                last_seen_turn: turnId,
                last_seen_location: nextState?.location?.name || null
            });
        }

        if (nextState?.location?.name) {
            const loc = entityMap.get(this.keyFor('location', nextState.location.name));
            if (loc) {
                rows.push({
                    session_id: sessionId,
                    entity_id: loc.entity_id,
                    state: {
                        description: nextState.location.description || null,
                        coordinates: nextState.location.coordinates || null
                    },
                    relation_to_player: 0,
                    last_seen_turn: turnId,
                    last_seen_location: nextState.location.name
                });
            }
        }

        if (!rows.length) return;

        const { error } = await this.restRequest('entity_state', {
            method: 'POST',
            query: { on_conflict: 'session_id,entity_id' },
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: rows
        });
        if (error) console.error('upsertEntityState failed:', error.message);
    }

    async upsertNpcRelations(sessionId, nextState, entityMap, evidenceEventId) {
        const player = entityMap.get(this.keyFor('player', 'Player'));
        if (!player) return;

        const rows = [];
        for (const npc of nextState?.npcs || []) {
            const entity = entityMap.get(this.keyFor('npc', npc?.name));
            if (!entity) continue;

            const status = String(npc?.status || '').toLowerCase();
            let weight = 0;
            if (status.includes('friendly')) weight = 0.7;
            else if (status.includes('hostile')) weight = -0.85;
            else if (status.includes('wary')) weight = -0.25;

            rows.push({
                session_id: sessionId,
                from_entity_id: entity.entity_id,
                to_entity_id: player.entity_id,
                relation_type: 'attitude_to_player',
                weight,
                evidence_event_id: evidenceEventId || null,
                metadata: { status: npc.status || 'Unknown' }
            });
        }

        if (!rows.length) return;

        const { error } = await this.restRequest('relations', {
            method: 'POST',
            query: { on_conflict: 'session_id,from_entity_id,to_entity_id,relation_type' },
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: rows
        });
        if (error) console.error('upsertNpcRelations failed:', error.message);
    }

    async enqueueEmbeddingJob(sessionId, memoryId, status = 'pending', lastError = null, attempts = 0) {
        if (!sessionId || !memoryId) return;

        const runAfter = new Date();
        if (status === 'failed') {
            const delaySeconds = Math.min(300, Math.max(15, attempts * attempts * 15));
            runAfter.setSeconds(runAfter.getSeconds() + delaySeconds);
        }

        const { error } = await this.restRequest('embedding_jobs', {
            method: 'POST',
            query: { on_conflict: 'memory_id' },
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: [{
                session_id: sessionId,
                memory_id: memoryId,
                status,
                attempts,
                last_error: lastError,
                run_after: runAfter.toISOString()
            }]
        });
        if (error) console.error('enqueueEmbeddingJob failed:', error.message);
    }

    // Scoped to one session: with BYOK the key belongs to the player of this session, so it
    // must not pay for (or see) other sessions' memories.
    async processPendingEmbeddingJobs(sessionId, limit = 4) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !this.canEmbed()) return;

        const nowIso = new Date().toISOString();
        const { data: jobs, error } = await this.restRequest('embedding_jobs', {
            query: {
                select: 'job_id,session_id,memory_id,attempts,status,run_after',
                session_id: `eq.${sid}`,
                status: 'in.(pending,failed)',
                run_after: `lte.${nowIso}`,
                order: 'attempts.asc,run_after.asc',
                limit
            }
        });

        if (error) {
            console.error('processPendingEmbeddingJobs list failed:', error.message);
            return;
        }

        for (const job of jobs || []) {
            const nextAttempts = Number(job.attempts || 0) + 1;

            await this.restRequest('embedding_jobs', {
                method: 'PATCH',
                query: { job_id: `eq.${job.job_id}` },
                body: { status: 'processing', attempts: nextAttempts, last_error: null }
            });

            const { data: memRows, error: memErr } = await this.restRequest('memory_items', {
                query: {
                    select: 'memory_id,text_content,embedding',
                    memory_id: `eq.${job.memory_id}`,
                    limit: 1
                }
            });

            if (memErr || !memRows?.length) {
                await this.enqueueEmbeddingJob(job.session_id, job.memory_id, 'failed', memErr?.message || 'memory not found', nextAttempts);
                continue;
            }

            const mem = memRows[0];
            if (mem.embedding) {
                await this.restRequest('embedding_jobs', {
                    method: 'PATCH',
                    query: { job_id: `eq.${job.job_id}` },
                    body: { status: 'completed', last_error: null }
                });
                continue;
            }

            const embedding = await this.generateEmbedding(mem.text_content);
            if (!embedding) {
                await this.enqueueEmbeddingJob(job.session_id, job.memory_id, 'failed', 'embedding generation failed', nextAttempts);
                continue;
            }

            const vector = this.toVectorLiteral(embedding);
            const { error: updateMemErr } = await this.restRequest('memory_items', {
                method: 'PATCH',
                query: { memory_id: `eq.${mem.memory_id}` },
                body: { embedding: vector }
            });

            if (updateMemErr) {
                await this.enqueueEmbeddingJob(job.session_id, mem.memory_id, 'failed', updateMemErr.message, nextAttempts);
                continue;
            }

            await this.restRequest('embedding_jobs', {
                method: 'PATCH',
                query: { job_id: `eq.${job.job_id}` },
                body: { status: 'completed', last_error: null }
            });
        }
    }

    async applyStatePatchesTransactional(sessionId, turnId, turnNo, causeEventId, locationName, patches) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !turnId || !Number.isFinite(Number(turnNo))) {
            return { applied: false, error: 'invalid_state_patch_arguments' };
        }

        const payload = patches && typeof patches === 'object' ? patches : {};
        const { data, error } = await this.restRequest('rpc/apply_state_patches_v1', {
            method: 'POST',
            body: {
                p_session_id: sid,
                p_turn_id: Number(turnId),
                p_turn_no: Number(turnNo),
                p_cause_event_id: causeEventId || null,
                p_location_name: locationName || null,
                p_patches: payload
            }
        });

        if (error) {
            return {
                applied: false,
                error: error.message || 'apply_state_patches_v1 failed',
                details: error.details || null
            };
        }

        return { applied: true, result: data || null };
    }

    async runNpcReflections(sessionId, {
        turnId,
        turnNo,
        causeEventId,
        locationName,
        nextState,
        entityMap,
        mentionEntities = []
    } = {}) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !turnId || !Number.isFinite(Number(turnNo))) {
            return { evaluated: 0, reflected: 0, generatedEvents: 0, generatedMemories: 0, threshold: this.getNpcReflectionFrequency() };
        }

        const reflectionThreshold = this.getNpcReflectionFrequency();
        const maxCandidates = 8;

        const { data: npcEntities, error: npcEntitiesErr } = await this.restRequest('entities', {
            query: {
                select: 'entity_id,display_name,entity_type,updated_at',
                session_id: `eq.${sid}`,
                entity_type: 'eq.npc',
                order: 'updated_at.desc',
                limit: 120
            }
        });
        if (npcEntitiesErr || !Array.isArray(npcEntities) || !npcEntities.length) {
            if (npcEntitiesErr) console.error('runNpcReflections list entities failed:', npcEntitiesErr.message);
            return { evaluated: 0, reflected: 0, generatedEvents: 0, generatedMemories: 0, threshold: reflectionThreshold };
        }

        const npcMap = new Map(npcEntities.map((row) => [row.entity_id, row]));
        const activeNpcIds = new Set();
        for (const npc of nextState?.npcs || []) {
            const entity = entityMap?.get(this.keyFor('npc', npc?.name));
            if (entity?.entity_id && npcMap.has(entity.entity_id)) {
                activeNpcIds.add(entity.entity_id);
            }
        }
        for (const mention of mentionEntities || []) {
            if (mention?.entity_type === 'npc' && mention?.entity_id && npcMap.has(mention.entity_id)) {
                activeNpcIds.add(mention.entity_id);
            }
        }

        const candidateIds = [];
        for (const id of activeNpcIds) candidateIds.push(id);
        for (const row of npcEntities) {
            if (!row?.entity_id || activeNpcIds.has(row.entity_id)) continue;
            candidateIds.push(row.entity_id);
            if (candidateIds.length >= maxCandidates) break;
        }
        if (!candidateIds.length) {
            return { evaluated: 0, reflected: 0, generatedEvents: 0, generatedMemories: 0, threshold: reflectionThreshold };
        }

        const candidateFilter = this.toPostgrestInFilter(candidateIds);
        const { data: stateRows, error: stateErr } = await this.restRequest('entity_state', {
            query: {
                select: 'entity_id,state,relation_to_player,last_seen_turn,last_seen_location,updated_at',
                session_id: `eq.${sid}`,
                entity_id: candidateFilter,
                limit: 200
            }
        });
        if (stateErr) {
            console.error('runNpcReflections load entity_state failed:', stateErr.message);
        }
        const stateByEntityId = new Map((stateRows || []).map((row) => [row.entity_id, row]));

        const { data: eventRows, error: eventErr } = await this.restRequest('events', {
            query: {
                select: 'event_id,event_type,summary,importance,actor_entity_ids,created_at',
                session_id: `eq.${sid}`,
                order: 'event_id.desc',
                limit: 350
            }
        });
        if (eventErr) {
            console.error('runNpcReflections load events failed:', eventErr.message);
            return { evaluated: candidateIds.length, reflected: 0, generatedEvents: 0, generatedMemories: 0, threshold: reflectionThreshold };
        }

        const relevantEvents = (eventRows || [])
            .filter((row) => row?.event_id && row?.event_type !== 'npc_reflection')
            .reverse();

        const eventsByNpc = new Map(candidateIds.map((id) => [id, []]));
        for (const event of relevantEvents) {
            const actorIds = Array.isArray(event.actor_entity_ids) ? event.actor_entity_ids : [];
            for (const actorId of actorIds) {
                if (!eventsByNpc.has(actorId)) continue;
                eventsByNpc.get(actorId).push(event);
            }
        }

        const playerEntityId = entityMap?.get(this.keyFor('player', 'Player'))?.entity_id || null;
        const statusByNpcEntityId = new Map();
        for (const npc of nextState?.npcs || []) {
            const entity = entityMap?.get(this.keyFor('npc', npc?.name));
            if (entity?.entity_id) {
                statusByNpcEntityId.set(entity.entity_id, npc?.status || 'Unknown');
            }
        }

        const nowIso = new Date().toISOString();
        const stateUpsertRows = [];
        const reflectionEventRows = [];
        const reflectionMemoryRows = [];
        const reflectedNames = [];

        for (const npcEntityId of candidateIds) {
            const entity = npcMap.get(npcEntityId);
            const stateRow = stateByEntityId.get(npcEntityId);
            const existingState = this.toPlainObject(stateRow?.state);
            const existingReflection = this.toPlainObject(existingState.reflection);
            const lastReflectionEventId = Number(existingReflection.last_reflection_event_id || 0);
            const npcEvents = eventsByNpc.get(npcEntityId) || [];
            const freshEvents = npcEvents.filter((event) => Number(event.event_id || 0) > lastReflectionEventId);
            if (freshEvents.length < reflectionThreshold) continue;

            const recentEvents = freshEvents.slice(-Math.min(8, freshEvents.length));
            const signal = this.scoreReflectionSignals(recentEvents);
            const relation = this.clamp(stateRow?.relation_to_player, -1, 1, 0);
            const previousTrust = Number.isFinite(Number(existingReflection.trust)) ? Number(existingReflection.trust) : null;
            const trust = this.computeNpcTrust(relation, signal.delta, previousTrust);
            const goals = Array.isArray(existingState.goals) ? existingState.goals.slice(0, 4) : [];
            const status = statusByNpcEntityId.get(npcEntityId) || existingState.status || 'Unknown';
            const goalSystem = this.buildNpcGoalSystem(entity?.display_name || 'Unknown NPC', goals, status, existingState.goal_system || null);
            const behavior = this.buildNpcBehaviorProfile(status, relation, trust, goals, existingState.behavior || null);
            const reflectionSummary = this.buildNpcReflectionSummary(
                entity?.display_name || 'Unknown NPC',
                trust,
                previousTrust,
                behavior,
                goalSystem,
                recentEvents
            );

            const latestEventId = Number(freshEvents[freshEvents.length - 1]?.event_id || 0);
            const mergedState = {
                ...existingState,
                status: status || existingState.status || 'Unknown',
                goals: goals.length ? goals : (Array.isArray(existingState.goals) ? existingState.goals.slice(0, 4) : []),
                goal_system: goalSystem,
                behavior,
                reflection: {
                    version: 1,
                    trust,
                    signal_delta: signal.delta,
                    positive_signals: signal.positive,
                    negative_signals: signal.negative,
                    events_considered: freshEvents.length,
                    last_reflection_event_id: latestEventId,
                    last_reflection_turn_no: Number(turnNo),
                    last_reflection_at: nowIso,
                    summary: reflectionSummary
                }
            };

            stateUpsertRows.push({
                session_id: sid,
                entity_id: npcEntityId,
                state: mergedState,
                relation_to_player: relation,
                last_seen_turn: stateRow?.last_seen_turn || turnId,
                last_seen_location: stateRow?.last_seen_location || locationName || null
            });

            reflectionEventRows.push({
                session_id: sid,
                turn_id: turnId,
                event_type: 'npc_reflection',
                summary: reflectionSummary,
                importance: this.clamp(0.52 + Math.abs(trust - 0.5) * 0.35, 0.35, 0.92, 0.55),
                location_name: locationName || stateRow?.last_seen_location || null,
                actor_entity_ids: [npcEntityId, playerEntityId].filter(Boolean),
                payload: {
                    source: 'npc_reflection_v1',
                    reflection_entity_id: npcEntityId,
                    trust,
                    behavior
                },
                caused_by_event_id: causeEventId || null
            });

            reflectionMemoryRows.push({
                session_id: sid,
                turn_id: turnId,
                source_event_id: null,
                text_content: reflectionSummary,
                entity_ids: [npcEntityId, playerEntityId].filter(Boolean),
                location_name: locationName || stateRow?.last_seen_location || null,
                memory_type: 'npc_reflection',
                importance: this.clamp(0.58 + Math.abs(trust - 0.5) * 0.35, 0.45, 0.95, 0.62),
                pinned: true,
                metadata: {
                    turnNo: Number(turnNo),
                    reflection: true,
                    reflection_entity_id: npcEntityId,
                    trust,
                    behavior
                }
            });

            reflectedNames.push(entity?.display_name || npcEntityId);
        }

        if (!stateUpsertRows.length) {
            return { evaluated: candidateIds.length, reflected: 0, generatedEvents: 0, generatedMemories: 0, threshold: reflectionThreshold };
        }

        const { error: upsertErr } = await this.restRequest('entity_state', {
            method: 'POST',
            query: { on_conflict: 'session_id,entity_id' },
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: stateUpsertRows
        });
        if (upsertErr) {
            console.error('runNpcReflections upsert entity_state failed:', upsertErr.message);
        }

        let insertedEvents = [];
        const { data: eventInsertRows, error: reflectionEventErr } = await this.restRequest('events', {
            method: 'POST',
            query: { select: 'event_id,payload' },
            prefer: 'return=representation',
            body: reflectionEventRows
        });
        if (reflectionEventErr) {
            console.error('runNpcReflections insert events failed:', reflectionEventErr.message);
        } else {
            insertedEvents = eventInsertRows || [];
        }

        if (causeEventId && insertedEvents.length) {
            const edgeRows = insertedEvents
                .map((row) => ({
                    cause_event_id: causeEventId,
                    effect_event_id: row.event_id,
                    edge_type: 'npc_reflection'
                }));
            const { error: edgeErr } = await this.restRequest('event_edges', {
                method: 'POST',
                prefer: 'resolution=merge-duplicates,return=minimal',
                body: edgeRows
            });
            if (edgeErr) {
                console.error('runNpcReflections insert event_edges failed:', edgeErr.message);
            }
        }

        const reflectionEventByEntityId = new Map();
        for (const row of insertedEvents) {
            const entityId = row?.payload?.reflection_entity_id;
            if (entityId) reflectionEventByEntityId.set(entityId, row.event_id);
        }
        const finalizedMemoryRows = reflectionMemoryRows.map((row) => ({
            ...row,
            source_event_id: reflectionEventByEntityId.get(row.metadata.reflection_entity_id) || causeEventId || null
        }));

        let insertedMemoryRows = [];
        const { data: memoryInsertRows, error: reflectionMemoryErr } = await this.restRequest('memory_items', {
            method: 'POST',
            query: { select: 'memory_id' },
            prefer: 'return=representation',
            body: finalizedMemoryRows
        });
        if (reflectionMemoryErr) {
            console.error('runNpcReflections insert memory failed:', reflectionMemoryErr.message);
        } else {
            insertedMemoryRows = memoryInsertRows || [];
        }

        for (const row of insertedMemoryRows) {
            if (row?.memory_id) {
                await this.enqueueEmbeddingJob(sid, row.memory_id, 'pending', null, 0);
            }
        }

        return {
            evaluated: candidateIds.length,
            reflected: stateUpsertRows.length,
            generatedEvents: insertedEvents.length,
            generatedMemories: insertedMemoryRows.length,
            threshold: reflectionThreshold,
            npcNames: reflectedNames.slice(0, 8)
        };
    }

    async recordTurn(sessionId, currentState, playerAction, nextState, options = {}) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !playerAction || !nextState) return;

        const hasSession = await this.ensureSession(sid);
        if (!hasSession) return;

        const mentionContext = await this.resolveMentionEntities(
            sid,
            Array.isArray(options?.mentions) ? options.mentions : [],
            playerAction
        );
        const mentionEntityIds = mentionContext.entities.map(e => e.entity_id).filter(Boolean);

        const candidates = this.extractEntityCandidates(currentState, nextState);
        const entityMap = await this.upsertEntities(sid, candidates);

        const { data: lastTurnRows } = await this.restRequest('turns', {
            query: {
                select: 'turn_no',
                session_id: `eq.${sid}`,
                order: 'turn_no.desc',
                limit: 1
            }
        });
        const turnNo = (lastTurnRows?.[0]?.turn_no || 0) + 1;

        const { data: turnRows, error: turnErr } = await this.restRequest('turns', {
            method: 'POST',
            query: { select: 'turn_id' },
            prefer: 'return=representation',
            body: [{
                session_id: sid,
                turn_no: turnNo,
                player_action: String(playerAction),
                gm_description: nextState.description || null,
                current_state: currentState || {},
                next_state: nextState || {},
                mentions: mentionContext.resolvedMentions || mentionContext.labels || []
            }]
        });

        if (turnErr || !turnRows?.length) {
            console.error('recordTurn insert turn failed:', turnErr?.message || 'missing turn row');
            return;
        }

        const turnId = turnRows[0].turn_id;
        const importance = this.computeImportance(playerAction, currentState, nextState);
        const memoryType = this.inferMemoryType(playerAction, nextState);
        const pinned = this.inferPinned(importance, nextState);

        const actorEntityIds = [];
        const playerEntity = entityMap.get(this.keyFor('player', 'Player'));
        if (playerEntity?.entity_id) actorEntityIds.push(playerEntity.entity_id);
        for (const npc of nextState?.npcs || []) {
            const entity = entityMap.get(this.keyFor('npc', npc?.name));
            if (entity?.entity_id) actorEntityIds.push(entity.entity_id);
        }
        for (const mentionEntityId of mentionEntityIds) {
            actorEntityIds.push(mentionEntityId);
        }
        const uniqueActorEntityIds = Array.from(new Set(actorEntityIds)).slice(0, 64);

        const eventSummary = String(nextState.description || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 1200);

        const { data: eventRows, error: eventErr } = await this.restRequest('events', {
            method: 'POST',
            query: { select: 'event_id' },
            prefer: 'return=representation',
            body: [{
                session_id: sid,
                turn_id: turnId,
                event_type: memoryType,
                summary: eventSummary || String(playerAction).slice(0, 1200),
                importance,
                location_name: nextState?.location?.name || null,
                actor_entity_ids: uniqueActorEntityIds,
                payload: {
                    playerAction: String(playerAction),
                    ambience: nextState?.ambience || null,
                    xpAwarded: nextState?.xpAwarded || 0,
                    mentions: mentionContext.resolvedMentions || mentionContext.labels || []
                }
            }]
        });

        if (eventErr || !eventRows?.length) {
            console.error('recordTurn insert event failed:', eventErr?.message || 'missing event row');
            return;
        }
        const eventId = eventRows[0].event_id;

        const deferredTemplates = this.buildDeferredConsequenceTemplates(playerAction, nextState, importance);
        if (deferredTemplates.length) {
            await this.scheduleDeferredConsequences(
                sid,
                eventId,
                turnId,
                turnNo,
                uniqueActorEntityIds,
                nextState?.location?.name || null,
                deferredTemplates
            );
        }

        const extractedPatches = require('./statePatchExtractor').extract({
            turnId,
            turnNo,
            currentState,
            nextState,
            entityMap,
            causeEventId: eventId
        });

        let stateUpdaterMode = 'rpc_v1';
        let stateUpdaterResult = null;
        const applyResult = await this.applyStatePatchesTransactional(
            sid,
            turnId,
            turnNo,
            eventId,
            nextState?.location?.name || null,
            extractedPatches
        );

        if (!applyResult.applied) {
            stateUpdaterMode = 'legacy_fallback';
            console.error('applyStatePatchesTransactional failed, fallback to legacy upserts:', applyResult.error);

            await this.upsertEntityState(sid, nextState, turnId, entityMap);
            await this.upsertNpcRelations(sid, nextState, entityMap, eventId);
            await this.upsertQuestState(sid, nextState?.quests || []);

            const fallbackEventRows = (extractedPatches?.event_patches || [])
                .filter((p) => p?.event_type && p?.summary)
                .map((p) => ({
                    session_id: sid,
                    turn_id: turnId,
                    event_type: p.event_type,
                    summary: String(p.summary).slice(0, 1200),
                    importance: Math.max(0, Math.min(1, Number(p.importance || 0.4))),
                    location_name: p.location_name || nextState?.location?.name || null,
                    actor_entity_ids: Array.isArray(p.actor_entity_ids)
                        ? p.actor_entity_ids.slice(0, 64)
                        : uniqueActorEntityIds,
                    payload: this.toPlainObject(p.payload),
                    caused_by_event_id: eventId
                }));

            if (fallbackEventRows.length) {
                const { error: fallbackEventErr } = await this.restRequest('events', {
                    method: 'POST',
                    prefer: 'return=minimal',
                    body: fallbackEventRows
                });
                if (fallbackEventErr) {
                    console.error('legacy_fallback event patch insert failed:', fallbackEventErr.message);
                }
            }
        } else {
            stateUpdaterResult = applyResult.result;
        }

        let reflectionResult = { evaluated: 0, reflected: 0, generatedEvents: 0, generatedMemories: 0, threshold: this.getNpcReflectionFrequency() };
        try {
            reflectionResult = await this.runNpcReflections(sid, {
                turnId,
                turnNo,
                causeEventId: eventId,
                locationName: nextState?.location?.name || null,
                nextState,
                entityMap,
                mentionEntities: mentionContext.entities || []
            });
        } catch (reflectionErr) {
            console.error('runNpcReflections failed:', reflectionErr?.message || reflectionErr);
        }

        const memoryText = `Player action: ${String(playerAction).trim()}\nOutcome: ${nextState.description || ''}`.trim();
        const memoryEntityIds = [];
        for (const [, entity] of entityMap.entries()) {
            if (entity?.entity_id) memoryEntityIds.push(entity.entity_id);
        }
        for (const mentionEntityId of mentionEntityIds) {
            memoryEntityIds.push(mentionEntityId);
        }
        const uniqueMemoryEntityIds = Array.from(new Set(memoryEntityIds));

        const { data: memoryRows, error: memoryErr } = await this.restRequest('memory_items', {
            method: 'POST',
            query: { select: 'memory_id' },
            prefer: 'return=representation',
            body: [{
                session_id: sid,
                turn_id: turnId,
                source_event_id: eventId,
                text_content: memoryText,
                entity_ids: uniqueMemoryEntityIds.slice(0, 32),
                location_name: nextState?.location?.name || null,
                memory_type: memoryType,
                importance,
                pinned,
                metadata: {
                    turnNo,
                    mentions: mentionContext.resolvedMentions || mentionContext.labels || []
                }
            }]
        });

        if (memoryErr || !memoryRows?.length) {
            console.error('recordTurn insert memory failed:', memoryErr?.message || 'missing memory row');
        } else {
            const memoryId = memoryRows[0].memory_id;
            await this.enqueueEmbeddingJob(sid, memoryId, 'pending', null, 0);

            if (this.canEmbed()) {
                const embedding = await this.generateEmbedding(memoryText);
                if (embedding) {
                    const vector = this.toVectorLiteral(embedding);
                    const { error: embErr } = await this.restRequest('memory_items', {
                        method: 'PATCH',
                        query: { memory_id: `eq.${memoryId}` },
                        body: { embedding: vector }
                    });

                    if (!embErr) {
                        await this.restRequest('embedding_jobs', {
                            method: 'PATCH',
                            query: { memory_id: `eq.${memoryId}` },
                            body: { status: 'completed', last_error: null }
                        });
                    } else {
                        await this.enqueueEmbeddingJob(sid, memoryId, 'failed', embErr.message, 1);
                    }
                }
            }
        }

        let graphJobsResult = { enqueued: 0, processed: 0, completed: 0, failed: 0 };
        if (this.isGraphRagEnabled()) {
            try {
                const enqueueResult = await this.enqueueGraphJobsForTurn(sid, {
                    turnId,
                    turnNo,
                    playerAction: String(playerAction),
                    mentions: mentionContext.resolvedMentions || mentionContext.labels || [],
                    mentionEntityIds,
                    locationName: nextState?.location?.name || null
                });
                const processedResult = await this.processPendingGraphJobs(sid);
                graphJobsResult = {
                    enqueued: Number(enqueueResult?.enqueued || 0),
                    refreshed: Number(enqueueResult?.refreshed || 0),
                    processed: Number(processedResult?.processed || 0),
                    completed: Number(processedResult?.completed || 0),
                    failed: Number(processedResult?.failed || 0),
                    skipped: Number(processedResult?.skipped || 0)
                };
            } catch (graphJobErr) {
                this.setGraphRagError(graphJobErr?.message || String(graphJobErr));
                console.error('recordTurn graph jobs failed:', graphJobErr?.message || graphJobErr);
            }
        }

        const artifactsBase = this.toPlainObject(options?.turnArtifacts);
        const artifactsMetadata = this.toPlainObject(artifactsBase.metadata);
        const enrichedArtifacts = {
            ...artifactsBase,
            metadata: {
                ...artifactsMetadata,
                state_updater: {
                    mode: stateUpdaterMode,
                    patch_counts: {
                        state: (extractedPatches?.state_patches || []).length,
                        relations: (extractedPatches?.relation_patches || []).length,
                        quests: (extractedPatches?.quest_patches || []).length,
                        events: (extractedPatches?.event_patches || []).length
                    },
                    result: stateUpdaterResult
                },
                npc_reflection: {
                    ...reflectionResult
                },
                graph_jobs: {
                    ...graphJobsResult
                }
            }
        };

        await this.saveTurnArtifacts(sid, turnId, enrichedArtifacts);
        await this.processPendingEmbeddingJobs(sid, 2);
    }

    async saveTurnArtifacts(sessionId, turnId, artifacts) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid || !turnId || !artifacts || typeof artifacts !== 'object') return;

        const payload = this.toPlainObject(artifacts);
        if (!Object.keys(payload).length) return;
        const memoryIds = Array.isArray(payload.memoryIds)
            ? payload.memoryIds
                .map((x) => Number(x))
                .filter((x) => Number.isInteger(x) && x > 0)
                .slice(0, 128)
            : [];

        const { error } = await this.restRequest('turn_artifacts', {
            method: 'POST',
            prefer: 'return=minimal',
            body: [{
                session_id: sid,
                turn_id: turnId,
                context_mode: payload.mode || null,
                retrieval_count: Number(payload.retrievalCount || 0),
                memory_ids: memoryIds,
                retrieval_sources: this.toPlainObject(payload.retrievalSources),
                section_budgets: this.toPlainObject(payload.sectionBudgets),
                latency_ms: Number(payload.latencyMs || 0),
                metadata: this.toPlainObject(payload.metadata)
            }]
        });
        if (error) {
            // table may not exist yet; keep runtime resilient
            if (!String(error.message || '').toLowerCase().includes('turn_artifacts')) {
                console.error('saveTurnArtifacts failed:', error.message);
            }
        }
    }

    async getContextMemories(sessionId, queryText, matchCount = 8, mentions = []) {
        const bundle = await this.getContextBundle(sessionId, queryText, matchCount, mentions);
        return bundle.memories || [];
    }

    async clearSession(sessionId) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return;

        const { error } = await this.restRequest('game_sessions', {
            method: 'DELETE',
            query: { session_id: `eq.${sid}` }
        });
        if (error) console.error('clearSession failed:', error.message);
    }

    // List sessions with a summary of their latest turn for the session browser.
    async listSessions(limit = 50) {
        const { data: sessions, error } = await this.restRequest('game_sessions', {
            query: {
                select: 'session_id,metadata,created_at',
                order: 'created_at.desc',
                limit
            }
        });
        if (error) {
            return { sessions: null, error };
        }

        const summaries = await Promise.all((sessions || []).map(async (session) => {
            const { data: turnRows } = await this.restRequest('turns', {
                query: {
                    select: 'turn_no,created_at,current_state,next_state',
                    session_id: `eq.${session.session_id}`,
                    order: 'turn_no.desc',
                    limit: 1
                }
            });
            const lastTurn = turnRows?.[0] || null;
            const nextState = lastTurn?.next_state || {};
            const currentState = lastTurn?.current_state || {};
            const player = { ...(currentState.player || {}), ...(nextState.player || {}) };
            return {
                sessionId: session.session_id,
                name: session.metadata?.name || null,
                createdAt: session.created_at,
                lastPlayedAt: lastTurn?.created_at || session.created_at,
                turnCount: lastTurn?.turn_no || 0,
                location: nextState?.location?.name || currentState?.location?.name || null,
                level: Number(player.level) || null,
                hp: typeof player.hp === 'string' ? player.hp : null,
                isDead: player.isDead === true
            };
        }));

        summaries.sort((a, b) => String(b.lastPlayedAt || '').localeCompare(String(a.lastPlayedAt || '')));
        return { sessions: summaries, error: null };
    }

    // Full snapshot for restoring a session on another device: the turn log
    // for story rebuild plus the latest turn's state pair for state merge.
    async getSessionSnapshot(sessionId) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return { snapshot: null, error: { message: 'invalid session id' } };

        const [{ data: turns, error: turnsError }, { data: lastRows, error: lastError }] = await Promise.all([
            this.restRequest('turns', {
                query: {
                    select: 'turn_no,player_action,gm_description',
                    session_id: `eq.${sid}`,
                    order: 'turn_no.asc',
                    limit: 2000
                }
            }),
            this.restRequest('turns', {
                query: {
                    select: 'turn_no,current_state,next_state',
                    session_id: `eq.${sid}`,
                    order: 'turn_no.desc',
                    limit: 1
                }
            })
        ]);

        if (turnsError || lastError) {
            return { snapshot: null, error: turnsError || lastError };
        }
        if (!lastRows?.length) {
            return { snapshot: null, error: { message: 'session has no recorded turns' } };
        }

        return {
            snapshot: {
                sessionId: sid,
                turns: turns || [],
                lastTurn: {
                    turnNo: lastRows[0].turn_no,
                    currentState: lastRows[0].current_state || {},
                    nextState: lastRows[0].next_state || {}
                }
            },
            error: null
        };
    }

    async renameSession(sessionId, name) {
        const sid = this.normalizeSessionId(sessionId);
        if (!sid) return { error: { message: 'invalid session id' } };

        const { data: rows, error: readError } = await this.restRequest('game_sessions', {
            query: { select: 'metadata', session_id: `eq.${sid}` }
        });
        if (readError) return { error: readError };
        if (!rows?.length) return { error: { message: 'session not found' } };

        const metadata = { ...(rows[0].metadata || {}), name: String(name || '').trim() || null };
        const { error } = await this.restRequest('game_sessions', {
            method: 'PATCH',
            query: { session_id: `eq.${sid}` },
            prefer: 'return=minimal',
            body: { metadata, updated_at: new Date().toISOString() }
        });
        return { error };
    }

    async tableCount(tableName) {
        const { count, error } = await this.restRequest(tableName, {
            method: 'HEAD',
            query: { select: '*' },
            prefer: 'count=exact'
        });
        if (error) return 0;
        return count;
    }

    async getStats() {
        if (!this.enabled) {
            return {
                enabled: false,
                initialized: this.initialized,
                lastInitError: this.lastInitError
            };
        }

        const [memoryItems, events, graphNodes, graphEdges, graphRagState] = await Promise.all([
            this.tableCount('memory_items'),
            this.tableCount('events'),
            this.tableCount('graph_nodes'),
            this.tableCount('graph_edges'),
            this.getGraphRagState()
        ]);

        const { data: jobs } = await this.restRequest('embedding_jobs', {
            query: { select: 'status', limit: 1000 }
        });

        const embeddingJobs = (jobs || []).reduce((acc, row) => {
            const status = row.status || 'unknown';
            acc[status] = (acc[status] || 0) + 1;
            return acc;
        }, {});

        return {
            enabled: true,
            initialized: this.initialized,
            memoryItems,
            events,
            embeddingJobs,
            graph: {
                ...graphRagState,
                nodes: graphNodes,
                edges: graphEdges
            }
        };
    }
}

module.exports = new SupabaseWorldService();

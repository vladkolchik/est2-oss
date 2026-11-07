const supabaseWorldService = require('./supabaseWorldService');

class ContextBuilder {
    constructor() {
        this.staticContextCache = new Map();
        this.staticCacheTtlMs = Number(process.env.CONTEXT_STATIC_CACHE_TTL_MS || 30000);
    }

    detectMode(playerAction, currentState) {
        const text = String(playerAction || '').toLowerCase();
        if (/\b(attack|shoot|fight|combat|ambush|grenade)\b/.test(text)) return 'combat';
        if (/\b(craft|repair|rest|sleep|camp|wait)\b/.test(text)) return 'downtime';
        if (/\b(update|set|change|apply|state)\b/.test(text) || /\[dev command\]/.test(text)) return 'state_update';
        if (Array.isArray(currentState?.npcs) && currentState.npcs.some((n) => String(n?.status || '').toLowerCase().includes('hostile'))) {
            return 'combat';
        }
        return 'narration';
    }

    normalizeEntityKey(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[^a-z0-9\-_' ]/g, '');
    }

    uniqueStrings(values = [], cap = 24) {
        const out = [];
        const seen = new Set();
        for (const raw of values || []) {
            const value = String(raw || '').trim();
            if (!value) continue;
            const key = this.normalizeEntityKey(value);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(value);
            if (out.length >= cap) break;
        }
        return out;
    }

    inferMentionsFromAction(currentState, playerAction, explicitMentions = []) {
        const text = String(playerAction || '');
        const actionKey = this.normalizeEntityKey(text);
        if (!actionKey) return this.uniqueStrings(explicitMentions, 12);

        const candidates = [];
        candidates.push(...(Array.isArray(explicitMentions) ? explicitMentions : []));
        if (currentState?.location?.name) candidates.push(currentState.location.name);
        for (const npc of currentState?.npcs || []) {
            if (npc?.name && actionKey.includes(this.normalizeEntityKey(npc.name))) candidates.push(npc.name);
        }
        for (const quest of currentState?.quests || []) {
            if (quest?.name && actionKey.includes(this.normalizeEntityKey(quest.name))) candidates.push(quest.name);
        }
        for (const item of currentState?.player?.inventory || []) {
            if (item?.name && actionKey.includes(this.normalizeEntityKey(item.name))) candidates.push(item.name);
        }
        return this.uniqueStrings(candidates, 12);
    }

    recencyBoost(createdAtIso) {
        if (!createdAtIso) return 0;
        const ts = Date.parse(createdAtIso);
        if (!Number.isFinite(ts) || ts <= 0) return 0;
        const ageHours = Math.max(0, (Date.now() - ts) / 3600000);
        if (ageHours <= 4) return 0.25;
        if (ageHours <= 24) return 0.15;
        if (ageHours <= 72) return 0.08;
        return 0.02;
    }

    fuseMemories({ memoryRows = [], mentionMemories = [], mentionLabels = [], questFacts = [] }) {
        const mentionKeys = new Set(this.uniqueStrings(mentionLabels, 24).map((m) => this.normalizeEntityKey(m)));
        const questKeys = questFacts
            .map((line) => String(line || '').split(':')[0].trim())
            .filter(Boolean)
            .map((q) => this.normalizeEntityKey(q));

        const merged = new Map();
        const ingest = (text, scoreBase, source, extra = {}) => {
            const raw = String(text || '').replace(/\s+/g, ' ').trim();
            if (!raw) return;
            const key = this.normalizeEntityKey(raw);
            if (!key) return;

            const candidate = merged.get(key) || {
                text: raw,
                score: 0,
                sources: new Set(),
                memoryId: null
            };

            let score = scoreBase;
            const textKey = this.normalizeEntityKey(raw);
            for (const mk of mentionKeys) {
                if (mk && textKey.includes(mk)) {
                    score += 0.18;
                    break;
                }
            }
            for (const qk of questKeys) {
                if (qk && textKey.includes(qk)) {
                    score += 0.12;
                    break;
                }
            }
            if (extra.pinned) score += 0.2;
            if (Number.isFinite(extra.importance)) score += Number(extra.importance) * 0.32;
            if (extra.createdAt) score += this.recencyBoost(extra.createdAt);

            candidate.score = Math.max(candidate.score, score);
            candidate.sources.add(source);
            if (!candidate.memoryId && extra.memoryId) candidate.memoryId = extra.memoryId;
            merged.set(key, candidate);
        };

        for (const row of memoryRows || []) {
            ingest(row?.text_content, Number(row?.score || 0.1), 'world_hybrid', {
                memoryId: row?.memory_id || null,
                importance: Number(row?.importance || 0),
                pinned: !!row?.pinned,
                createdAt: row?.created_at || null
            });
        }
        for (const text of mentionMemories || []) ingest(text, 0.7, 'mention_memory');

        return Array.from(merged.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, 14);
    }

    trimSection(lines, maxItems, maxChars) {
        const out = [];
        let used = 0;
        for (const line of lines || []) {
            const value = String(line || '').trim();
            if (!value) continue;
            const next = used + value.length + 3;
            if (out.length >= maxItems || next > maxChars) break;
            out.push(value);
            used = next;
        }
        return out;
    }

    getStaticCache(cacheKey) {
        const hit = this.staticContextCache.get(cacheKey);
        if (!hit) return null;
        if (Date.now() > hit.expiresAt) {
            this.staticContextCache.delete(cacheKey);
            return null;
        }
        return hit.value;
    }

    setStaticCache(cacheKey, value) {
        this.staticContextCache.set(cacheKey, {
            expiresAt: Date.now() + this.staticCacheTtlMs,
            value
        });
    }

    async buildContext({ sessionId, currentState, playerAction, mentions = [] }) {
        const startedAt = Date.now();
        const mode = this.detectMode(playerAction, currentState);
        const inferredMentions = this.inferMentionsFromAction(currentState, playerAction, mentions);

        let mentionLabels = inferredMentions;
        let mentionEntityIds = [];
        let mentionDossiers = [];
        let deterministic = { questFacts: [], relationFacts: [], stateFacts: [], recentEvents: [], recentTurns: [] };
        let memoryRows = [];
        let mentionMemories = [];
        let dueConsequences = [];
        let currentTurnNo = 0;
        let usedStaticCache = false;
        let graphLines = [];
        let graphRagMeta = {
            eligible: false,
            used: false,
            latency_ms: 0,
            cache_hit: false,
            subgraph_nodes: 0,
            subgraph_edges: 0,
            scopes: [],
            fallback_reason: supabaseWorldService.isGraphRagEnabled() ? 'not_complex' : 'disabled',
            timed_out: false
        };

        if (supabaseWorldService.enabled) {
            const mentionContext = await supabaseWorldService.resolveMentionEntities(sessionId, inferredMentions, playerAction);
            mentionLabels = this.uniqueStrings(mentionContext.resolvedMentions.length ? mentionContext.resolvedMentions : mentionContext.labels, 12);
            mentionEntityIds = (mentionContext.entities || []).map((e) => e.entity_id).filter(Boolean);
            const locationKey = this.normalizeEntityKey(currentState?.location?.name || '');
            const cacheKey = `${sessionId}|${locationKey}|${mentionEntityIds.slice().sort().join(',')}`;
            const cacheHit = this.getStaticCache(cacheKey);

            const staticPromise = cacheHit
                ? Promise.resolve(cacheHit)
                : Promise.all([
                    supabaseWorldService.getMentionDossiers(sessionId, mentionContext.entities || []),
                    supabaseWorldService.getDeterministicContext(sessionId, mentionEntityIds, currentState?.location?.name || null)
                ]).then(([dossiers, deterministicCtx]) => {
                    const payload = {
                        mentionDossiers: dossiers || [],
                        deterministic: deterministicCtx || { questFacts: [], relationFacts: [], stateFacts: [], recentEvents: [], recentTurns: [] }
                    };
                    this.setStaticCache(cacheKey, payload);
                    return payload;
                });

            const [staticCtx, hybridRows, mentionMemoryRows, turnNo] = await Promise.all([
                staticPromise,
                supabaseWorldService.fetchHybridMemoryRows(sessionId, playerAction, 10),
                supabaseWorldService.getMentionMemoryTexts(sessionId, mentionEntityIds, Math.max(4, mentionEntityIds.length * 2)),
                supabaseWorldService.getLatestTurnNo(sessionId)
            ]);

            mentionDossiers = staticCtx.mentionDossiers || [];
            deterministic = staticCtx.deterministic || deterministic;
            usedStaticCache = !!cacheHit;
            memoryRows = hybridRows || [];
            mentionMemories = mentionMemoryRows || [];
            currentTurnNo = Number(turnNo || 0);

            dueConsequences = await supabaseWorldService.getDueConsequences(
                sessionId,
                currentTurnNo,
                currentState?.location?.name || null,
                mentionEntityIds
            );

            const graphEnabled = supabaseWorldService.isGraphRagEnabled();
            const graphComplexOnly = supabaseWorldService.isGraphRagComplexOnly();
            const graphDetection = supabaseWorldService.detectComplexQuery({
                playerAction,
                mentions: mentionLabels,
                currentTurnNo,
                mode
            });
            const graphEligible = graphEnabled && (!graphComplexOnly || graphDetection.complex);
            graphRagMeta = {
                ...graphRagMeta,
                eligible: graphEligible,
                fallback_reason: graphEnabled ? 'not_complex' : 'disabled'
            };

            if (graphEligible) {
                const graphStartedAt = Date.now();
                const graphTimeoutMs = supabaseWorldService.getGraphRagTimeoutMs();
                const timeoutPromise = new Promise((resolve) => setTimeout(
                    () => resolve({ timedOut: true }),
                    graphTimeoutMs
                ));
                const graphPromise = supabaseWorldService.getGraphRagContext({
                    sessionId,
                    playerAction,
                    mentions: mentionLabels,
                    mentionEntityIds,
                    locationName: currentState?.location?.name || null,
                    currentTurnNo,
                    mode
                })
                    .then((payload) => ({ timedOut: false, payload }))
                    .catch((error) => ({ timedOut: false, error }));

                const graphResult = await Promise.race([graphPromise, timeoutPromise]);
                graphRagMeta.latency_ms = Date.now() - graphStartedAt;

                if (graphResult?.timedOut) {
                    graphRagMeta.timed_out = true;
                    graphRagMeta.fallback_reason = 'timeout';
                } else if (graphResult?.error) {
                    graphRagMeta.fallback_reason = 'error';
                } else {
                    const payload = graphResult?.payload || {};
                    graphLines = this.trimSection(
                        Array.isArray(payload.lines) ? payload.lines : [],
                        6,
                        1800
                    );
                    graphRagMeta.used = !!payload.used && graphLines.length > 0;
                    graphRagMeta.cache_hit = !!payload.cacheHit;
                    graphRagMeta.subgraph_nodes = Number(payload.subgraphNodes || 0);
                    graphRagMeta.subgraph_edges = Number(payload.subgraphEdges || 0);
                    graphRagMeta.scopes = Array.isArray(payload.scopes) ? payload.scopes.slice(0, 8) : [];
                    graphRagMeta.fallback_reason = payload.fallbackReason || (graphRagMeta.used ? null : 'no_graph_data');
                }
            }
        }

        const fusedMemories = this.fuseMemories({
            memoryRows,
            mentionMemories,
            mentionLabels,
            questFacts: deterministic.questFacts || []
        });

        const sectionBudgets = {
            mentions: { maxItems: 10, maxChars: 600 },
            dossiers: { maxItems: 8, maxChars: 2200 },
            deterministic: { maxItems: 16, maxChars: 2600 },
            consequences: { maxItems: 4, maxChars: 900 },
            graph: { maxItems: 6, maxChars: 1800 },
            memories: { maxItems: 12, maxChars: 3000 },
            recentTurns: { maxItems: 4, maxChars: 900 }
        };

        const mentionLines = this.trimSection(mentionLabels, sectionBudgets.mentions.maxItems, sectionBudgets.mentions.maxChars);
        const dossierLines = this.trimSection(mentionDossiers, sectionBudgets.dossiers.maxItems, sectionBudgets.dossiers.maxChars);
        const deterministicLines = this.trimSection([
            ...(deterministic.questFacts || []).map((x) => `[quest] ${x}`),
            ...(deterministic.relationFacts || []).map((x) => `[relation] ${x}`),
            ...(deterministic.stateFacts || []).map((x) => `[state] ${x}`),
            ...(deterministic.recentEvents || []).map((x) => `[event] ${x}`)
        ], sectionBudgets.deterministic.maxItems, sectionBudgets.deterministic.maxChars);
        const consequenceLines = this.trimSection(dueConsequences, sectionBudgets.consequences.maxItems, sectionBudgets.consequences.maxChars);
        const memoryLines = this.trimSection(
            fusedMemories.map((m) => `${m.text} {score=${m.score.toFixed(3)} src=${Array.from(m.sources).join('+')}}`),
            sectionBudgets.memories.maxItems,
            sectionBudgets.memories.maxChars
        );
        const recentTurnLines = this.trimSection(deterministic.recentTurns || [], sectionBudgets.recentTurns.maxItems, sectionBudgets.recentTurns.maxChars);

        const sections = [];
        sections.push(`CONTEXT MODE: ${mode}`);
        if (mentionLines.length) {
            sections.push(`PLAYER MENTIONS (MUST PRIORITIZE):\n- ${mentionLines.join('\n- ')}`);
        }
        if (dossierLines.length) {
            sections.push(`MENTIONED ENTITY DOSSIERS:\n- ${dossierLines.join('\n- ')}`);
            if (dossierLines.some((line) => /behavior:|reflection:|primary_goal:/i.test(line))) {
                sections.push('NPC BEHAVIOR DIRECTIVES:\n- Preserve continuity for mentioned NPCs: follow stored behavior (tone/risk/generosity), reflection trust signals, and primary goals when choosing reactions/dialogue.');
            }
        }
        if (deterministicLines.length) {
            sections.push(`DETERMINISTIC WORLD FACTS:\n- ${deterministicLines.join('\n- ')}`);
        }
        if (consequenceLines.length) {
            sections.push(`DUE CONSEQUENCES (pending world developments):\n- ${consequenceLines.join('\n- ')}\nSurface a consequence in the narration ONLY if it is plausible in the current scene and location. NPCs obey travel logic: someone last seen far away, tied to their post, or physically unable to travel cannot suddenly show up here. If an appearance does not make sense right now, foreshadow it instead (tracks, radio chatter, a rumor) or silently ignore it.`);
        }
        if (graphLines.length) {
            sections.push(`GRAPH RAG CONTEXT:\n- ${graphLines.join('\n- ')}`);
        }
        if (memoryLines.length) {
            sections.push(`RANKED MEMORY RETRIEVAL:\n- ${memoryLines.join('\n- ')}`);
        }
        if (recentTurnLines.length) {
            sections.push(`RECENT TURN THREAD:\n- ${recentTurnLines.join('\n- ')}`);
        }

        const latencyMs = Date.now() - startedAt;
        const memoryIds = fusedMemories.map((m) => m.memoryId).filter(Boolean);
        const retrievalSources = fusedMemories.reduce((acc, m) => {
            for (const src of m.sources) acc[src] = (acc[src] || 0) + 1;
            return acc;
        }, {});
        if (graphRagMeta.used) {
            retrievalSources.graph_rag = graphLines.length;
        }

        return {
            mode,
            promptContext: sections.join('\n\n'),
            artifacts: {
                mode,
                latencyMs,
                retrievalCount: fusedMemories.length + (graphRagMeta.used ? graphLines.length : 0),
                memoryIds: memoryIds.slice(0, 30),
                retrievalSources,
                sectionBudgets,
                metadata: {
                    usedStaticCache,
                    mentionCount: mentionLines.length,
                    dueConsequences: consequenceLines.length,
                    currentTurnNo,
                    graph_rag: graphRagMeta
                }
            }
        };
    }
}

module.exports = new ContextBuilder();

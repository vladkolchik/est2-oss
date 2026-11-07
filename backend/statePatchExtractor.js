class StatePatchExtractor {
    normalizeEntityKey(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[^a-z0-9\-_' ]/g, '');
    }

    keyFor(entityType, name) {
        return `${entityType}:${this.normalizeEntityKey(name)}`;
    }

    toPlainObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    clamp(value, min, max, fallback = 0) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    relationWeightFromStatus(statusLabel) {
        const status = String(statusLabel || '').toLowerCase();
        if (status.includes('friendly')) return 0.7;
        if (status.includes('hostile')) return -0.85;
        if (status.includes('wary')) return -0.25;
        return 0;
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

    inferNpcPersona(statusLabel, dialogueLines = []) {
        const status = String(statusLabel || '').trim() || 'Unknown';
        const lines = Array.isArray(dialogueLines) ? dialogueLines.filter(Boolean) : [];
        const corpus = `${status} ${lines.join(' ')}`.toLowerCase();

        let trait = 'cautious';
        if (/\b(hostile|threat|kill|shoot|ambush|attack)\b/.test(corpus)) trait = 'aggressive';
        else if (/\b(friend|friendly|trust|help|thanks|grateful)\b/.test(corpus)) trait = 'cooperative';
        else if (/\b(trade|caps|deal|price|barter)\b/.test(corpus)) trait = 'pragmatic';
        else if (/\b(scared|fear|worry|panic)\b/.test(corpus)) trait = 'anxious';

        const parts = [
            `${trait} wastelander`,
            `disposition: ${status}`
        ];
        if (lines[0]) {
            parts.push(`recent voice: "${lines[0].slice(0, 120)}"`);
        }
        return parts.join('; ');
    }

    inferNpcGoals(npcName, quests = []) {
        const npcKey = this.normalizeEntityKey(npcName);
        if (!npcKey) return [];

        const goals = [];
        for (const quest of quests || []) {
            if (!quest?.name || String(quest.status || 'active') !== 'active') continue;
            for (const objective of quest?.objectives || []) {
                const text = String(objective?.description || '').trim();
                if (!text) continue;
                if (this.normalizeEntityKey(text).includes(npcKey)) {
                    goals.push(`${quest.name}: ${text.slice(0, 120)}`);
                }
            }
            const description = String(quest.description || '').trim();
            if (description && this.normalizeEntityKey(description).includes(npcKey)) {
                goals.push(`${quest.name}: ${description.slice(0, 120)}`);
            }
        }

        return Array.from(new Set(goals)).slice(0, 4);
    }

    fallbackGoalFromStatus(statusLabel) {
        const status = String(statusLabel || '').toLowerCase();
        if (status.includes('hostile')) return 'neutralize threats near territory';
        if (status.includes('friendly')) return 'maintain alliance with the player';
        if (status.includes('wary')) return 'verify whether the player can be trusted';
        return 'survive and gather useful information';
    }

    buildGoalSystem(npcName, goals = [], statusLabel = 'Unknown') {
        const normalizedGoals = Array.from(new Set((Array.isArray(goals) ? goals : []).map((g) => String(g || '').trim()).filter(Boolean))).slice(0, 4);
        const primary = normalizedGoals[0] || this.fallbackGoalFromStatus(statusLabel);
        const secondary = normalizedGoals.slice(1, 3);
        return {
            actor: String(npcName || '').trim() || 'unknown_npc',
            primary,
            secondary,
            pressure: secondary.length ? 'medium' : 'low'
        };
    }

    inferNpcBehavior(statusLabel, relationWeight = 0, goalSystem = null) {
        const status = String(statusLabel || '').toLowerCase();
        const relation = this.clamp(relationWeight, -1, 1, 0);

        let tone = 'neutral';
        if (relation >= 0.45 || status.includes('friendly')) tone = 'warm';
        else if (relation <= -0.45 || status.includes('hostile')) tone = 'threatening';
        else if (status.includes('wary')) tone = 'guarded';

        let risk = 'measured';
        if (status.includes('hostile')) risk = 'bold';
        else if (status.includes('wary') || status.includes('scared') || status.includes('fear')) risk = 'cautious';

        let generosity = 'medium';
        if (relation >= 0.55) generosity = 'high';
        else if (relation <= -0.35) generosity = 'low';

        return {
            tone,
            risk,
            generosity,
            relation_to_player: Number(relation.toFixed(3)),
            current_focus: goalSystem?.primary || null
        };
    }

    buildNpcStatusMap(state) {
        const map = new Map();
        for (const npc of state?.npcs || []) {
            const key = this.normalizeEntityKey(npc?.name);
            if (!key) continue;
            map.set(key, String(npc?.status || 'Unknown'));
        }
        return map;
    }

    extract({
        turnId,
        turnNo,
        currentState,
        nextState,
        entityMap,
        causeEventId
    }) {
        const statePatches = [];
        const relationPatches = [];
        const questPatches = [];
        const eventPatches = [];

        const nextLocationName = nextState?.location?.name || null;
        const dialogueMap = this.extractNpcDialogueMap(nextState?.description || '');
        const currentNpcStatusMap = this.buildNpcStatusMap(currentState);
        const playerEntity = entityMap.get(this.keyFor('player', 'Player'));

        for (const npc of nextState?.npcs || []) {
            const npcName = String(npc?.name || '').trim();
            if (!npcName) continue;

            const npcEntity = entityMap.get(this.keyFor('npc', npcName));
            if (!npcEntity?.entity_id) continue;

            const npcKey = this.normalizeEntityKey(npcName);
            const dialogueLines = dialogueMap.get(npcKey) || [];
            const status = String(npc?.status || 'Unknown');
            const relationWeight = this.relationWeightFromStatus(status);
            const inferredGoals = this.inferNpcGoals(npcName, nextState?.quests || []);
            const goalSystem = this.buildGoalSystem(npcName, inferredGoals, status);
            const behavior = this.inferNpcBehavior(status, relationWeight, goalSystem);

            statePatches.push({
                entity_id: npcEntity.entity_id,
                state_delta: {
                    status,
                    persona: this.inferNpcPersona(status, dialogueLines),
                    goals: inferredGoals,
                    goal_system: goalSystem,
                    behavior,
                    last_dialogue: dialogueLines[0] || null
                },
                relation_to_player: relationWeight,
                last_seen_turn: turnId,
                last_seen_location: nextLocationName,
                reason: 'extractor_turn_projection'
            });

            if (playerEntity?.entity_id) {
                relationPatches.push({
                    from_entity_id: npcEntity.entity_id,
                    to_entity_id: playerEntity.entity_id,
                    relation_type: 'attitude_to_player',
                    weight: relationWeight,
                    evidence_event_id: causeEventId || null,
                    metadata: {
                        status,
                        source: 'state_patch_extractor_v1'
                    }
                });
            }

            const previousStatus = currentNpcStatusMap.get(npcKey);
            if (previousStatus && previousStatus !== status) {
                const magnitude = Math.abs(relationWeight);
                const importance = this.clamp(0.25 + magnitude * 0.4, 0, 1, 0.3);
                const actorEntityIds = [npcEntity.entity_id];
                if (playerEntity?.entity_id) actorEntityIds.push(playerEntity.entity_id);

                eventPatches.push({
                    event_type: 'relationship_change',
                    summary: `${npcName} attitude changed from ${previousStatus} to ${status}.`,
                    importance,
                    location_name: nextLocationName,
                    actor_entity_ids: actorEntityIds,
                    payload: {
                        from_status: previousStatus,
                        to_status: status,
                        source: 'state_patch_extractor_v1'
                    }
                });
            }
        }

        if (nextState?.location?.name) {
            const locationEntity = entityMap.get(this.keyFor('location', nextState.location.name));
            if (locationEntity?.entity_id) {
                statePatches.push({
                    entity_id: locationEntity.entity_id,
                    state_delta: {
                        description: nextState.location.description || null,
                        coordinates: nextState.location.coordinates || null,
                        last_player_visit_turn_no: Number(turnNo || 0)
                    },
                    relation_to_player: 0,
                    last_seen_turn: turnId,
                    last_seen_location: nextState.location.name,
                    reason: 'extractor_location_projection'
                });
            }
        }

        for (const quest of nextState?.quests || []) {
            const questName = String(quest?.name || '').trim();
            if (!questName) continue;
            const status = String(quest?.status || 'active').toLowerCase();
            questPatches.push({
                quest_key: this.normalizeEntityKey(questName),
                quest_name: questName,
                status: ['active', 'completed', 'failed'].includes(status) ? status : 'active',
                objectives: Array.isArray(quest?.objectives) ? quest.objectives : [],
                metadata: {
                    description: quest?.description || null,
                    source: 'state_patch_extractor_v1'
                }
            });
        }

        return {
            schema_version: 1,
            extractor: 'deterministic_state_patch_v1',
            state_patches: statePatches,
            relation_patches: relationPatches,
            quest_patches: questPatches,
            event_patches: eventPatches,
            world_tick: {
                enabled: true,
                max_candidates: 8,
                max_encounters: 2,
                encounter_due_offset: 1,
                base_probability: 0.12,
                step_probability: 0.06,
                max_probability: 0.78
            }
        };
    }
}

module.exports = new StatePatchExtractor();

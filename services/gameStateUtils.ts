import type { GameState, StoryEntry } from '../types';

export interface NarrationSegment {
    type: 'narrative' | 'dialogue';
    text: string;
    gender?: 'male' | 'female' | 'unknown';
    speaker?: string;
}

const DIALOGUE_REGEX = /\[DIALOGUE\s+speaker=\"([^\"]+)\"\s+gender=\"(male|female|unknown)\"\](.*?)\[\/DIALOGUE\]/gis;
const PLAYER_SPEAKERS = new Set(['you', 'player', 'courier']);

// Split a GM description into story entries and a narration sequence,
// extracting [DIALOGUE ...]...[/DIALOGUE] blocks. Lines spoken as the player
// are dropped so the model never speaks on the player's behalf.
export function parseDescriptionEntries(raw: string): { entries: StoryEntry[]; sequence: NarrationSegment[] } {
    const entries: StoryEntry[] = [];
    const sequence: NarrationSegment[] = [];
    const regex = new RegExp(DIALOGUE_REGEX.source, DIALOGUE_REGEX.flags);
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(raw)) !== null) {
        const before = raw.slice(lastIndex, match.index).trim();
        if (before) {
            entries.push({ type: 'narrative', text: before });
            sequence.push({ type: 'narrative', text: before });
        }
        const speaker = match[1];
        const gender = match[2] as 'male' | 'female' | 'unknown';
        const spoken = match[3].trim();
        if (spoken && !PLAYER_SPEAKERS.has(speaker.toLowerCase())) {
            entries.push({ type: 'dialogue', speaker, gender, text: spoken });
            sequence.push({ type: 'dialogue', speaker, gender, text: spoken });
        }
        lastIndex = regex.lastIndex;
    }

    const after = raw.slice(lastIndex).trim();
    if (after) {
        entries.push({ type: 'narrative', text: after });
        sequence.push({ type: 'narrative', text: after });
    }

    return { entries, sequence };
}

// Merge a model update into the previous game state: applies inventoryChanges
// on top of the existing inventory, awards XP and handles level-ups. This is
// the single source of truth for state merging — used both for live turns and
// for restoring a cloud session from its last recorded turn.
export function applyGameUpdate(prev: GameState, update: Partial<GameState>): { state: GameState; leveledUp: boolean } {
    const newInventory = [...prev.player.inventory];

    update.inventoryChanges?.added?.forEach(newItem => {
        if (!newInventory.some(existingItem => existingItem.name === newItem.name)) {
            newInventory.push(newItem);
        }
    });

    update.inventoryChanges?.removed?.forEach(itemToRemoveName => {
        const index = newInventory.findIndex(item => item.name === itemToRemoveName);
        if (index > -1) {
            newInventory.splice(index, 1);
        }
    });

    const state: GameState = {
        ...prev,
        ...update,
        player: {
            ...prev.player,
            ...update.player,
            inventory: newInventory,
        },
        quests: update.quests || prev.quests,
        discoveredLocations: update.discoveredLocations || prev.discoveredLocations,
        suggestedActions: update.suggestedActions || [],
    };

    let leveledUp = false;
    if (update.xpAwarded && update.xpAwarded > 0) {
        state.player.xp += update.xpAwarded;
        while (state.player.xp >= state.player.xpToNextLevel) {
            leveledUp = true;
            state.player.level += 1;
            state.player.xp -= state.player.xpToNextLevel;
            state.player.xpToNextLevel = Math.floor(state.player.xpToNextLevel * 1.25);
            state.player.specialPoints += 1;
        }
    }

    return { state, leveledUp };
}

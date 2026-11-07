
export interface SPECIAL {
  strength: number;
  perception: number;
  endurance: number;
  charisma: number;
  intelligence: number;
  agility: number;
  luck: number;
}

export interface InventoryItem {
  name: string;
  description: string;
}

export interface Player {
  name?: string; // Chosen at character creation; absent for legacy saves and amnesiac starts
  background?: string; // Short backstory from character creation, kept in state so the GM always sees it
  hp: string; // e.g., "85/100"
  isDead: boolean;
  special: SPECIAL;
  inventory: InventoryItem[];
  statusEffects: string[];
  level: number;
  xp: number;
  xpToNextLevel: number;
  specialPoints: number; // Points to spend on S.P.E.C.I.A.L.
}

export interface PointOfInterest {
  name: string;
  coordinates: { x: number; y: number };
}

export interface Location {
  name: string;
  description: string;
  coordinates: { x: number; y: number };
}

export interface NPC {
    name: string;
    status: string; // e.g. "Hostile", "Friendly", "Wary"
}

export interface QuestObjective {
  description: string;
  isCompleted: boolean;
}

export interface Quest {
  name: string;
  description: string;
  objectives: QuestObjective[];
  status: 'active' | 'completed' | 'failed';
}

export interface GameState {
  description: string;
  player: Player;
  location: Location;
  npcs: NPC[];
  quests: Quest[];
  discoveredLocations: PointOfInterest[];
  inventoryChanges?: {
    added?: InventoryItem[];
    removed?: string[];
  };
  xpAwarded?: number; // XP gained from this turn
  ambience?: string; // e.g., 'desert_wind', 'tense_combat', 'shelter_calm'
  suggestedActions?: string[];
}

export type StoryEntry =
  | { type: 'narrative'; text: string }
  | { type: 'action'; text: string }
  | { type: 'error'; text: string }
  | { type: 'dialogue'; speaker: string; gender: 'male' | 'female' | 'unknown'; text: string };

import type { GameState } from './types';

export const GAME_TITLE = "WASTELAND CHRONICLES";

export const AMBIENT_SOUNDS = {
  main_menu: '/audio/main_menu.mp3',
  desert_wind: '/audio/desert_wind.mp3',
  tense_combat: '/audio/tense_combat.mp3',
  shelter_calm: '/audio/shelter_calm.mp3',
};

// Fallout.FM public OGG radio streams. See https://fallout.fm
export const RADIO_STREAMS = {
  // Fallout: New Vegas – Radio New Vegas
  new_vegas: 'https://fallout.fm:8444/falloutfm3.ogg',
  // Other available stations if we want to expose later
  main: 'https://fallout.fm:8444/falloutfm1.ogg',
  fallout1: 'https://fallout.fm:8444/falloutfm5.ogg',
  fallout2: 'https://fallout.fm:8444/falloutfm4.ogg',
  fo3_gnr: 'https://fallout.fm:8444/falloutfm2.ogg',
  fo4_dcr: 'https://fallout.fm:8444/falloutfm6.ogg',
  fo4_classical: 'https://fallout.fm:8444/falloutfm7.ogg',
  fo4_mwtcf: 'https://fallout.fm:8444/falloutfm8.ogg',
  fo76_general: 'https://fallout.fm:8444/falloutfm10.ogg',
  fo76_classical: 'https://fallout.fm:8444/falloutfm9.ogg',
} as const;

export const INITIAL_GAME_STATE: GameState = {
  description: "You awaken to the harsh glare of the Mojave sun. The taste of dust and blood is in your mouth. You have no memory of how you got here. A rusty Pip-Boy is strapped to your wrist, its screen dark.",
  player: {
    hp: "100/100",
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
      { name: "Ragged Wanderer Outfit", description: "Standard-issue vault dweller attire, but seen better days. Provides minimal protection." },
      { name: "Empty Nuka-Cola Bottle", description: "A classic glass bottle. Could be filled with water, or used as a makeshift weapon." }
    ],
    statusEffects: ["Amnesia"],
    level: 1,
    xp: 0,
    xpToNextLevel: 200,
    specialPoints: 0,
  },
  location: {
    name: "Unknown Desert",
    description: "An endless expanse of cracked earth and scorched sand stretches in every direction.",
    coordinates: { x: 0, y: 0 },
  },
  discoveredLocations: [
    { name: "Unknown Desert", coordinates: { x: 0, y: 0 } }
  ],
  npcs: [],
  quests: [],
  ambience: 'desert_wind',
  suggestedActions: [],
};

import type { SPECIAL, InventoryItem } from './types';

// Every preset (and any custom build) must spend exactly this many SPECIAL
// points — the classic 7 attributes x 5, matching the original fixed start.
export const SPECIAL_CREATION_BUDGET = 35;

export interface CharacterPreset {
  id: string;
  label: string;
  tagline: string;
  defaultName: string; // empty string = unnamed (amnesiac starts)
  special: SPECIAL;
  background: string;
  inventory: InventoryItem[];
  statusEffects: string[];
  openingHint: string; // instruction for the GM on what the starting quest should be about
}

// What the creation screen hands back to the game after the player confirms.
export interface CharacterProfile {
  name: string;
  special: SPECIAL;
  background: string;
  inventory: InventoryItem[];
  statusEffects: string[];
  openingHint: string;
}

export const CHARACTER_PRESETS: CharacterPreset[] = [
  {
    id: 'classic-wanderer',
    label: 'Lone Wanderer',
    tagline: 'The classic start. No name, no memory, no mercy.',
    defaultName: '',
    special: { strength: 5, perception: 5, endurance: 5, charisma: 5, intelligence: 5, agility: 5, luck: 5 },
    background: 'You awaken to the harsh glare of the Mojave sun with no memory of how you got here. The taste of dust and blood is in your mouth, and a rusty Pip-Boy is strapped to your wrist.',
    inventory: [
      { name: 'Ragged Wanderer Outfit', description: 'Standard-issue vault dweller attire, but seen better days. Provides minimal protection.' },
      { name: 'Empty Nuka-Cola Bottle', description: 'A classic glass bottle. Could be filled with water, or used as a makeshift weapon.' },
    ],
    statusEffects: ['Amnesia'],
    openingHint: 'create a starting quest to find out who they are',
  },
  {
    id: 'mojave-courier',
    label: 'Mojave Courier',
    tagline: 'The package is still sealed. The ambushers are still out there.',
    defaultName: 'Jess Harlan',
    special: { strength: 5, perception: 5, endurance: 6, charisma: 4, intelligence: 5, agility: 7, luck: 3 },
    background: 'A long-haul courier who survived an ambush on the road to New Vegas. The package you carried is still sealed — and somebody clearly wants it badly enough to kill for it.',
    inventory: [
      { name: 'Worn Courier Satchel', description: 'A leather bag that has crossed the Mojave a hundred times. Smells of dust and gun oil.' },
      { name: 'Sealed Delivery Package', description: 'A small, heavy parcel marked "PRIORITY". The seal is intact. For now.' },
      { name: 'Dented Canteen', description: 'Half full of lukewarm water. In the Mojave, that counts as wealth.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting quest about the sealed package and the people who set the ambush',
  },
  {
    id: 'vault-researcher',
    label: 'Vault Researcher',
    tagline: 'The vault is failing. The surface is the only answer left.',
    defaultName: 'Elian Cole',
    special: { strength: 3, perception: 7, endurance: 4, charisma: 5, intelligence: 9, agility: 4, luck: 3 },
    background: 'A junior scientist sent to the surface after the vault\'s water purification system began to fail. Book-smart, wasteland-naive, and carrying the hopes of everyone below.',
    inventory: [
      { name: 'Vault Jumpsuit', description: 'Bright blue and yellow. Practically a "shoot me" sign out here, but it keeps the sun off.' },
      { name: 'RobCo Multitool', description: 'A well-maintained engineering tool. Opens panels, strips wires, occasionally opens cans.' },
      { name: 'Research Holotape', description: 'Specifications of the failing purifier component. The whole vault depends on this data.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting quest about finding a replacement component to save the vault',
  },
  {
    id: 'ncr-deserter',
    label: 'NCR Deserter',
    tagline: 'You refused the order. Now the MPs want a word.',
    defaultName: 'Ray Vasquez',
    special: { strength: 7, perception: 6, endurance: 7, charisma: 3, intelligence: 4, agility: 5, luck: 3 },
    background: 'A trooper who walked away after refusing an order that would have burned a village. Trained, disciplined, hunted — NCR military police do not forget deserters.',
    inventory: [
      { name: 'NCR Dog Tags', description: 'Your name and serial number. Proof of service — and of desertion, if the wrong people see them.' },
      { name: 'Combat Knife', description: 'Standard-issue blade, kept razor sharp. It has seen use.' },
      { name: 'Tattered Army Fatigues', description: 'The insignia have been torn off, but the cut is unmistakably NCR.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting quest about staying ahead of the NCR military police hunting them',
  },
  {
    id: 'wasteland-medic',
    label: 'Wasteland Medic',
    tagline: 'The caravan is gone. The patients might not be.',
    defaultName: 'Sara Okafor',
    special: { strength: 3, perception: 6, endurance: 5, charisma: 5, intelligence: 8, agility: 4, luck: 4 },
    background: 'A traveling doctor whose caravan was hit by raiders at dawn. You crawled out of the wreckage with your bag and your oath — some of the others may still be alive out there.',
    inventory: [
      { name: "Battered Doctor's Bag", description: 'Scalpels, forceps, sutures. Everything needed to pull someone back from the edge.' },
      { name: 'Stimpak', description: 'A single precious auto-injector. Instant healing, if you can spare it.' },
      { name: 'Bloodstained Medical Journal', description: 'Patient notes and formulas. The blood on the cover is not yours.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting quest about the raided caravan and its missing survivors',
  },
  {
    id: 'caravan-trader',
    label: 'Caravan Trader',
    tagline: 'One rigged deal took everything. Time to collect.',
    defaultName: 'Marcus Vey',
    special: { strength: 3, perception: 5, endurance: 4, charisma: 8, intelligence: 6, agility: 3, luck: 6 },
    background: 'A merchant who lost the whole caravan to a rigged deal with the Garret family. Your name is still good on some routes — and your debt is very good with some dangerous people.',
    inventory: [
      { name: 'Trade Ledger', description: 'Every deal, every debt, every name. The last page lists who owes you — and who you owe.' },
      { name: 'Pouch of Bottle Caps', description: 'A modest handful of caps. Seed money for the comeback.' },
      { name: 'Brahmin-Hide Coat', description: 'A trader\'s coat with more hidden pockets than visible ones.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting quest about repaying a dangerous debt or getting even with the family that rigged the deal',
  },
  {
    id: 'tribal-hunter',
    label: 'Tribal Hunter',
    tagline: 'Exiled for a broken taboo. Redemption must be earned.',
    defaultName: 'Ash-of-Two-Rivers',
    special: { strength: 6, perception: 7, endurance: 6, charisma: 2, intelligence: 3, agility: 8, luck: 3 },
    background: 'A hunter cast out of the tribe after breaking a sacred taboo. The elders said the wasteland would judge you. Prove your worth, and the tribe\'s fires may welcome you again.',
    inventory: [
      { name: 'Handmade Spear', description: 'Fire-hardened wood and scavenged steel. It has never missed twice.' },
      { name: 'Dried Gecko Meat', description: 'Tough, salty, and keeps forever. Tastes like survival.' },
      { name: 'Bone Charm Necklace', description: 'A charm from the tribe. They took your place at the fire, but not this.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting quest about earning the right to return to their tribe',
  },
  {
    id: 'raider-turncoat',
    label: 'Raider Turncoat',
    tagline: 'You left the gang with a piece of their map. They noticed.',
    defaultName: 'Knuckles Reyes',
    special: { strength: 7, perception: 5, endurance: 7, charisma: 3, intelligence: 3, agility: 6, luck: 4 },
    background: 'A raider who walked out on the gang — and took a fragment of their loot map as severance pay. Gangs forgive many things. Stealing from the score is not one of them.',
    inventory: [
      { name: 'Spiked Knuckles', description: 'Ugly, brutal, effective. Like the life you are trying to leave behind.' },
      { name: 'Raider Bandana', description: 'The gang\'s colors. Wearing it opens some doors and closes others.' },
      { name: 'Stolen Map Fragment', description: 'One third of a map to the gang\'s buried score. They have the other two thirds — and your description.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting quest about the stolen loot map and the gang hunting them down',
  },
  {
    id: 'bounty-hunter',
    label: 'Bounty Hunter',
    tagline: 'The mark is worth a fortune. The mark also knows you are coming.',
    defaultName: 'Rex Calloway',
    special: { strength: 5, perception: 7, endurance: 6, charisma: 3, intelligence: 4, agility: 6, luck: 4 },
    background: 'A bounty hunter who takes the contracts nobody else will touch. The latest poster promises more caps than the last ten jobs combined — which means the mark is either very dangerous, or the contract is a trap. Possibly both.',
    inventory: [
      { name: 'Crumpled Bounty Poster', description: 'A sun-bleached face, a name, and a number with far too many zeros. Dead or alive — alive pays double.' },
      { name: 'Battered Revolver', description: 'An old .357 with a worn grip and a clean barrel. It has ended more contracts than words ever did.' },
      { name: 'Iron Manacles', description: 'Heavy pre-War handcuffs. For the marks worth more breathing.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting quest about tracking down the mark from the bounty poster and figuring out why the reward is so high',
  },
  {
    id: 'private-detective',
    label: 'Private Detective',
    tagline: 'The client paid up front, then vanished. Cases like that never end well.',
    defaultName: 'Nick Marlowe',
    special: { strength: 3, perception: 8, endurance: 4, charisma: 5, intelligence: 7, agility: 4, luck: 4 },
    background: 'A private eye scraping by on divorce cases and lost brahmin. Then a stranger paid a fat retainer to find a missing person — and vanished the next day. Now you have two disappearances, one case file, and a bad feeling that somebody is playing you.',
    inventory: [
      { name: 'Worn Trench Coat', description: 'Sand-colored by now, whatever color it started as. The pockets hold more secrets than most safes.' },
      { name: "Detective's Notebook", description: 'Names, dates, contradictions. The last page holds everything known about the case: not much, and all of it strange.' },
      { name: 'Pre-War Lighter', description: 'Still catches on the first strike. Good for cigarettes, dark corners, and dramatic pauses.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting noir-style quest about the missing person case and the client who vanished after paying the retainer',
  },
  {
    id: 'ghoul-drifter',
    label: 'Ghoul Drifter',
    tagline: 'Two hundred years old, and still looking for home.',
    defaultName: 'Harold Finch',
    special: { strength: 4, perception: 6, endurance: 8, charisma: 2, intelligence: 6, agility: 4, luck: 5 },
    background: 'A pre-War ghoul who watched the bombs fall two centuries ago. Most memories have burned away with the skin, but one remains: a house in a photograph, and a promise to come back to it.',
    inventory: [
      { name: 'Tattered Pre-War Suit', description: 'Once a fine business suit. Now it matches the wearer: worn through, but still standing.' },
      { name: 'Faded Family Photo', description: 'A house, a porch, two blurred figures waving. The only thing the centuries could not take.' },
    ],
    statusEffects: ['Ghoul'],
    openingHint: 'create a starting quest about finding the place shown in the faded photograph',
  },
  {
    id: 'lucky-gambler',
    label: 'Lucky Gambler',
    tagline: 'You won too much. The house dumped you in the desert.',
    defaultName: 'Dominic "Domino" Cross',
    special: { strength: 4, perception: 5, endurance: 4, charisma: 6, intelligence: 4, agility: 3, luck: 9 },
    background: 'A gambler who beat the house one time too many. Casino security drove you into the desert, took the winnings, and left you the suit. The luck, though — the luck stayed.',
    inventory: [
      { name: 'Lucky Deck of Cards', description: 'Fifty-two cards, one of them always turns up when it matters.' },
      { name: 'Worn White Suit', description: 'Sun-bleached and sand-scoured, but it still says "high roller" from a distance.' },
      { name: 'Casino Chip', description: 'A single chip from the casino that threw you out. A souvenir — or a promise.' },
    ],
    statusEffects: [],
    openingHint: 'create a starting quest about getting back to the casino that robbed them and settling the score',
  },
];


import React, { useMemo, useState } from 'react';
import type { SPECIAL } from '../types';
import { CHARACTER_PRESETS, SPECIAL_CREATION_BUDGET, type CharacterPreset, type CharacterProfile } from '../characterPresets';
import { soundService } from '../services/soundService';

interface CharacterCreationProps {
  onConfirm: (profile: CharacterProfile) => void;
  onCancel: () => void;
  disabled: boolean;
}

const STAT_KEYS: Array<keyof SPECIAL> = ['strength', 'perception', 'endurance', 'charisma', 'intelligence', 'agility', 'luck'];

function specialSum(special: SPECIAL): number {
  return STAT_KEYS.reduce((sum, key) => sum + special[key], 0);
}

const CharacterCreation: React.FC<CharacterCreationProps> = ({ onConfirm, onCancel, disabled }) => {
  const [presetId, setPresetId] = useState<string>(CHARACTER_PRESETS[0].id);
  const [name, setName] = useState<string>(CHARACTER_PRESETS[0].defaultName);
  const [special, setSpecial] = useState<SPECIAL>({ ...CHARACTER_PRESETS[0].special });
  const [background, setBackground] = useState<string>(CHARACTER_PRESETS[0].background);

  const preset = useMemo<CharacterPreset>(
    () => CHARACTER_PRESETS.find(p => p.id === presetId) || CHARACTER_PRESETS[0],
    [presetId]
  );
  const pointsRemaining = SPECIAL_CREATION_BUDGET - specialSum(special);

  const applyPreset = (next: CharacterPreset) => {
    soundService.playUi('ui_menu_ok');
    setPresetId(next.id);
    setName(next.defaultName);
    setSpecial({ ...next.special });
    setBackground(next.background);
  };

  const handleIncrement = (stat: keyof SPECIAL) => {
    if (pointsRemaining > 0 && special[stat] < 10) {
      soundService.playUi('ui_click');
      setSpecial(prev => ({ ...prev, [stat]: prev[stat] + 1 }));
    }
  };

  const handleDecrement = (stat: keyof SPECIAL) => {
    if (special[stat] > 1) {
      soundService.playUi('ui_click');
      setSpecial(prev => ({ ...prev, [stat]: prev[stat] - 1 }));
    }
  };

  const handleConfirm = () => {
    if (disabled || pointsRemaining !== 0) return;
    soundService.playUi('ui_menu_ok');
    onConfirm({
      name: name.trim(),
      special,
      background: background.trim() || preset.background,
      inventory: preset.inventory,
      statusEffects: preset.statusEffects,
      openingHint: preset.openingHint,
    });
  };

  return (
    <div className="w-full h-screen flex flex-col items-center bg-black p-4 text-[#15ff00] overflow-y-auto">
      <h1 className="text-4xl sm:text-5xl text-glow mt-4 mb-1">VAULT-TEC PERSONNEL RECORD</h1>
      <p className="text-lg opacity-70 mb-6">Register a new wasteland casualty... er, adventurer.</p>

      <div className="w-full max-w-5xl flex flex-col md:flex-row gap-4 mb-6">
        {/* Preset list */}
        <div className="md:w-2/5 border-2 border-[#15ff00]/50 bg-black/50 p-3">
          <h2 className="text-2xl text-glow mb-2">ARCHETYPE</h2>
          <ul className="space-y-1 max-h-[50vh] overflow-y-auto pr-1">
            {CHARACTER_PRESETS.map(p => (
              <li key={p.id}>
                <button
                  onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                  onClick={() => applyPreset(p)}
                  className={`w-full text-left p-2 border transition-colors ${
                    p.id === presetId
                      ? 'border-[#15ff00] bg-green-900/50 text-glow'
                      : 'border-[#15ff00]/30 hover:bg-[#15ff00]/10'
                  }`}
                >
                  <span className="font-bold">{p.id === presetId ? '> ' : ''}{p.label}</span>
                  <span className="block text-sm opacity-70">{p.tagline}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Character sheet */}
        <div className="md:w-3/5 border-2 border-[#15ff00]/50 bg-black/50 p-3 flex flex-col gap-4">
          <div>
            <label htmlFor="char-name" className="text-2xl text-glow block mb-1">NAME</label>
            <input
              id="char-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={40}
              placeholder="Leave blank to stay a nameless drifter..."
              className="w-full bg-transparent border-b border-[#15ff00]/50 focus:outline-none focus:border-[#15ff00] text-xl text-[#15ff00] placeholder-[#15ff00]/40 pb-1"
            />
          </div>

          <div>
            <div className="flex justify-between items-baseline mb-1">
              <h2 className="text-2xl text-glow">S.P.E.C.I.A.L.</h2>
              <span className={`text-xl ${pointsRemaining !== 0 ? 'text-yellow-400 animate-pulse' : ''}`}>
                POINTS LEFT: {pointsRemaining}
              </span>
            </div>
            <ul className="space-y-1 text-xl">
              {STAT_KEYS.map(stat => (
                <li key={stat} className="flex justify-between items-center bg-black/50 px-2 py-1">
                  <span className="capitalize font-bold">{stat}</span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleDecrement(stat)}
                      disabled={special[stat] <= 1}
                      className="px-3 text-2xl border border-[#15ff00]/50 disabled:opacity-20 hover:bg-green-900/50"
                      aria-label={`Decrease ${stat}`}
                    >
                      -
                    </button>
                    <span className="w-8 text-center text-2xl">{special[stat]}</span>
                    <button
                      onClick={() => handleIncrement(stat)}
                      disabled={pointsRemaining === 0 || special[stat] >= 10}
                      className="px-3 text-2xl border border-[#15ff00]/50 disabled:opacity-20 hover:bg-green-900/50"
                      aria-label={`Increase ${stat}`}
                    >
                      +
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex-grow flex flex-col">
            <label htmlFor="char-background" className="text-2xl text-glow block mb-1">BACKGROUND</label>
            <textarea
              id="char-background"
              value={background}
              onChange={e => setBackground(e.target.value)}
              maxLength={600}
              rows={4}
              className="w-full flex-grow bg-black/50 border border-[#15ff00]/50 focus:outline-none focus:border-[#15ff00] text-[#15ff00] p-2 resize-none"
            />
            <p className="text-sm opacity-60 mt-1">The GM will weave this past into your opening scene and starting quest.</p>
          </div>
        </div>
      </div>

      <div className="flex gap-4 mb-8">
        <button
          onClick={() => { soundService.playUi('ui_click'); onCancel(); }}
          disabled={disabled}
          className="px-8 py-3 bg-black/50 border-2 border-[#15ff00]/70 text-xl hover:bg-green-900/50 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          &lt; BACK
        </button>
        <button
          onClick={handleConfirm}
          disabled={disabled || pointsRemaining !== 0}
          className="px-8 py-3 bg-green-900/50 border-2 border-[#15ff00] text-xl hover:bg-green-800/50 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed text-glow"
        >
          {disabled ? 'ENTERING THE WASTELAND...' : pointsRemaining !== 0 ? 'ASSIGN ALL POINTS' : 'ENTER THE WASTELAND'}
        </button>
      </div>
    </div>
  );
};

export default CharacterCreation;

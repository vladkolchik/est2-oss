
import React, { useState, useMemo } from 'react';
import type { Player, SPECIAL } from '../types';

interface LevelUpModalProps {
  player: Player;
  onConfirm: (newSpecial: SPECIAL) => void;
}

const LevelUpModal: React.FC<LevelUpModalProps> = ({ player, onConfirm }) => {
  const [tempSpecial, setTempSpecial] = useState<SPECIAL>({ ...player.special });
  const [pointsToSpend, setPointsToSpend] = useState<number>(player.specialPoints);

  const originalSpecial = useMemo(() => player.special, [player.special]);

  const handleIncrement = (stat: keyof SPECIAL) => {
    if (pointsToSpend > 0 && tempSpecial[stat] < 10) {
      setPointsToSpend(prev => prev - 1);
      setTempSpecial(prev => ({ ...prev, [stat]: prev[stat] + 1 }));
    }
  };

  const handleDecrement = (stat: keyof SPECIAL) => {
    if (tempSpecial[stat] > originalSpecial[stat]) {
      setPointsToSpend(prev => prev + 1);
      setTempSpecial(prev => ({ ...prev, [stat]: prev[stat] - 1 }));
    }
  };

  const handleConfirm = () => {
    if (pointsToSpend === 0) {
      onConfirm(tempSpecial);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 backdrop-blur-sm p-4 text-glow" role="dialog" aria-modal="true" aria-labelledby="level-up-title">
      <div className="w-full max-w-md border-2 border-[#15ff00]/70 p-6 bg-black/95">
        <h2 id="level-up-title" className="text-5xl text-center mb-2 animate-pulse">LEVEL UP!</h2>
        <p className="text-center text-xl mb-6">You've reached Level {player.level}.</p>
        
        <div className="mb-6">
          <p className="text-center text-2xl mb-4">POINTS TO SPEND: <span className="text-4xl">{pointsToSpend}</span></p>
          <ul className="space-y-2 text-2xl">
            {(Object.keys(tempSpecial) as Array<keyof SPECIAL>).map(stat => (
              <li key={stat} className="flex justify-between items-center bg-black/50 p-2">
                <span className="capitalize font-bold">{stat}</span>
                <div className="flex items-center gap-3">
                  <button 
                    onClick={() => handleDecrement(stat)} 
                    disabled={tempSpecial[stat] <= originalSpecial[stat]}
                    className="px-3 text-3xl border border-[#15ff00]/50 disabled:opacity-20 hover:bg-green-900/50"
                    aria-label={`Decrease ${stat}`}>
                    -
                  </button>
                  <span className="w-8 text-center text-3xl">{tempSpecial[stat]}</span>
                  <button 
                    onClick={() => handleIncrement(stat)}
                    disabled={pointsToSpend === 0 || tempSpecial[stat] >= 10}
                    className="px-3 text-3xl border border-[#15ff00]/50 disabled:opacity-20 hover:bg-green-900/50"
                    aria-label={`Increase ${stat}`}>
                    +
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        
        <button 
          onClick={handleConfirm} 
          disabled={pointsToSpend > 0}
          className="w-full text-center px-4 py-3 bg-black/75 border-2 border-[#15ff00]/70 text-[#15ff00] text-2xl hover:bg-green-900/75 hover:border-[#15ff00] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pointsToSpend > 0 ? 'ASSIGN ALL POINTS' : 'CONFIRM'}
        </button>
      </div>
    </div>
  );
};

export default LevelUpModal;


import React from 'react';
import type { Player } from '../types';

interface StatusBarProps {
  player: Player;
}

const StatusBar: React.FC<StatusBarProps> = ({ player }) => {
  const [currentHp, maxHp] = player.hp.split('/').map(Number);
  const hpPercentage = maxHp > 0 ? (currentHp / maxHp) * 100 : 0;
  const xpPercentage = player.xpToNextLevel > 0 ? (player.xp / player.xpToNextLevel) * 100 : 0;

  return (
    <div className="border-2 border-[#15ff00]/50 p-3 bg-black/50">
      <h2 className="text-2xl mb-2 text-glow">STATUS</h2>
      {player.name && (
        <p className="mb-2 font-bold truncate" title={player.name}>{player.name}</p>
      )}

      {/* Level & XP */}
      <div className="mb-4">
        <div className="flex justify-between items-baseline">
            <span className="font-bold">LEVEL</span>
            <span className="text-glow text-xl">{player.level}</span>
        </div>
        <div className="flex justify-between items-baseline text-sm">
            <span>XP</span>
            <span>{player.xp} / {player.xpToNextLevel}</span>
        </div>
        <div className="w-full bg-green-900/50 border border-[#15ff00]/50 h-3 mt-1">
            <div 
                className="bg-[#15ff00] h-full transition-all duration-500" 
                style={{ width: `${xpPercentage}%` }}
            ></div>
        </div>
      </div>

      {/* HP Bar */}
      <div className="mb-4">
        <div className="flex justify-between items-baseline">
          <span className="font-bold">HP</span>
          <span>{player.hp}</span>
        </div>
        <div className="w-full bg-green-900/50 border border-[#15ff00]/50 h-5">
          <div 
            className="bg-[#15ff00] h-full transition-all duration-500" 
            style={{ width: `${hpPercentage}%`, boxShadow: '0 0 5px #15ff00' }}
          ></div>
        </div>
      </div>
      
      {/* Status Effects */}
      <div className="mb-4">
          <h3 className="font-bold text-lg">CONDITION</h3>
          {player.statusEffects.length > 0 ? (
            <ul className="list-disc list-inside">
                {player.statusEffects.map((effect, index) => (
                    <li key={index}>{effect}</li>
                ))}
            </ul>
          ) : (
            <p>Normal</p>
          )}
      </div>

      {/* S.P.E.C.I.A.L. Stats */}
      <div>
        <h3 className="font-bold text-lg mb-1">S.P.E.C.I.A.L.</h3>
        <ul className="grid grid-cols-2 gap-x-4">
          {Object.entries(player.special).map(([stat, value]) => (
            <li key={stat} className="flex justify-between">
              <span>{stat.substring(0, 3).toUpperCase()}</span>
              <span>{value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default StatusBar;
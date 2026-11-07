
import React from 'react';
import { soundService } from '../services/soundService';
import type { Quest } from '../types';

interface QuestLogProps {
  quests: Quest[];
  onOpenModal: () => void;
}

const QuestLog: React.FC<QuestLogProps> = ({ quests, onOpenModal }) => {
  const activeQuests = quests?.filter(q => q.status === 'active') || [];

  return (
    <div className="border-2 border-[#15ff00]/50 p-3 bg-black/50 flex flex-col flex-grow min-h-0">
      <h2 className="text-2xl mb-2 text-glow flex-shrink-0">QUEST LOG</h2>
      <div className="flex-grow overflow-y-auto pr-1">
        {activeQuests.length > 0 ? (
          <ul className="space-y-3">
            {activeQuests.slice(0, 3).map((quest) => (
              <li key={quest.name}>
                <p className="font-bold text-xl truncate" title={quest.name}>{quest.name}</p>
                <ul className="list-disc list-inside pl-2 opacity-90">
                  {quest.objectives.slice(0, 2).map((obj, objIndex) => (
                    <li key={objIndex} className={`truncate ${obj.isCompleted ? 'line-through opacity-50' : ''}`} title={obj.description}>
                      {obj.description}
                    </li>
                  ))}
                   {quest.objectives.length > 2 && <li className="list-none pl-1 opacity-60">...more objectives</li>}
                </ul>
              </li>
            ))}
            {activeQuests.length > 3 && <p className="opacity-60 mt-2 text-center">...more active quests</p>}
          </ul>
        ) : (
          <p className="opacity-70">No active quests.</p>
        )}
      </div>
      <button 
        onMouseEnter={() => soundService.playUi('ui_menu_focus')}
        onClick={() => { soundService.playUi('ui_menu_ok'); onOpenModal(); }} 
        className="mt-3 w-full text-center px-4 py-2 bg-black/75 border-2 border-[#15ff00]/70 text-[#15ff00] hover:bg-green-900/75 hover:border-[#15ff00] transition-all duration-200 text-glow flex-shrink-0"
      >
        View Full Log
      </button>
    </div>
  );
};

export default QuestLog;

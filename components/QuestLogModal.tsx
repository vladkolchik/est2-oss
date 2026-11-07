
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Quest } from '../types';
import { soundService } from '../services/soundService';

interface QuestLogModalProps {
  quests: Quest[];
  onClose: () => void;
}

type StatusFilter = 'active' | 'completed' | 'failed' | 'all';

const FILTER_TABS: StatusFilter[] = ['active', 'completed', 'failed', 'all'];

function questMatchesQuery(quest: Quest, query: string): boolean {
  if (!query) return true;
  const haystack = [quest.name, quest.description, ...quest.objectives.map(o => o.description)]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

const QuestLogModal: React.FC<QuestLogModalProps> = ({ quests, onClose }) => {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [filterText, setFilterText] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    filterInputRef.current?.focus();
  }, []);

  const counts = useMemo(() => ({
    active: quests.filter(q => q.status === 'active').length,
    completed: quests.filter(q => q.status === 'completed').length,
    failed: quests.filter(q => q.status === 'failed').length,
    all: quests.length,
  }), [quests]);

  const query = filterText.trim().toLowerCase();
  const visibleQuests = useMemo(
    () => quests.filter(q => (statusFilter === 'all' || q.status === statusFilter) && questMatchesQuery(q, query)),
    [quests, statusFilter, query]
  );

  const renderQuestSection = (title: string, questsToRender: Quest[]) => {
    if (questsToRender.length === 0) return null;
    return (
      <div className="mb-6">
        <h3 className="text-2xl text-glow border-b-2 border-[#15ff00]/30 pb-1 mb-3">{title}</h3>
        <ul className="space-y-4">
          {questsToRender.map((quest) => (
            <li key={quest.name} className={quest.status === 'completed' ? 'opacity-60' : quest.status === 'failed' ? 'text-red-500/80' : ''}>
              <p className="font-bold text-xl">{quest.name}</p>
              <p className="text-base opacity-80 italic mb-2">{quest.description}</p>
              <ul className="list-disc list-inside pl-4 space-y-1">
                {quest.objectives.map((obj, objIndex) => (
                  <li key={objIndex} className={obj.isCompleted ? 'line-through opacity-70' : ''}>
                    {obj.description}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="quest-log-title">
      <div className="w-full max-w-3xl h-[80vh] border-2 border-[#15ff00]/50 p-6 bg-black/95 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h2 id="quest-log-title" className="text-4xl text-glow">FULL QUEST LOG</h2>
          <button onClick={onClose} className="text-3xl px-3 py-1 border-2 border-transparent hover:border-[#15ff00]/50 transition-colors" aria-label="Close Quest Log">
            &times;
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          {FILTER_TABS.map(tab => (
            <button
              key={tab}
              onClick={() => { soundService.playUi('ui_click'); setStatusFilter(tab); }}
              className={`px-3 py-1 border text-sm uppercase transition-colors ${
                statusFilter === tab
                  ? 'border-[#15ff00] bg-green-900/50 text-glow'
                  : 'border-[#15ff00]/40 hover:bg-[#15ff00]/10'
              }`}
            >
              {tab} [{counts[tab]}]
            </button>
          ))}
          <div className="flex-grow min-w-[10rem] flex items-center gap-2 text-lg">
            <span className="text-glow">&gt;</span>
            <input
              ref={filterInputRef}
              type="text"
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              placeholder="Filter quests..."
              className="w-full bg-transparent border-b border-[#15ff00]/50 focus:outline-none focus:border-[#15ff00] text-[#15ff00] placeholder-[#15ff00]/40"
              aria-label="Filter quests"
            />
          </div>
        </div>

        <div className="flex-grow overflow-y-auto pr-2">
            {statusFilter === 'all' ? (
              <>
                {renderQuestSection('Active', visibleQuests.filter(q => q.status === 'active'))}
                {renderQuestSection('Completed', visibleQuests.filter(q => q.status === 'completed'))}
                {renderQuestSection('Failed', visibleQuests.filter(q => q.status === 'failed'))}
              </>
            ) : (
              renderQuestSection(statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1), visibleQuests)
            )}
            {quests.length === 0 && <p className="opacity-70 text-lg">No quests recorded in your Pip-Boy yet.</p>}
            {quests.length > 0 && visibleQuests.length === 0 && (
              <p className="opacity-70 text-lg">No {statusFilter === 'all' ? '' : `${statusFilter} `}quests{query ? ` matching "${filterText.trim()}"` : ''}.</p>
            )}
        </div>
      </div>
    </div>
  );
};

export default QuestLogModal;

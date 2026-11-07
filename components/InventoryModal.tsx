
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { soundService } from '../services/soundService';
import type { InventoryItem } from '../types';

interface InventoryModalProps {
  inventory: InventoryItem[];
  onClose: () => void;
  onAction: (action: string) => void;
  actionsDisabled: boolean;
  initialItemName?: string | null;
}

const InventoryModal: React.FC<InventoryModalProps> = ({ inventory, onClose, onAction, actionsDisabled, initialItemName }) => {
  const [filter, setFilter] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(initialItemName || inventory[0]?.name || null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const filteredItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return inventory;
    return inventory.filter(item =>
      item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query)
    );
  }, [inventory, filter]);

  const selectedItem = useMemo(
    () => filteredItems.find(item => item.name === selectedName) || filteredItems[0] || null,
    [filteredItems, selectedName]
  );

  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (filteredItems.length === 0) return;
        const currentIndex = filteredItems.findIndex(item => item.name === selectedItem?.name);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = (currentIndex + delta + filteredItems.length) % filteredItems.length;
        soundService.playUi('ui_menu_focus');
        setSelectedName(filteredItems[nextIndex].name);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredItems, selectedItem, onClose]);

  const handleItemAction = (verb: string) => {
    if (!selectedItem || actionsDisabled) return;
    soundService.playUi('ui_menu_ok');
    onAction(`${verb} ${selectedItem.name}`);
    onClose();
  };

  const actionButtonClass =
    'px-4 py-2 border-2 border-[#15ff00]/70 text-[#15ff00] bg-black/75 hover:bg-green-900/75 hover:border-[#15ff00] transition-all duration-200 text-glow disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-black/75 disabled:hover:border-[#15ff00]/70';

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="inventory-title">
      <div className="w-full max-w-4xl h-[80vh] border-2 border-[#15ff00]/50 p-6 bg-black/95 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4 flex-shrink-0">
          <h2 id="inventory-title" className="text-4xl text-glow">
            INVENTORY <span className="text-2xl opacity-70">[{inventory.length}]</span>
          </h2>
          <button onClick={onClose} className="text-3xl px-3 py-1 border-2 border-transparent hover:border-[#15ff00]/50 transition-colors" aria-label="Close Inventory">
            &times;
          </button>
        </div>

        {/* Filter */}
        <div className="flex items-center border-b-2 border-[#15ff00]/30 pb-2 mb-4 flex-shrink-0 text-xl">
          <span className="text-glow mr-2">&gt;</span>
          <input
            ref={filterRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter items..."
            className="flex-grow bg-transparent border-none focus:outline-none text-[#15ff00] placeholder-[#15ff00]/40"
            aria-label="Filter items"
          />
          {filter && (
            <button onClick={() => setFilter('')} className="px-2 opacity-70 hover:opacity-100" aria-label="Clear filter">
              &times;
            </button>
          )}
        </div>

        {inventory.length === 0 ? (
          <p className="opacity-70 text-lg">Your pockets are empty.</p>
        ) : (
          <div className="flex flex-grow gap-4 min-h-0">
            {/* Item list */}
            <div className="w-1/2 sm:w-2/5 overflow-y-auto pr-2 border-r-2 border-[#15ff00]/30">
              {filteredItems.length > 0 ? (
                <ul className="space-y-1">
                  {filteredItems.map((item) => {
                    const isSelected = item.name === selectedItem?.name;
                    return (
                      <li key={item.name}>
                        <button
                          onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                          onClick={() => setSelectedName(item.name)}
                          className={`w-full text-left px-2 py-1.5 text-lg transition-all duration-150 truncate ${
                            isSelected
                              ? 'bg-[#15ff00]/20 text-[#15ff00] text-glow border-l-4 border-[#15ff00]'
                              : 'text-[#15ff00]/70 hover:bg-[#15ff00]/10 hover:text-[#15ff00] border-l-4 border-transparent'
                          }`}
                          title={item.name}
                        >
                          {item.name}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="opacity-70 px-2">No items match the filter.</p>
              )}
            </div>

            {/* Item details */}
            <div className="flex-grow flex flex-col min-h-0">
              {selectedItem ? (
                <>
                  <h3 className="text-2xl text-glow border-b-2 border-[#15ff00]/30 pb-1 mb-3 flex-shrink-0">{selectedItem.name}</h3>
                  <p className="text-lg opacity-80 whitespace-normal overflow-y-auto flex-grow pr-2">{selectedItem.description}</p>
                  <div className="flex gap-3 mt-4 flex-shrink-0">
                    <button onMouseEnter={() => soundService.playUi('ui_menu_focus')} onClick={() => handleItemAction('Use')} disabled={actionsDisabled} className={actionButtonClass}>
                      USE
                    </button>
                    <button onMouseEnter={() => soundService.playUi('ui_menu_focus')} onClick={() => handleItemAction('Examine')} disabled={actionsDisabled} className={actionButtonClass}>
                      EXAMINE
                    </button>
                    <button onMouseEnter={() => soundService.playUi('ui_menu_focus')} onClick={() => handleItemAction('Drop')} disabled={actionsDisabled} className={`${actionButtonClass} border-red-500/60 text-red-400 hover:bg-red-900/40 hover:border-red-400`}>
                      DROP
                    </button>
                  </div>
                  {actionsDisabled && <p className="mt-2 text-sm opacity-60 animate-pulse flex-shrink-0">Awaiting response...</p>}
                </>
              ) : (
                <p className="opacity-70">Select an item to inspect it.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default InventoryModal;

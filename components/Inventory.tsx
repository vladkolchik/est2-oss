
import React from 'react';
import { soundService } from '../services/soundService';
import type { InventoryItem } from '../types';

interface InventoryProps {
  inventory: InventoryItem[];
  onOpenModal: (itemName?: string) => void;
}

const VISIBLE_ITEMS = 6;

const Inventory: React.FC<InventoryProps> = ({ inventory, onOpenModal }) => {
  const visibleItems = inventory.slice(0, VISIBLE_ITEMS);
  const hiddenCount = inventory.length - visibleItems.length;

  return (
    <div className="border-2 border-[#15ff00]/50 p-3 bg-black/50 flex flex-col">
      <h2 className="text-2xl mb-2 text-glow flex justify-between items-baseline">
        <span>INVENTORY</span>
        <span className="text-lg opacity-70">[{inventory.length}]</span>
      </h2>
      {inventory.length > 0 ? (
        <ul className="space-y-1">
          {visibleItems.map((item) => (
            <li key={item.name}>
              <button
                onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                onClick={() => { soundService.playUi('ui_menu_ok'); onOpenModal(item.name); }}
                className="w-full text-left truncate px-1 text-[#15ff00]/80 hover:text-[#15ff00] hover:bg-[#15ff00]/10 transition-all duration-150"
                title={item.description}
              >
                <span className="opacity-60 mr-1">&gt;</span>{item.name}
              </button>
            </li>
          ))}
          {hiddenCount > 0 && <li className="opacity-60 px-1">...and {hiddenCount} more</li>}
        </ul>
      ) : (
        <p className="opacity-70">Your pockets are empty.</p>
      )}
      <button
        onMouseEnter={() => soundService.playUi('ui_menu_focus')}
        onClick={() => { soundService.playUi('ui_menu_ok'); onOpenModal(); }}
        className="mt-3 w-full text-center px-4 py-2 bg-black/75 border-2 border-[#15ff00]/70 text-[#15ff00] hover:bg-green-900/75 hover:border-[#15ff00] transition-all duration-200 text-glow"
      >
        Open Inventory
      </button>
    </div>
  );
};

export default Inventory;

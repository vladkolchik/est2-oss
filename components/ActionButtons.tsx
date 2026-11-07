import React from 'react';

interface ActionButtonsProps {
  actions: string[];
  onAction: (action: string) => void;
  disabled: boolean;
}

const ActionButtons: React.FC<ActionButtonsProps> = ({ actions, onAction, disabled }) => {
  if (!actions || actions.length === 0) {
    return null;
  }

  const buttonClasses = "px-6 py-3 bg-black/75 border-2 border-[#15ff00]/70 text-[#15ff00] text-[19px] hover:bg-green-900/75 hover:border-[#15ff00] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed";

  if (actions.length === 3) {
    return (
      <div className="mt-4 flex flex-col items-center gap-2">
        <div className="flex flex-wrap gap-2 justify-center">
            <button
              key={0}
              onClick={() => onAction(actions[0])}
              disabled={disabled}
              className={buttonClasses}
            >
              {actions[0]}
            </button>
            <button
              key={1}
              onClick={() => onAction(actions[1])}
              disabled={disabled}
              className={buttonClasses}
            >
              {actions[1]}
            </button>
        </div>
        <div>
            <button
                key={2}
                onClick={() => onAction(actions[2])}
                disabled={disabled}
                className={buttonClasses}
            >
                {actions[2]}
            </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2 justify-center">
      {actions.map((action, index) => (
        <button
          key={index}
          onClick={() => onAction(action)}
          disabled={disabled}
          className={buttonClasses}
        >
          {action}
        </button>
      ))}
    </div>
  );
};

export default ActionButtons;
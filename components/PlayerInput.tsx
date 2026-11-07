
import React, { useMemo, useRef, useState } from 'react';

interface PlayerInputProps {
  onAction: (action: string, mentions?: string[]) => void;
  disabled: boolean;
  mentionOptions?: string[];
}

interface ActiveMention {
  start: number;
  end: number;
  query: string;
}

const BRACED_MENTION_REGEX = /@\{([^}]+)\}/g;
const SIMPLE_MENTION_REGEX = /(^|\s)@([^\s@{}]+)/g;

function extractMentionsFromText(text: string): string[] {
  const input = String(text || '');
  if (!input) return [];

  const values: string[] = [];
  let match: RegExpExecArray | null;

  BRACED_MENTION_REGEX.lastIndex = 0;
  while ((match = BRACED_MENTION_REGEX.exec(input)) !== null) {
    const value = String(match[1] || '').trim();
    if (value) values.push(value);
  }

  SIMPLE_MENTION_REGEX.lastIndex = 0;
  while ((match = SIMPLE_MENTION_REGEX.exec(input)) !== null) {
    const value = String(match[2] || '').trim();
    if (value) values.push(value);
  }

  return Array.from(new Set(values)).slice(0, 12);
}

function findActiveMention(text: string, caret: number): ActiveMention | null {
  const beforeCaret = text.slice(0, caret);

  const braceStart = beforeCaret.lastIndexOf('@{');
  if (braceStart >= 0) {
    const token = beforeCaret.slice(braceStart + 2);
    if (!token.includes('}')) {
      return { start: braceStart, end: caret, query: token };
    }
  }

  const match = beforeCaret.match(/(^|\s)@([^\s@{}]*)$/);
  if (!match) return null;

  const mentionToken = match[2] || '';
  const start = caret - mentionToken.length - 1;
  if (start < 0) return null;
  return { start, end: caret, query: mentionToken };
}

const BlinkingCursor: React.FC = () => (
    <span className="w-3 h-6 bg-[#15ff00] inline-block ml-1 animate-pulse" style={{ animation: 'blink 1s step-end infinite' }}></span>
);

const PlayerInput: React.FC<PlayerInputProps> = ({ onAction, disabled, mentionOptions = [] }) => {
  const [input, setInput] = useState('');
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const suggestions = useMemo(() => {
    if (!activeMention) return [];

    const uniqueOptions = Array.from(
      new Set(mentionOptions.map((x) => String(x || '').trim()).filter(Boolean))
    );

    const query = activeMention.query.trim().toLowerCase();
    const filtered = query
      ? uniqueOptions.filter((option) => option.toLowerCase().includes(query))
      : uniqueOptions;

    return filtered.slice(0, 8);
  }, [activeMention, mentionOptions]);

  const suggestionsOpen = !disabled && !!activeMention && suggestions.length > 0;

  const applyMention = (mention: string) => {
    if (!activeMention) return;

    const normalized = String(mention || '').trim();
    if (!normalized) return;

    const renderedMention = normalized.includes(' ') ? `@{${normalized}}` : `@${normalized}`;
    const nextInput = `${input.slice(0, activeMention.start)}${renderedMention} ${input.slice(activeMention.end)}`;
    const caretPosition = activeMention.start + renderedMention.length + 1;

    setInput(nextInput);
    setActiveMention(null);
    setHighlightedIndex(0);

    requestAnimationFrame(() => {
      if (!inputRef.current) return;
      inputRef.current.focus();
      inputRef.current.setSelectionRange(caretPosition, caretPosition);
    });
  };

  const handleInputChange = (value: string, caret: number | null) => {
    setInput(value);
    if (caret === null || disabled) {
      setActiveMention(null);
      return;
    }

    const mention = findActiveMention(value, caret);
    setActiveMention(mention);
    setHighlightedIndex(0);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      const mentions = extractMentionsFromText(input);
      onAction(input, mentions);
      setInput('');
      setActiveMention(null);
      setHighlightedIndex(0);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!suggestionsOpen) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % suggestions.length);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
      return;
    }

    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applyMention(suggestions[highlightedIndex] || suggestions[0]);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setActiveMention(null);
      setHighlightedIndex(0);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="relative flex items-center text-[19px]">
      {suggestionsOpen && (
        <div className="absolute left-6 right-0 bottom-full mb-2 border border-[#15ff00]/60 bg-black/95 z-20">
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion}-${index}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                applyMention(suggestion);
              }}
              className={`w-full px-3 py-1 text-left text-[#15ff00] transition-colors duration-150 ${
                index === highlightedIndex ? 'bg-green-900/60' : 'hover:bg-green-900/35'
              }`}
            >
              @{suggestion}
            </button>
          ))}
        </div>
      )}
      <label htmlFor="player-action" className="text-glow mr-2">&gt;</label>
      <input
        ref={inputRef}
        id="player-action"
        type="text"
        value={input}
        onChange={(e) => handleInputChange(e.target.value, e.target.selectionStart)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setTimeout(() => {
            setActiveMention(null);
            setHighlightedIndex(0);
          }, 80);
        }}
        disabled={disabled}
        className="flex-grow bg-transparent border-none focus:outline-none text-[#15ff00]"
        autoComplete="off"
        placeholder={disabled ? 'Awaiting response...' : 'What do you do?'}
      />
    </form>
  );
};

export default PlayerInput;

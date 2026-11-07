import React, { useRef, useEffect } from 'react';
import type { StoryEntry } from '../types';

interface StoryDisplayProps {
  storyHistory: StoryEntry[];
}

const StoryDisplay: React.FC<StoryDisplayProps> = ({ storyHistory }) => {
    const endOfMessagesRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [storyHistory]);

    return (
        <div className="flex-grow border-2 border-[#15ff00]/50 p-4 bg-black/50 overflow-y-auto h-[524px] md:h-[250px] text-[19px] leading-relaxed">
            {/* Story Content */}
            {storyHistory.map((entry, index) => {
                if (entry.type === 'action') {
                    return (
                        <p key={index} className="text-[#15ff00]/70">
                            <span className="text-glow">&gt; </span>{entry.text}
                        </p>
                    );
                }
                if (entry.type === 'error') {
                    return (
                         <p key={index} className="text-red-500">{entry.text}</p>
                    );
                }
                if (entry.type === 'dialogue') {
                    return (
                        <div key={index} className="mb-3">
                            <span className="text-[#15ff00] font-semibold">{entry.speaker}</span>
                            <div className="pl-4 border-l border-[#15ff00]/40 mt-1">“{entry.text}”</div>
                        </div>
                    );
                }
                // narrative
                return <p key={index} className="mb-4">{entry.text}</p>;
            })}
            <div ref={endOfMessagesRef} />
        </div>
    );
};

export default StoryDisplay;

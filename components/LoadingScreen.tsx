
import React, { useState, useEffect } from 'react';

const loadingMessages = [
    "Rerouting power...",
    "Calibrating Geiger counter...",
    "Consulting RobCo database...",
    "Loading V.A.T.S. probabilities...",
    "Splicing genes...",
    "Avoiding radroaches...",
    "Filtering wasteland radio...",
    "Compiling survival data..."
];

const LoadingScreen: React.FC = () => {
    const [message, setMessage] = useState(loadingMessages[0]);

    useEffect(() => {
        const interval = setInterval(() => {
            setMessage(loadingMessages[Math.floor(Math.random() * loadingMessages.length)]);
        }, 1500);
        return () => clearInterval(interval);
    }, []);


    return (
        <div className="absolute inset-0 bg-black z-10 flex items-center text-[19px] overflow-hidden">
            <span className="text-glow mr-2">&gt;</span>
            <span className="w-4 h-4 border-2 border-dashed border-[#15ff00] rounded-full animate-spin mr-3 shrink-0"></span>
            <p className="animate-pulse text-glow truncate">{message}</p>
        </div>
    );
};

export default LoadingScreen;

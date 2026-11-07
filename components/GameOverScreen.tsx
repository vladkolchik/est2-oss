
import React from 'react';

interface GameOverScreenProps {
    onRestart: () => void;
    onLoad: () => void;
    saveExists: boolean;
}

const GameOverScreen: React.FC<GameOverScreenProps> = ({ onRestart, onLoad, saveExists }) => {
    return (
        <div className="w-full h-screen flex flex-col items-center justify-center bg-black p-4 text-center">
             <pre className="text-sm sm:text-base text-red-500 text-glow">
{`
 ██████╗  █████╗ ███╗   ███╗███████╗     ██████╗ ██╗   ██╗███████╗██████╗ 
██╔════╝ ██╔══██╗████╗ ████║██╔════╝    ██╔════╝ ██║   ██║██╔════╝██╔══██╗
██║  ███╗███████║██╔████╔██║█████╗      ██║  ███╗██║   ██║█████╗  ██████╔╝
██║   ██║██╔══██║██║╚██╔╝██║██╔══╝      ██║   ██║╚██╗ ██╔╝██╔══╝  ██╔══██╗
╚██████╔╝██║  ██║██║ ╚═╝ ██║███████╗    ╚██████╔╝ ╚████╔╝ ███████╗██║  ██║
 ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝     ╚═════╝   ╚═══╝  ╚══════╝╚═╝  ╚═╝
`}
            </pre>
            <p className="text-2xl mt-4 mb-8 text-glow text-white">Your journey through the wasteland has come to an end.</p>
            <div className="flex flex-col sm:flex-row gap-4">
                 {saveExists && (
                    <button 
                        onClick={onLoad}
                        className="px-8 py-4 bg-black/50 border-2 border-[#15ff00]/70 text-[#15ff00] text-2xl hover:bg-green-900/50 transition-all duration-300 text-glow"
                    >
                        LOAD LAST SAVE
                    </button>
                )}
                <button 
                    onClick={onRestart}
                    className="px-8 py-4 bg-green-900/50 border-2 border-[#15ff00] text-[#15ff00] text-2xl hover:bg-green-800/50 transition-all duration-300 text-glow"
                >
                    TRY AGAIN
                </button>
            </div>
        </div>
    );
};

export default GameOverScreen;

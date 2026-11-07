
import React, { useState, useEffect, useRef } from 'react';
import NarratorControls from './NarratorControls';
import RadioControls from './RadioControls';
import { ttsService } from '../services/ttsService';
import { soundService } from '../services/soundService';

interface GameHeaderProps {
  title: string;
  location: string;
  isMuted: boolean;
  onToggleMute: () => void;
  onSaveGame: () => void;
  saveMessage: string;
  onOpenMap: () => void;
  onOpenApiKeys: () => void;
  isImageGenEnabled: boolean;
  onToggleImageGen: () => void;
  imageMode: 'sketch' | 'ai';
  onToggleImageMode: () => void;
  narratorText: string;
  narratorSequence?: Array<{ type: 'narrative' | 'dialogue'; text: string; gender?: 'male' | 'female' | 'unknown'; speaker?: string }>;
  narratorSequenceId?: string;
  // Radio wiring
  onRadioPlayingChange?: (isPlaying: boolean) => void;
}

const MuteIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2L17 8m2 2l2 2" />
    </svg>
);

const UnmuteIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
    </svg>
);


const GameHeader: React.FC<GameHeaderProps> = ({ title, location, isMuted, onToggleMute, onSaveGame, saveMessage, onOpenMap, onOpenApiKeys, isImageGenEnabled, onToggleImageGen, imageMode, onToggleImageMode, narratorText, narratorSequence, narratorSequenceId, onRadioPlayingChange }) => {
  const [isNarratorEnabled, setIsNarratorEnabled] = useState(false);
  // Sound dropdown state
  const [isSoundOpen, setIsSoundOpen] = useState(false);
  const soundRef = useRef<HTMLDivElement>(null);
  const [radioVolume, setRadioVolume] = useState<number>(() => { try { return Number(localStorage.getItem('radio-volume') || '0.6'); } catch { return 0.6; } });
  const [narratorVolume, setNarratorVolume] = useState<number>(() => { try { return Number(localStorage.getItem('narrator-volume') || '0.8'); } catch { return 0.8; } });
  const [ambientVolume, setAmbientVolume] = useState<number>(() => { try { return Number(localStorage.getItem('ambient-volume') || '0.6'); } catch { return 0.6; } });
  const [uiVolume, setUiVolume] = useState<number>(() => { try { return Number(localStorage.getItem('ui-volume') || '0.8'); } catch { return 0.8; } });

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (soundRef.current && !soundRef.current.contains(e.target as Node)) setIsSoundOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  // User-driven change: persist and broadcast so the RadioControls slider follows
  const changeRadioVolume = (v: number) => {
    setRadioVolume(v);
    try { localStorage.setItem('radio-volume', String(v)); } catch {}
    window.dispatchEvent(new CustomEvent('radio-volume-change', { detail: { volume: v } }));
  };

  // Follow radio volume changes made elsewhere (RadioControls slider, save restore)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { volume?: number };
      if (typeof detail?.volume === 'number') setRadioVolume(detail.volume);
    };
    window.addEventListener('radio-volume-change', handler as EventListener);
    return () => window.removeEventListener('radio-volume-change', handler as EventListener);
  }, []);

  // Apply narrator volume immediately
  useEffect(() => {
    try { localStorage.setItem('narrator-volume', String(narratorVolume)); } catch {}
    try { ttsService.setNarratorVolume(narratorVolume); } catch {}
  }, [narratorVolume]);

  // Persist ambient/action volume and notify listeners (App ambience, SFX, etc.)
  useEffect(() => { 
    try { localStorage.setItem('ambient-volume', String(ambientVolume)); } catch {}
    window.dispatchEvent(new CustomEvent('ambient-volume-change', { detail: { volume: ambientVolume } }));
    // Reuse same value for action SFX volume for now
    window.dispatchEvent(new CustomEvent('action-volume-change', { detail: { volume: ambientVolume } }));
  }, [ambientVolume]);
  useEffect(() => { 
    try { localStorage.setItem('ui-volume', String(uiVolume)); } catch {}
    window.dispatchEvent(new CustomEvent('ui-volume-change', { detail: { volume: uiVolume } }));
  }, [uiVolume]);
  return (
    <header className="border-b-2 border-[#15ff00]/50 mb-4 pb-2 flex justify-between items-center gap-2 text-xl sm:text-2xl">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
            <h1 className="text-glow hidden sm:block">{title}</h1>
            {/* Main Sound Config Dropdown */}
            <div className="relative" ref={soundRef}>
              <button 
                  onClick={() => setIsSoundOpen(prev => !prev)}
                  className={`p-2 rounded border transition-all duration-200 flex items-center justify-center ${
                      isMuted 
                          ? 'border-red-500/50 bg-red-500/10 text-red-400 hover:border-red-400 hover:bg-red-500/20' 
                          : 'border-[#15ff00]/50 bg-[#15ff00]/10 text-[#15ff00] hover:border-[#15ff00] hover:bg-[#15ff00]/20 text-glow'
                  }`}
                  aria-label="Sound settings"
                  title="Sound settings"
              >
                  {isSoundOpen ? soundService.playUi('ui_toggle') : null}
                  {isMuted ? <MuteIcon /> : <UnmuteIcon />}
              </button>
              {isSoundOpen && (
                <div className="absolute top-full left-0 mt-1 bg-black/95 border border-[#15ff00]/50 rounded shadow-lg backdrop-blur-sm z-50 min-w-[220px]">
                  <div className="p-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs opacity-80">Global Mute</span>
                      <button onClick={() => { soundService.playUi('ui_click'); onToggleMute(); }} className={`px-2 py-0.5 text-xs border rounded ${isMuted ? 'border-red-500/60 text-red-400' : 'border-[#15ff00]/60 text-[#15ff00]'}`}>{isMuted ? 'Unmute' : 'Mute'}</button>
                    </div>
                    <div className="border-t border-[#15ff00]/30" />
                    <div>
                      <div className="px-1 pb-1 text-xs text-[#15ff00]/60 font-medium">Radio</div>
                      <input type="range" min={0} max={1} step={0.01} value={radioVolume} onChange={(e) => changeRadioVolume(Number(e.target.value))} className="sound-vol w-full bg-transparent cursor-pointer" />
                    </div>
                    <div>
                      <div className="px-1 pb-1 text-xs text-[#15ff00]/60 font-medium">Narrator</div>
                      <input type="range" min={0} max={1} step={0.01} value={narratorVolume} onChange={(e) => setNarratorVolume(Number(e.target.value))} className="sound-vol w-full bg-transparent cursor-pointer" />
                    </div>
                    <div>
                      <div className="px-1 pb-1 text-xs text-[#15ff00]/60 font-medium">Ambient & Action</div>
                      <input type="range" min={0} max={1} step={0.01} value={ambientVolume} onChange={(e) => setAmbientVolume(Number(e.target.value))} className="sound-vol w-full bg-transparent cursor-pointer" />
                    </div>
                    <div>
                      <div className="px-1 pb-1 text-xs text-[#15ff00]/60 font-medium">UI</div>
                      <input type="range" min={0} max={1} step={0.01} value={uiVolume} onChange={(e) => setUiVolume(Number(e.target.value))} className="sound-vol w-full bg-transparent cursor-pointer" />
                    </div>
                    <div className="border-t border-[#15ff00]/30" />
                    <button onClick={() => { soundService.playUi('ui_click'); changeRadioVolume(0); setNarratorVolume(0); setAmbientVolume(0); setUiVolume(0); }} className="w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 text-red-400 hover:bg-red-500/10 border border-red-500/40">Turn off all sound</button>
                  </div>
                </div>
              )}
            </div>
            {/* Scoped styles for sound sliders matching radio style */}
            <style>{`
              .sound-vol { 
                -webkit-appearance: none; 
                appearance: none; 
                background: transparent; 
              }
              .sound-vol:focus { outline: none; }
              .sound-vol::-webkit-slider-runnable-track {
                height: 4px;
                background: rgba(21, 255, 0, 0.3);
                border-radius: 9999px;
              }
              .sound-vol::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 12px;
                height: 12px;
                border-radius: 2px;
                background: #15ff00;
                border: 1px solid rgba(21, 255, 0, 0.9);
                box-shadow: 0 0 8px rgba(21, 255, 0, 0.6);
                margin-top: -4px;
              }
              .sound-vol:hover::-webkit-slider-thumb {
                box-shadow: 0 0 10px rgba(21, 255, 0, 0.8);
              }
              .sound-vol::-moz-range-track {
                height: 4px;
                background: rgba(21, 255, 0, 0.3);
                border-radius: 9999px;
              }
              .sound-vol::-moz-range-progress {
                height: 4px;
                background: rgba(21, 255, 0, 0.6);
                border-radius: 9999px;
              }
              .sound-vol::-moz-range-thumb {
                width: 12px;
                height: 12px;
                border-radius: 2px;
                background: #15ff00;
                border: 1px solid rgba(21, 255, 0, 0.9);
                box-shadow: 0 0 8px rgba(21, 255, 0, 0.6);
              }
            `}</style>
             <button 
                onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                onClick={() => { soundService.playUi('ui_menu_ok'); onSaveGame(); }} 
                className="p-1 px-3 border border-transparent hover:border-[#15ff00]/50 transition-colors text-lg"
                aria-label="Save game"
            >
                SAVE
            </button>
            <button 
                onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                onClick={() => { soundService.playUi('ui_menu_ok'); onOpenMap(); }} 
                className="p-1 px-3 border border-transparent hover:border-[#15ff00]/50 transition-colors text-lg"
                aria-label="Open world map"
            >
                MAP
            </button>
            <button
                onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                onClick={() => { soundService.playUi('ui_menu_ok'); onOpenApiKeys(); }}
                className="p-1 px-3 border border-transparent hover:border-[#15ff00]/50 transition-colors text-lg"
                aria-label="Your API keys"
                title="Use your own API keys (BYOK)"
            >
                KEYS
            </button>
            <button 
                onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                onClick={() => { soundService.playUi('ui_menu_ok'); onToggleImageGen(); }}
                className={`p-1 px-3 border border-transparent hover:border-[#15ff00]/50 transition-colors text-lg ${isImageGenEnabled ? 'text-yellow-300 text-glow' : ''}`}
                aria-label="Toggle image generation"
                title="Toggle scene image generation"
            >
                IMAGE GEN
            </button>
            {isImageGenEnabled && (
                <button
                    onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                    onClick={() => { soundService.playUi('ui_menu_ok'); onToggleImageMode(); }}
                    className="p-1 px-3 border border-transparent hover:border-[#15ff00]/50 transition-colors text-lg text-[#15ff00]/80"
                    aria-label="Toggle image mode"
                    title={imageMode === 'sketch'
                        ? 'Sketch mode: free parametric render by the artist agent. Click for AI images.'
                        : 'AI mode: full image model (may be costly). Click for free sketch mode.'}
                >
                    {imageMode === 'sketch' ? 'SKETCH' : 'AI IMG'}
                </button>
            )}
            <NarratorControls
                text={narratorText}
                isEnabled={isNarratorEnabled}
                onToggleEnabled={() => setIsNarratorEnabled(prev => !prev)}
                variant="header"
                sequence={narratorSequence}
                sequenceId={narratorSequenceId}
            />
            <RadioControls isMutedGlobal={isMuted} onRadioPlayingChange={onRadioPlayingChange} />
            {saveMessage && <span className="text-base opacity-90 animate-pulse">{saveMessage}</span>}
        </div>
      <div className="text-right">
        <p className="text-sm sm:text-base opacity-70">LOCATION:</p>
        <p className="font-bold text-glow">{location}</p>
      </div>
    </header>
  );
};

export default GameHeader;
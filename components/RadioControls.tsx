import React, { useEffect, useRef, useState } from 'react';
import { Howl } from 'howler';
import { RADIO_STREAMS } from '../constants';
import { soundService } from '../services/soundService';

interface RadioControlsProps {
    isMutedGlobal: boolean;
    onRadioPlayingChange?: (isPlaying: boolean) => void;
}

const RadioControls: React.FC<RadioControlsProps> = ({ isMutedGlobal, onRadioPlayingChange }) => {
    const howlRef = useRef<Howl | null>(null);
    const shouldAutoplayRef = useRef<boolean>(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);
    const [isPlaying, setIsPlaying] = useState<boolean>(false);
    const [isBuffering, setIsBuffering] = useState<boolean>(false);
    const [volume, setVolume] = useState<number>(() => {
        try { return Number(localStorage.getItem('radio-volume') || '0.6'); } catch { return 0.6; }
    });
    const [stationKey, setStationKey] = useState<keyof typeof RADIO_STREAMS>(() => {
        try {
            const saved = (localStorage.getItem('radio-station') || 'new_vegas') as keyof typeof RADIO_STREAMS;
            return (saved in RADIO_STREAMS) ? saved : 'new_vegas';
        } catch {
            return 'new_vegas';
        }
    });
    const [error, setError] = useState<string | null>(null);

    const stationList: Array<{ key: keyof typeof RADIO_STREAMS; label: string }> = [
        { key: 'new_vegas', label: 'Radio New Vegas (F:NV)' },
        { key: 'fo3_gnr', label: 'Galaxy News Radio (F3)' },
        { key: 'fo4_dcr', label: 'Diamond City Radio (F4)' },
        { key: 'fo4_classical', label: 'Fallout 4 Classical' },
        { key: 'fo4_mwtcf', label: 'F4: MWTCF' },
        { key: 'fo76_general', label: 'FO76 General' },
        { key: 'fo76_classical', label: 'FO76 Classical' },
        { key: 'fallout2', label: 'Fallout 2 OST' },
        { key: 'fallout1', label: 'Fallout 1 OST' },
        { key: 'main', label: 'Main Station' },
    ];

    // Build or rebuild Howl when station changes
    useEffect(() => {
        const url = RADIO_STREAMS[stationKey];
        const wasPlaying = shouldAutoplayRef.current || isPlaying;

        // Cleanup previous
        if (howlRef.current) {
            try { howlRef.current.stop(); } catch {}
            try { howlRef.current.unload(); } catch {}
            howlRef.current = null;
        }

        setIsBuffering(false);
        setError(null);

        const sound = new Howl({
            src: [url],
            html5: true,
            format: ['ogg'],
            volume: volume,
            preload: false,
            autoplay: false,
            onloaderror: () => {
                setError('Failed to load radio stream');
                setIsBuffering(false);
            },
            onplayerror: () => {
                setError('Playback blocked. Click anywhere to enable audio.');
                setIsBuffering(false);
            },
            onplay: () => {
                setIsBuffering(false);
                setIsPlaying(true);
                setError(null);
                onRadioPlayingChange?.(true);
            },
            onend: () => {
                setIsPlaying(false);
                onRadioPlayingChange?.(false);
            },
            onstop: () => {
                setIsPlaying(false);
                onRadioPlayingChange?.(false);
            },
            onpause: () => {
                setIsPlaying(false);
                onRadioPlayingChange?.(false);
            },
        });

        howlRef.current = sound;

        // Apply current mute state
        try { sound.mute(isMutedGlobal); } catch {}

        // Autoplay if we were playing before station change
        if (wasPlaying) {
            setIsBuffering(true);
            try { sound.play(); } catch {}
        }

        // Persist station
        try { localStorage.setItem('radio-station', stationKey); } catch {}

        return () => {
            try { sound.stop(); } catch {}
            try { sound.unload(); } catch {}
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stationKey]);

    // Close dropdown on outside click
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // React to global mute
    useEffect(() => {
        const h = howlRef.current;
        if (!h) return;
        try { h.mute(isMutedGlobal); } catch {}
    }, [isMutedGlobal]);

    // React to local volume changes
    useEffect(() => {
        const h = howlRef.current;
        if (!h) return;
        try { h.volume(volume); } catch {}
        try { localStorage.setItem('radio-volume', String(volume)); } catch {}
    }, [volume]);

    // Listen to external radio volume changes from SoundControls
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { volume?: number };
            if (typeof detail?.volume === 'number') {
                setVolume(detail.volume);
            }
        };
        window.addEventListener('radio-volume-change', handler as EventListener);
        return () => window.removeEventListener('radio-volume-change', handler as EventListener);
    }, []);

    // Listen to external station changes (restore on load)
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { station?: keyof typeof RADIO_STREAMS };
            if (detail?.station && detail.station in RADIO_STREAMS) {
                selectStation(detail.station);
            }
        };
        window.addEventListener('radio-station-change', handler as EventListener);
        return () => window.removeEventListener('radio-station-change', handler as EventListener);
    }, []);

    const handleTogglePlay = () => {
        const h = howlRef.current;
        if (!h) return;
        setError(null);
        if (isPlaying) {
            try { h.pause(); } catch {}
            setIsPlaying(false);
            onRadioPlayingChange?.(false);
            shouldAutoplayRef.current = false;
            return;
        }
        setIsBuffering(true);
        shouldAutoplayRef.current = true;
        try { h.play(); } catch { setIsBuffering(false); }
    };

    const handleStop = () => {
        const h = howlRef.current;
        if (!h) return;
        try { h.stop(); } catch {}
        setIsPlaying(false);
        setIsBuffering(false);
        onRadioPlayingChange?.(false);
        shouldAutoplayRef.current = false;
    };

    // User-driven change: broadcast so the SoundControls slider follows
    const changeVolume = (v: number) => {
        setVolume(v);
        window.dispatchEvent(new CustomEvent('radio-volume-change', { detail: { volume: v } }));
    };

    const selectStation = (key: keyof typeof RADIO_STREAMS) => {
        shouldAutoplayRef.current = isPlaying; // auto-restart if currently playing
        setStationKey(key);
    };

    const isHeader = true; // header variant only for now

    return (
        <div className={isHeader ? 'relative' : ''} ref={dropdownRef}>
            <button
                onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                onClick={() => { soundService.playUi('ui_menu_ok'); setIsDropdownOpen(prev => !prev); }}
                className={`p-2 border border-transparent hover:border-[#15ff00]/50 transition-all duration-200 flex items-center gap-1 text-lg ${
                    isPlaying ? 'text-[#15ff00] text-glow' : 'text-[#15ff00]/80 hover:text-[#15ff00]'
                }`}
                title="Radio controls"
            >
                <span className="font-medium">RADIO</span>
                {isBuffering && <span className="text-xs opacity-80">(buffer…)</span>}
                {isPlaying && <span className="w-1.5 h-1.5 bg-[#15ff00] rounded-full animate-pulse" />}
            </button>

            {isDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 bg-black/95 border border-[#15ff00]/50 rounded shadow-lg backdrop-blur-sm z-50 min-w-[220px]">
                    <div className="p-2 space-y-2">
                        {/* Station selector */}
                        <div>
                            <div className="px-1 pb-1 text-xs text-[#15ff00]/60 font-medium">Station</div>
                            <div className="max-h-56 overflow-auto space-y-1 pr-1">
                                {stationList.map((s) => (
                                    <button
                                        key={s.key}
                                        onClick={() => selectStation(s.key)}
                                        className={`w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center justify-between ${
                                            stationKey === s.key ? 'bg-[#15ff00]/20 text-[#15ff00] hover:bg-[#15ff00]/30' : 'text-[#15ff00]/70 hover:bg-[#15ff00]/10 hover:text-[#15ff00]'
                                        }`}
                                        title={s.label}
                                    >
                                        <span className="truncate">{s.label}</span>
                                        {stationKey === s.key && (
                                            <span className="w-1.5 h-1.5 bg-[#15ff00] rounded-full" />
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="border-t border-[#15ff00]/30" />

                        {/* Transport controls */}
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleTogglePlay}
                                className="px-2 py-1 text-xs border border-[#15ff00]/50 text-[#15ff00] hover:bg-[#15ff00]/10 rounded"
                                title={isPlaying ? 'Pause radio' : 'Play radio'}
                            >
                                {isBuffering ? 'BUFFER…' : isPlaying ? 'PAUSE' : 'PLAY'}
                            </button>
                            <button
                                onClick={handleStop}
                                className="px-2 py-1 text-xs border border-[#15ff00]/50 text-[#15ff00] hover:bg-[#15ff00]/10 rounded"
                                title="Stop radio"
                            >
                                STOP
                            </button>
                            {/* Volume */}
                            <div className="flex items-center gap-1 ml-1">
                                <span className="text-xs opacity-70">VOL</span>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={volume}
                                    onChange={(e) => changeVolume(Number(e.target.value))}
                                    className="radio-vol w-20 cursor-pointer bg-transparent"
                                    aria-label="Radio volume"
                                    title="Radio volume"
                                />
                            </div>
                        </div>

                        {/* Error */}
                        {error && (
                            <div className="text-red-400 text-xs">{error}</div>
                        )}
                    </div>
                </div>
            )}
            {/* Scoped styles for the custom volume slider */}
            <style>{`
                .radio-vol { 
                    -webkit-appearance: none; 
                    appearance: none; 
                    background: transparent; 
                }

                /* WebKit (Chrome, new Edge, Safari) */
                .radio-vol::-webkit-slider-runnable-track {
                    height: 4px;
                    background: rgba(21, 255, 0, 0.3);
                    border-radius: 9999px;
                }
                .radio-vol::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 12px;
                    height: 12px;
                    border-radius: 2px;
                    background: #15ff00;
                    border: 1px solid rgba(21, 255, 0, 0.9);
                    box-shadow: 0 0 8px rgba(21, 255, 0, 0.6);
                    margin-top: -4px; /* center the thumb on the 4px track */
                }
                .radio-vol:hover::-webkit-slider-thumb {
                    box-shadow: 0 0 10px rgba(21, 255, 0, 0.8);
                }
                .radio-vol:focus { outline: none; }

                /* Firefox */
                .radio-vol::-moz-range-track {
                    height: 4px;
                    background: rgba(21, 255, 0, 0.3);
                    border-radius: 9999px;
                }
                .radio-vol::-moz-range-progress {
                    height: 4px;
                    background: rgba(21, 255, 0, 0.6);
                    border-radius: 9999px;
                }
                .radio-vol::-moz-range-thumb {
                    width: 12px;
                    height: 12px;
                    border-radius: 2px;
                    background: #15ff00;
                    border: 1px solid rgba(21, 255, 0, 0.9);
                    box-shadow: 0 0 8px rgba(21, 255, 0, 0.6);
                }
            `}</style>
        </div>
    );
};

export default RadioControls;



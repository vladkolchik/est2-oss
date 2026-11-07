import React, { useState, useEffect, useRef } from 'react';
import { ttsService, NarratorState, TTSProvider, GEMINI_VOICES } from '../services/ttsService';
import { soundService } from '../services/soundService';

interface NarratorControlsProps {
    text: string;
    isEnabled: boolean;
    onToggleEnabled: () => void;
    variant?: 'default' | 'header';
    // Optional structured sequence to narrate in order (narrative + dialogues)
    sequence?: Array<{ type: 'narrative' | 'dialogue'; text: string; gender?: 'male' | 'female' | 'unknown'; speaker?: string }>
    // Unique id for current message batch to avoid interrupting with same batch
    sequenceId?: string;
}

const NarratorControls: React.FC<NarratorControlsProps> = ({ 
    text, 
    isEnabled, 
    onToggleEnabled,
    variant = 'default',
    sequence,
    sequenceId
}) => {
    const [narratorState, setNarratorState] = useState<NarratorState>({
        isPlaying: false,
        isPaused: false,
        currentAudio: null,
        currentText: '',
        provider: TTSProvider.GEMINI,
        sequenceActive: false,
        sequenceIndex: -1,
        sequenceLength: 0,
    });
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const [isAutoMode, setIsAutoMode] = useState<boolean>(() => {
        try { return localStorage.getItem('narrator-auto-mode') === '1'; } catch { return false; }
    });
    const [lastNarrated, setLastNarrated] = useState<string>('');
    const lastSequenceIdRef = useRef<string | undefined>(undefined);
    const [selectedProvider, setSelectedProvider] = useState<TTSProvider>(() => {
        try {
            const saved = localStorage.getItem('narrator-provider') as TTSProvider | null;
            return saved && Object.values(TTSProvider).includes(saved) ? saved : TTSProvider.GEMINI;
        } catch {
            return TTSProvider.GEMINI;
        }
    });

    // Initialize provider on mount
    useEffect(() => {
        ttsService.setProvider(selectedProvider);
    }, [selectedProvider]);

    // Update narrator state periodically
    useEffect(() => {
        const interval = setInterval(() => {
            setNarratorState(ttsService.getState());
        }, 100);

        return () => clearInterval(interval);
    }, []);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsDropdownOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Auto-speak when new narrative text/sequence arrives
    useEffect(() => {
        const tryAutoSpeak = async () => {
            if (!isEnabled || !isAutoMode) return;
            // If we have a structured sequence, prefer it over plain text
            if (sequence && sequence.length > 0) {
                // If the same batch ID is received, append without interrupting
                if (sequenceId && lastSequenceIdRef.current === sequenceId) {
                    try {
                        await ttsService.speakSequence(sequence.map(seg => ({
                            text: seg.text,
                            role: seg.type === 'narrative' ? 'narrator' : 'npc',
                            gender: seg.gender,
                            speaker: seg.speaker,
                        })), { provider: selectedProvider, sequenceId, appendIfSameId: true });
                        return;
                    } catch (err) {
                        // fall through to start fresh
                    }
                }
                try {
                    setIsLoading(true);
                    setError(null);
                    ttsService.stopAudio();
                    // Map to TTS segments
                    await ttsService.speakSequence(sequence.map(seg => ({
                        text: seg.text,
                        role: seg.type === 'narrative' ? 'narrator' : 'npc',
                        gender: seg.gender,
                        speaker: seg.speaker,
                    })), { provider: selectedProvider, sequenceId });
                    setLastNarrated('sequence');
                    lastSequenceIdRef.current = sequenceId;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Failed to auto narrate sequence';
                    setError(msg);
                } finally {
                    setIsLoading(false);
                }
                return;
            }

            const t = (text || '').trim();
            if (!t || t === lastNarrated) return;
            try {
                setIsLoading(true);
                setError(null);
                // Interrupt current playback and speak latest
                ttsService.stopAudio();
                await ttsService.speakText(t, { provider: selectedProvider });
                setLastNarrated(t);
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'Failed to auto narrate';
                setError(msg);
            } finally {
                setIsLoading(false);
            }
        };
        tryAutoSpeak();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [text, isEnabled, isAutoMode, JSON.stringify(sequence || [])]);

    const handleToggleAuto = () => {
        setIsAutoMode(prev => {
            const next = !prev;
            try { localStorage.setItem('narrator-auto-mode', next ? '1' : '0'); } catch {}
            return next;
        });
    };

    const handleProviderChange = (provider: TTSProvider) => {
        setSelectedProvider(provider);
        ttsService.setProvider(provider);
        try { localStorage.setItem('narrator-provider', provider); } catch {}
        console.log(`🔧 Switched to ${provider} TTS provider`);
    };

    const handlePlay = async () => {
        if (!isEnabled) return;

        setIsLoading(true);
        setError(null);

        try {
            // If currently paused, resume playback immediately
            if (narratorState.isPaused) {
                ttsService.resumeAudio();
                return;
            }
            // If we have a structured sequence, play it
            if (sequence && sequence.length > 0) {
                await ttsService.speakSequence(sequence.map(seg => ({
                    text: seg.text,
                    role: seg.type === 'narrative' ? 'narrator' : 'npc',
                    gender: seg.gender,
                    speaker: seg.speaker,
                })), { provider: selectedProvider, sequenceId });
                lastSequenceIdRef.current = sequenceId;
                return;
            }

            if (!text.trim()) return;
            await ttsService.speakText(text, { provider: selectedProvider });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to play narration';
            setError(errorMessage);
            console.error('Narrator error:', err);
        } finally {
            setIsLoading(false);
        }
    };

    const handlePause = () => {
        ttsService.pauseAudio();
    };

    const handleStop = () => {
        ttsService.stopAudio();
        setError(null);
    };

    const handleToggleNarrator = () => {
        if (narratorState.isPlaying) {
            handleStop();
        }
        onToggleEnabled();
    };

    const isHeader = variant === 'header';

    const MicrophoneIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" className="inline align-middle pointer-events-none" strokeWidth="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
    );

    const PlayIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" className="inline align-middle pointer-events-none">
            <polygon points="9,5 20,12 9,19" />
        </svg>
    );

    const PauseIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" className="inline align-middle pointer-events-none">
            <rect x="6" y="5" width="4" height="14" />
            <rect x="14" y="5" width="4" height="14" />
        </svg>
    );

    const PrevIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" className="inline align-middle pointer-events-none">
            <polygon points="10,12 18,6 18,18" />
            <rect x="6" y="6" width="2" height="12" />
        </svg>
    );

    const NextIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" className="inline align-middle pointer-events-none">
            <polygon points="14,12 6,6 6,18" />
            <rect x="16" y="6" width="2" height="12" />
        </svg>
    );

    const ChevronDownIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" className="inline align-middle pointer-events-none" strokeWidth="2">
            <polyline points="6,9 12,15 18,9"/>
        </svg>
    );

    const LoadingIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" className="inline align-middle animate-spin pointer-events-none" strokeWidth="2">
            <path d="M21 12a9 9 0 11-6.219-8.56"/>
        </svg>
    );

    const StopIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" className="inline align-middle pointer-events-none">
            <rect x="6" y="6" width="12" height="12" />
        </svg>
    );

    return (
        <div className={isHeader ? 'relative' : 'flex items-center gap-2 p-2 bg-black/30 border border-[#15ff00]/30 rounded'} ref={dropdownRef}>
            {isHeader ? (
                <>
                    {/* Dropdown Button */}
                    <button
                        onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                        onClick={() => { soundService.playUi('ui_menu_ok'); setIsDropdownOpen(!isDropdownOpen); }}
                        className={`p-2 border border-transparent hover:border-[#15ff00]/50 transition-all duration-200 flex items-center gap-1 text-lg relative z-10 ${
                            isEnabled 
                                ? 'text-[#15ff00] text-glow' 
                                : 'text-[#15ff00]/70 hover:text-[#15ff00]'
                        }`}
                        title="Narrator controls"
                    >
                        <MicrophoneIcon />
                        <span className="font-medium">NARRATOR</span>
                        <ChevronDownIcon />
                        {/* Status indicators */}
                        {isEnabled && narratorState.isPlaying && !narratorState.isPaused && (
                            <div className="w-1.5 h-1.5 bg-[#15ff00] rounded-full animate-pulse ml-1 pointer-events-none" title="Playing" />
                        )}
                        {isEnabled && narratorState.isPaused && (
                            <div className="w-1.5 h-1.5 bg-[#15ff00]/70 rounded-full ml-1 pointer-events-none" title="Paused" />
                        )}
                    </button>

                    {/* Dropdown Menu */}
                    {isDropdownOpen && (
                        <div className="absolute top-full left-0 mt-1 bg-black/95 border border-[#15ff00]/50 rounded shadow-lg backdrop-blur-sm z-50 min-w-[140px]">
                            <div className="p-1.5 space-y-1">
                                {/* Enable/Disable Toggle */}
                                <button
                                    onClick={handleToggleNarrator}
                                    className={`w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center gap-1.5 ${
                                        isEnabled
                                            ? 'bg-[#15ff00]/20 text-[#15ff00] hover:bg-[#15ff00]/30'
                                            : 'text-[#15ff00]/70 hover:bg-[#15ff00]/10 hover:text-[#15ff00]'
                                    }`}
                                >
                                    <MicrophoneIcon />
                                    <span className="text-xs">{isEnabled ? 'Disable' : 'Enable'}</span>
                                </button>

                                {/* Separator */}
                                {isEnabled && <div className="border-t border-[#15ff00]/30 my-1"></div>}

                                {/* Auto Mode */}
                                <button
                                    onClick={handleToggleAuto}
                                    className={`w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center justify-between ${
                                        isAutoMode
                                            ? 'bg-[#15ff00]/20 text-[#15ff00] hover:bg-[#15ff00]/30'
                                            : 'text-[#15ff00]/70 hover:bg-[#15ff00]/10 hover:text-[#15ff00]'
                                    }`}
                                >
                                    <span className="flex items-center gap-1.5">
                                        <span className={`inline-block w-2 h-2 rounded-full ${isAutoMode ? 'bg-[#15ff00]' : 'border border-[#15ff00]/60'}`} />
                                        <span className="text-xs">Auto mode</span>
                                    </span>
                                    <span className="text-xs opacity-80">{isAutoMode ? 'On' : 'Off'}</span>
                                </button>

                                {/* Provider Selection */}
                                <div className="space-y-0.5">
                                    <div className="px-2 py-1 text-xs text-[#15ff00]/60 font-medium">TTS Provider:</div>
                                    <button
                                        onClick={() => handleProviderChange(TTSProvider.GEMINI)}
                                        className={`w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center justify-between ${
                                            selectedProvider === TTSProvider.GEMINI
                                                ? 'bg-[#15ff00]/20 text-[#15ff00] hover:bg-[#15ff00]/30'
                                                : 'text-[#15ff00]/70 hover:bg-[#15ff00]/10 hover:text-[#15ff00]'
                                        }`}
                                    >
                                        <span className="flex items-center gap-1.5">
                                            <span className={`inline-block w-2 h-2 rounded-full ${selectedProvider === TTSProvider.GEMINI ? 'bg-[#15ff00]' : 'border border-[#15ff00]/60'}`} />
                                            <span className="text-xs">Gemini (Primary)</span>
                                        </span>
                                        {narratorState.provider === TTSProvider.GEMINI && narratorState.isPlaying && (
                                            <div className="w-1.5 h-1.5 bg-[#15ff00] rounded-full animate-pulse" />
                                        )}
                                    </button>
                                    <button
                                        onClick={() => handleProviderChange(TTSProvider.CHIRP)}
                                        className={`w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center justify-between ${
                                            selectedProvider === TTSProvider.CHIRP
                                                ? 'bg-[#15ff00]/20 text-[#15ff00] hover:bg-[#15ff00]/30'
                                                : 'text-[#15ff00]/70 hover:bg-[#15ff00]/10 hover:text-[#15ff00]'
                                        }`}
                                    >
                                        <span className="flex items-center gap-1.5">
                                            <span className={`inline-block w-2 h-2 rounded-full ${selectedProvider === TTSProvider.CHIRP ? 'bg-[#15ff00]' : 'border border-[#15ff00]/60'}`} />
                                            <span className="text-xs">Chirp 3 HD (Cloud)</span>
                                        </span>
                                        {narratorState.provider === TTSProvider.CHIRP && narratorState.isPlaying && (
                                            <div className="w-1.5 h-1.5 bg-[#15ff00] rounded-full animate-pulse" />
                                        )}
                                    </button>
                                    <button
                                        onClick={() => handleProviderChange(TTSProvider.ELEVENLABS)}
                                        className={`w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center justify-between ${
                                            selectedProvider === TTSProvider.ELEVENLABS
                                                ? 'bg-[#15ff00]/20 text-[#15ff00] hover:bg-[#15ff00]/30'
                                                : 'text-[#15ff00]/70 hover:bg-[#15ff00]/10 hover:text-[#15ff00]'
                                        }`}
                                    >
                                        <span className="flex items-center gap-1.5">
                                            <span className={`inline-block w-2 h-2 rounded-full ${selectedProvider === TTSProvider.ELEVENLABS ? 'bg-[#15ff00]' : 'border border-[#15ff00]/60'}`} />
                                            <span className="text-xs">ElevenLabs (Fallback)</span>
                                        </span>
                                        {narratorState.provider === TTSProvider.ELEVENLABS && narratorState.isPlaying && (
                                            <div className="w-1.5 h-1.5 bg-[#15ff00] rounded-full animate-pulse" />
                                        )}
                                    </button>
                                    <button
                                        onClick={() => handleProviderChange(TTSProvider.SILERO)}
                                        className={`w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center justify-between ${
                                            selectedProvider === TTSProvider.SILERO
                                                ? 'bg-[#15ff00]/20 text-[#15ff00] hover:bg-[#15ff00]/30'
                                                : 'text-[#15ff00]/70 hover:bg-[#15ff00]/10 hover:text-[#15ff00]'
                                        }`}
                                    >
                                        <span className="flex items-center gap-1.5">
                                            <span className={`inline-block w-2 h-2 rounded-full ${selectedProvider === TTSProvider.SILERO ? 'bg-[#15ff00]' : 'border border-[#15ff00]/60'}`} />
                                            <span className="text-xs">Silero (Local)</span>
                                        </span>
                                        {narratorState.provider === TTSProvider.SILERO && narratorState.isPlaying && (
                                            <div className="w-1.5 h-1.5 bg-[#15ff00] rounded-full animate-pulse" />
                                        )}
                                    </button>
                                </div>

                                {/* Audio Controls */}
                                {isEnabled && (
                                    <div className="space-y-0.5">
                                        {/* Sequence navigation */}
                                        {narratorState.sequenceActive && (
                                            <div className="w-full flex items-center justify-between px-2 py-1">
                                                <button
                                                    onClick={() => ttsService.prev()}
                                                    className="px-2 py-1 text-xs border border-[#15ff00]/50 text-[#15ff00] hover:bg-[#15ff00]/10 rounded disabled:opacity-50 disabled:cursor-not-allowed relative z-10"
                                                    disabled={narratorState.sequenceIndex <= 0 || !narratorState.currentAudio}
                                                    title="Previous segment"
                                                >
                                                    <PrevIcon />
                                                </button>
                                                <span className="text-xs opacity-80">
                                                    {Math.max(0, narratorState.sequenceIndex + 1)}/{Math.max(0, narratorState.sequenceLength)}
                                                </span>
                                                <button
                                                    onClick={() => ttsService.next()}
                                                    className="px-2 py-1 text-xs border border-[#15ff00]/50 text-[#15ff00] hover:bg-[#15ff00]/10 rounded disabled:opacity-50 disabled:cursor-not-allowed relative z-10"
                                                    disabled={narratorState.sequenceIndex < 0 || !narratorState.currentAudio || narratorState.sequenceIndex >= narratorState.sequenceLength - 1}
                                                    title="Next segment"
                                                >
                                                    <NextIcon />
                                                </button>
                                            </div>
                                        )}

                                        {/* Play Button */}
                                        <button
                                            onClick={handlePlay}
                                            disabled={isLoading || (narratorState.isPlaying && !narratorState.isPaused) || (!narratorState.isPaused && !text.trim() && !(sequence && sequence.length > 0))}
                                            className="w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center gap-1.5 text-[#15ff00] hover:bg-[#15ff00]/10 disabled:opacity-50 disabled:cursor-not-allowed relative z-10"
                                            title={
                                                isLoading 
                                                    ? 'Generating audio...' 
                                                    : (narratorState.isPlaying && !narratorState.isPaused)
                                                        ? 'Playing...'
                                                        : narratorState.isPaused 
                                                            ? 'Resume narration' 
                                                            : 'Play narration'
                                            }
                                        >
                                            {isLoading ? <LoadingIcon /> : <PlayIcon />}
                                            <span className="text-xs">{narratorState.isPaused ? 'Resume' : 'Play'}</span>
                                        </button>

                                        {/* Pause Button */}
                                        {narratorState.isPlaying && !narratorState.isPaused && (
                                            <button
                                                onClick={handlePause}
                                                className="w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center gap-1.5 text-[#15ff00] hover:bg-[#15ff00]/10 relative z-10"
                                            >
                                                <PauseIcon />
                                                <span className="text-xs">Pause</span>
                                            </button>
                                        )}

                                        {/* Stop Button */}
                                        {(narratorState.isPlaying || narratorState.isPaused) && (
                                            <button
                                                onClick={handleStop}
                                                className="w-full text-left px-2 py-1.5 rounded text-sm transition-all duration-200 flex items-center gap-1.5 text-[#15ff00] hover:bg-[#15ff00]/10 relative z-10"
                                            >
                                                <StopIcon />
                                                <span className="text-xs">Stop</span>
                                            </button>
                                        )}
                                    </div>
                                )}

                                {/* Error Display */}
                                {error && (
                                    <div className="px-2 py-1 text-red-400 text-xs border-t border-[#15ff00]/30 mt-1">
                                        ❌ {error.substring(0, 20)}...
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </>
            ) : (
                <>
                    {/* Non-header layout (unchanged) */}
                    <button
                        onClick={handleToggleNarrator}
                        className={`px-3 py-1 text-sm border rounded transition-all duration-200 relative z-10 ${
                            isEnabled
                                ? 'bg-[#15ff00]/20 border-[#15ff00] text-[#15ff00] hover:bg-[#15ff00]/30'
                                : 'bg-gray-800 border-gray-600 text-gray-400 hover:bg-gray-700'
                        }`}
                        title={isEnabled ? 'Disable narrator' : 'Enable narrator'}
                    >
                        <MicrophoneIcon />
                        NARRATOR
                    </button>

                    {/* Audio Controls */}
                    {isEnabled && (
                        <>
                            {/* Sequence navigation */}
                            {narratorState.sequenceActive && (
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => ttsService.prev()}
                                        className="px-2 py-1 text-xs bg-[#15ff00]/10 border border-[#15ff00] text-[#15ff00] hover:bg-[#15ff00]/20 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed relative z-10"
                                        title="Previous segment"
                                        disabled={narratorState.sequenceIndex <= 0 || !narratorState.currentAudio}
                                    >
                                        <PrevIcon />
                                    </button>
                                    <span className="text-xs opacity-80">
                                        {Math.max(0, narratorState.sequenceIndex + 1)}/{Math.max(0, narratorState.sequenceLength)}
                                    </span>
                                    <button
                                        onClick={() => ttsService.next()}
                                        className="px-2 py-1 text-xs bg-[#15ff00]/10 border border-[#15ff00] text-[#15ff00] hover:bg-[#15ff00]/20 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed relative z-10"
                                        title="Next segment"
                                        disabled={narratorState.sequenceIndex < 0 || !narratorState.currentAudio || narratorState.sequenceIndex >= narratorState.sequenceLength - 1}
                                    >
                                        <NextIcon />
                                    </button>
                                </div>
                            )}

                            {/* Main Control Button (Play/Loading) */}
                            <button
                                onClick={handlePlay}
                                disabled={isLoading || (narratorState.isPlaying && !narratorState.isPaused) || (!narratorState.isPaused && !text.trim() && !(sequence && sequence.length > 0))}
                                className="px-3 py-1 text-sm bg-[#15ff00]/10 border border-[#15ff00] text-[#15ff00] hover:bg-[#15ff00]/20 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed relative z-10"
                                title={
                                    isLoading 
                                        ? 'Generating audio...' 
                                        : (narratorState.isPlaying && !narratorState.isPaused)
                                            ? 'Playing...'
                                            : narratorState.isPaused 
                                                ? 'Resume narration' 
                                                : 'Play narration'
                                }
                            >
                                {isLoading ? <LoadingIcon /> : <PlayIcon />}
                            </button>

                            {/* Pause Button */}
                            {narratorState.isPlaying && !narratorState.isPaused && (
                                <button
                                    onClick={handlePause}
                                    className="px-3 py-1 text-sm bg-[#15ff00]/10 border border-[#15ff00] text-[#15ff00] hover:bg-[#15ff00]/20 transition-all duration-200 relative z-10"
                                    title="Pause narration"
                                >
                                    <PauseIcon />
                                </button>
                            )}

                            {/* Stop Button */}
                            {(narratorState.isPlaying || narratorState.isPaused) && (
                                <button
                                    onClick={handleStop}
                                    className="px-3 py-1 text-sm bg-[#15ff00]/10 border border-[#15ff00] text-[#15ff00] hover:bg-[#15ff00]/20 transition-all duration-200 relative z-10"
                                    title="Stop narration"
                                >
                                    <StopIcon />
                                </button>
                            )}

                            {/* Status Indicator */}
                            <div className="flex items-center gap-1">
                                {narratorState.isPlaying && !narratorState.isPaused && (
                                    <div className="w-2 h-2 bg-[#15ff00] rounded-full animate-pulse pointer-events-none" title="Playing" />
                                )}
                                {narratorState.isPaused && (
                                    <div className="w-2 h-2 bg-[#15ff00]/70 rounded-full pointer-events-none" title="Paused" />
                                )}
                            </div>
                        </>
                    )}
                </>
            )}

            {/* Error Display */}
            {error && !isHeader && (
                <div className="text-red-400 text-xs max-w-xs truncate" title={error}>
                    ❌ {error}
                </div>
            )}
        </div>
    );
};

export default NarratorControls;

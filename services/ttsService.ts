import { ELEVENLABS_DEFAULTS } from "../config/elevenlabs";
import { byokHeaders, canUseAnyProvider, type ByokProvider } from './byokService';
import { Howl } from 'howler';

export enum TTSProvider {
    GEMINI = 'gemini',
    ELEVENLABS = 'elevenlabs',
    CHIRP = 'chirp',
    SILERO = 'silero'
}

// Which BYOK keys can serve each paid voice (Silero is self-hosted and free).
// Gemini voices also run through OpenRouter.
const TTS_KEY_PROVIDERS: Partial<Record<TTSProvider, ByokProvider[]>> = {
    [TTSProvider.GEMINI]: ['gemini', 'openrouter'],
    [TTSProvider.ELEVENLABS]: ['elevenlabs'],
    [TTSProvider.CHIRP]: ['gcpTts'],
};

export interface TTSOptions {
    provider?: TTSProvider;
    voiceId?: string;
    modelId?: string;
    outputFormat?: string;
    voiceName?: string; // For Gemini TTS
    speaker?: string; // For Silero TTS
}

export interface NarratorState {
    isPlaying: boolean;
    isPaused: boolean;
    currentAudio: any | null;
    currentText: string;
    provider: TTSProvider;
    sequenceActive: boolean;
    sequenceIndex: number;
    sequenceLength: number;
}

export type TTSSegment = {
    text: string;
    role: 'narrator' | 'npc';
    gender?: 'male' | 'female' | 'unknown';
    speaker?: string;
};

// Gemini TTS voice options
export const GEMINI_VOICES = {
    KORE: 'Kore',
    ENCELADUS: 'Enceladus',
    AOEDE: 'Aoede',
    CHARON: 'Charon',
    ORUS: 'Orus'
} as const;

// Configuration for TTS providers
export const TTS_CONFIG = {
    // Primary provider - Gemini
    gemini: {
        model: 'gemini-2.5-flash-preview-tts',
        defaultVoice: GEMINI_VOICES.ENCELADUS,
        endpoint: '/api/gemini-tts'
    },
    // Fallback provider - ElevenLabs
    elevenlabs: {
        defaultVoiceId: ELEVENLABS_DEFAULTS.DEFAULT_VOICE_ID,
        defaultModelId: ELEVENLABS_DEFAULTS.DEFAULT_MODEL_ID,
        defaultOutputFormat: ELEVENLABS_DEFAULTS.DEFAULT_OUTPUT_FORMAT,
        endpoint: '/api/tts'
    },
    chirp: {
        defaultVoice: 'en-US-Chirp3-HD-Enceladus',
        languageCode: 'en-US',
        endpoint: '/api/chirp-tts'
    },
    // Self-hosted Silero TTS server (proxied by the backend)
    silero: {
        defaultSpeaker: 'en_0',
        sampleRate: 48000,
        endpoint: '/api/silero-tts'
    }
};

class TTSService {
    private currentAudio: Howl | null = null;
    private isPlaying = false;
    private isPaused = false;
    private currentProvider: TTSProvider = TTSProvider.GEMINI;
    private currentText = '';
    private currentAudioFormat: 'mp3' | 'wav' = 'mp3';
    private lastObjectUrl: string | null = null;
    private currentSoundId: number | null = null;
    private audioCache: Map<string, { blob: Blob; format: 'mp3' | 'wav' }> = new Map();
    private narratorVolume: number = (() => { try { return Number(localStorage.getItem('narrator-volume') || '0.8'); } catch { return 0.8; } })();
    // Sequence state
    private sequenceQueue: TTSSegment[] = [];
    private sequenceIndex = -1;
    private sequenceActive = false;
    private currentSequenceId: string | null = null;
    private sequenceUrls: string[] = [];
    private voiceProfile = {
        narrator: GEMINI_VOICES.ENCELADUS,
        male: GEMINI_VOICES.ORUS,
        female: GEMINI_VOICES.AOEDE,
        unknown: GEMINI_VOICES.CHARON,
    } as const;
    private chirpVoiceProfile = {
        narrator: 'en-US-Chirp3-HD-Enceladus',
        male: 'en-US-Chirp3-HD-Kore',
        female: 'en-US-Chirp3-HD-Aoede',
        unknown: 'en-US-Chirp3-HD-Charon',
    } as const;
    // Speaker ids depend on the model loaded in the Silero server
    // (v3_en: en_0..en_117; russian v4: aidar, baya, kseniya, xenia, eugene)
    private sileroVoiceProfile = {
        narrator: 'en_0',
        male: 'en_1',
        female: 'en_2',
        unknown: 'en_0',
    } as const;
    private elevenlabsVoiceProfile = {
        narrator: ELEVENLABS_DEFAULTS.VOICES?.NARRATOR || ELEVENLABS_DEFAULTS.DEFAULT_VOICE_ID,
        male: ELEVENLABS_DEFAULTS.VOICES?.MALE_DEEP || ELEVENLABS_DEFAULTS.DEFAULT_VOICE_ID,
        female: ELEVENLABS_DEFAULTS.VOICES?.FEMALE_SOFT || ELEVENLABS_DEFAULTS.DEFAULT_VOICE_ID,
        unknown: ELEVENLABS_DEFAULTS.VOICES?.NARRATOR || ELEVENLABS_DEFAULTS.DEFAULT_VOICE_ID,
    } as const;

    /**
     * Fallback order: the selected provider first, then the rest by default priority.
     */
    private getFallbackOrder(provider: TTSProvider): TTSProvider[] {
        const defaultOrder = [TTSProvider.GEMINI, TTSProvider.CHIRP, TTSProvider.ELEVENLABS, TTSProvider.SILERO];
        return [provider, ...defaultOrder.filter(p => p !== provider)];
    }

    private async synthesizeWith(provider: TTSProvider, text: string, options: TTSOptions = {}): Promise<string> {
        switch (provider) {
            case TTSProvider.GEMINI: return await this.geminiTTS(text, options);
            case TTSProvider.CHIRP: return await this.chirpTTS(text, options);
            case TTSProvider.SILERO: return await this.sileroTTS(text, options);
            default: return await this.elevenLabsTTS(text, options);
        }
    }

    /**
     * Convert text to speech using the specified provider, falling back to the others on failure
     */
    async textToSpeech(text: string, options: TTSOptions = {}): Promise<string> {
        const provider = options.provider || TTSProvider.GEMINI;
        let lastError: any = null;
        for (const p of this.getFallbackOrder(provider)) {
            // Skip paid voices with no usable key (BYOK) instead of burning a 401 per segment
            const keyProviders = TTS_KEY_PROVIDERS[p];
            if (keyProviders && !canUseAnyProvider(keyProviders)) continue;
            try {
                if (p !== provider) console.log(`🔄 Falling back to ${p} TTS...`);
                return await this.synthesizeWith(p, text, options);
            } catch (error) {
                console.warn(`❌ ${p} TTS failed:`, error);
                lastError = error;
            }
        }
        console.error('❌ All TTS providers failed:', lastError);
        throw new Error('All TTS providers failed. Please check your API configuration.');
    }

    /**
     * Configure voice mapping (Gemini voice names) used for sequence playback
     */
    setVoiceProfile(profile: Partial<{ narrator: string; male: string; female: string; unknown: string }>) {
        this.voiceProfile = { ...this.voiceProfile, ...profile } as typeof this.voiceProfile;
    }

    private buildCacheKey(provider: TTSProvider, meta: Record<string, string | undefined>, text: string): string {
        const normalizedText = (text || '').trim();
        const metaPart = Object.keys(meta)
            .sort()
            .map(k => `${k}:${(meta[k] || '').trim()}`)
            .join('|');
        return `${provider}|${metaPart}|t:${normalizedText}`;
    }

    /**
     * Gemini TTS implementation
     */
    private async geminiTTS(text: string, options: TTSOptions = {}): Promise<string> {
        const voiceName = options.voiceName || TTS_CONFIG.gemini.defaultVoice;
        const model = TTS_CONFIG.gemini.model;
        const cacheKey = this.buildCacheKey(TTSProvider.GEMINI, { voiceName, model }, text);
        const cached = this.audioCache.get(cacheKey);
        if (cached) {
            this.currentProvider = TTSProvider.GEMINI;
            this.currentAudioFormat = cached.format;
            return URL.createObjectURL(cached.blob);
        }
        
        console.log('🎤 Requesting Gemini TTS:', { voiceName, model });

        const response = await fetch(TTS_CONFIG.gemini.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...byokHeaders() },
            body: JSON.stringify({ text, voiceName, model }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'Gemini TTS failed');
        }

        // Receive audio and convert to blob URL
        const blob = await response.blob();
        this.audioCache.set(cacheKey, { blob, format: 'wav' });
        const audioUrl = URL.createObjectURL(blob);
        this.currentProvider = TTSProvider.GEMINI;
        this.currentAudioFormat = 'wav';
        return audioUrl;
    }

    /**
     * ElevenLabs TTS implementation (fallback)
     */
    private async elevenLabsTTS(text: string, options: TTSOptions = {}): Promise<string> {
        const voiceId = options.voiceId || TTS_CONFIG.elevenlabs.defaultVoiceId;
        const modelId = options.modelId || TTS_CONFIG.elevenlabs.defaultModelId;
        const outputFormat = options.outputFormat || TTS_CONFIG.elevenlabs.defaultOutputFormat;

        const cacheKey = this.buildCacheKey(TTSProvider.ELEVENLABS, { voiceId, modelId, outputFormat }, text);
        const cached = this.audioCache.get(cacheKey);
        if (cached) {
            this.currentProvider = TTSProvider.ELEVENLABS;
            this.currentAudioFormat = cached.format;
            return URL.createObjectURL(cached.blob);
        }

        console.log('🎤 Requesting ElevenLabs TTS:', { voiceId, modelId });

        const response = await fetch(TTS_CONFIG.elevenlabs.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...byokHeaders() },
            body: JSON.stringify({ text, voiceId, modelId, outputFormat }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'ElevenLabs TTS failed');
        }

        // Receive audio/mpeg and convert to blob URL
        const blob = await response.blob();
        this.audioCache.set(cacheKey, { blob, format: 'mp3' });
        const audioUrl = URL.createObjectURL(blob);
        this.currentProvider = TTSProvider.ELEVENLABS;
        this.currentAudioFormat = 'mp3';
        return audioUrl;
    }

    /**
     * Chirp 3 HD TTS implementation
     */
    private async chirpTTS(text: string, options: TTSOptions = {}): Promise<string> {
        const voiceName = options.voiceName || TTS_CONFIG.chirp.defaultVoice;
        const languageCode = 'en-US';

        const cacheKey = this.buildCacheKey(TTSProvider.CHIRP, { voiceName, languageCode }, text);
        const cached = this.audioCache.get(cacheKey);
        if (cached) {
            this.currentProvider = TTSProvider.CHIRP;
            this.currentAudioFormat = cached.format;
            return URL.createObjectURL(cached.blob);
        }

        const response = await fetch(TTS_CONFIG.chirp.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...byokHeaders() },
            body: JSON.stringify({ 
                text, 
                voiceName,
                languageCode
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'Chirp TTS failed');
        }

        const blob = await response.blob();
        this.audioCache.set(cacheKey, { blob, format: 'mp3' });
        const audioUrl = URL.createObjectURL(blob);
        this.currentProvider = TTSProvider.CHIRP;
        this.currentAudioFormat = 'mp3';
        return audioUrl;
    }

    /**
     * Silero TTS implementation (self-hosted, proxied by the backend)
     */
    private async sileroTTS(text: string, options: TTSOptions = {}): Promise<string> {
        const speaker = options.speaker || TTS_CONFIG.silero.defaultSpeaker;
        const sampleRate = String(TTS_CONFIG.silero.sampleRate);

        const cacheKey = this.buildCacheKey(TTSProvider.SILERO, { speaker, sampleRate }, text);
        const cached = this.audioCache.get(cacheKey);
        if (cached) {
            this.currentProvider = TTSProvider.SILERO;
            this.currentAudioFormat = cached.format;
            return URL.createObjectURL(cached.blob);
        }

        console.log('🎤 Requesting Silero TTS:', { speaker });

        const response = await fetch(TTS_CONFIG.silero.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, speaker, sampleRate: TTS_CONFIG.silero.sampleRate }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'Silero TTS failed');
        }

        const blob = await response.blob();
        this.audioCache.set(cacheKey, { blob, format: 'wav' });
        const audioUrl = URL.createObjectURL(blob);
        this.currentProvider = TTSProvider.SILERO;
        this.currentAudioFormat = 'wav';
        return audioUrl;
    }

    /**
     * Play audio from URL using Howler
     */
    async playAudio(audioUrl: string): Promise<void> {
        try {
            // Stop any currently playing audio
            this.stopAudio();

            this.lastObjectUrl = audioUrl;
            const sound = new Howl({
                src: [audioUrl],
                html5: true,
                format: [this.currentAudioFormat],
                volume: this.narratorVolume,
                onend: () => {
                    this.isPlaying = false;
                    this.isPaused = false;
                    this.currentAudio = null;
                    this.currentSoundId = null;
                    this.currentText = '';
                    try { if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl); } catch {}
                    this.lastObjectUrl = null;
                },
                onloaderror: (_id, error) => {
                    console.error('❌ Audio load error:', error);
                },
                onplayerror: (_id, error) => {
                    console.error('❌ Audio play error:', error);
                }
            });
            this.currentAudio = sound;
            this.isPlaying = true;
            this.isPaused = false;
            this.currentSoundId = sound.play();
            console.log('🔊 Audio playback started (Howler)');
        } catch (error) {
            console.error('❌ Failed to play audio:', error);
            this.isPlaying = false;
            this.isPaused = false;
            this.currentAudio = null;
            this.currentText = '';
            throw error;
        }
    }

    /**
     * Speak a sequence of segments (narrator + NPCs) preserving order
     */
    async speakSequence(segments: TTSSegment[], options: { provider?: TTSProvider; sequenceId?: string; appendIfSameId?: boolean } = {}): Promise<void> {
        const provider = options.provider || this.currentProvider;
        this.currentProvider = provider;
        const incomingId = options.sequenceId || `seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // If same sequence is currently active, append to queue without interrupting
        if (this.sequenceActive && this.currentSequenceId === incomingId && options.appendIfSameId !== false) {
            const toAppend = segments.filter(s => s && s.text && s.text.trim().length > 0);
            if (toAppend.length === 0) return;
            // Prefetch URLs for appended segments
            const newUrls = await Promise.all(toAppend.map(seg => this.generateAudioUrlForSegment(seg, provider)));
            this.sequenceQueue.push(...toAppend);
            this.sequenceUrls.push(...newUrls);
            // Do not interrupt; current 'ended' handler will pick these up
            return;
        }

        // Otherwise, start a new sequence
        this.stopAudio();
        this.sequenceQueue = segments.filter(s => s && s.text && s.text.trim().length > 0);
        this.sequenceIndex = -1;
        this.sequenceActive = this.sequenceQueue.length > 0;
        this.currentSequenceId = incomingId;
        if (!this.sequenceActive) return;
        // Prefetch all segment URLs concurrently
        this.sequenceUrls = await Promise.all(this.sequenceQueue.map(seg => this.generateAudioUrlForSegment(seg, provider)));

        const playNext = async () => {
            this.sequenceIndex += 1;
            if (this.sequenceIndex >= this.sequenceQueue.length) {
                // Sequence finished
                this.sequenceActive = false;
                this.isPlaying = false;
                this.isPaused = false;
                this.currentText = '';
                this.currentSequenceId = null;
                return;
            }
            const seg = this.sequenceQueue[this.sequenceIndex];
            this.currentText = seg.text;
            const audioUrl = this.sequenceUrls[this.sequenceIndex];

            // Play with Howler and chain to next on end/error
            try {
                if (this.currentAudio) {
                    try { this.currentAudio.stop(); } catch {}
                    try { this.currentAudio.unload(); } catch {}
                }
                this.lastObjectUrl = audioUrl;
                const sound = new Howl({
                    src: [audioUrl],
                    html5: true,
                    format: [this.currentAudioFormat],
                    volume: this.narratorVolume,
                    onend: async () => {
                        try { if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl); } catch {}
                        this.lastObjectUrl = null;
                        this.currentSoundId = null;
                        await playNext();
                    },
                    onloaderror: async (_id, error) => {
                        console.warn('Audio load error on segment, skipping:', error);
                        try { if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl); } catch {}
                        this.lastObjectUrl = null;
                        this.currentSoundId = null;
                        await playNext();
                    },
                    onplayerror: async (_id, error) => {
                        console.warn('Audio play error on segment, skipping:', error);
                        try { if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl); } catch {}
                        this.lastObjectUrl = null;
                        this.currentSoundId = null;
                        await playNext();
                    }
                });
                this.currentAudio = sound;
                this.isPlaying = true;
                this.isPaused = false;
                this.currentSoundId = sound.play();
            } catch (e) {
                console.error('Failed to play segment, skipping:', e);
                try { if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl); } catch {}
                this.lastObjectUrl = null;
                this.currentSoundId = null;
                await playNext();
            }
        };

        await playNext();
    }

    /** Jump to a specific segment index in the active sequence */
    async jumpTo(index: number): Promise<void> {
        if (!this.sequenceActive) return;
        const bounded = Math.max(0, Math.min(index, this.sequenceQueue.length - 1));
        this.sequenceIndex = bounded - 1; // playNext will ++ to bounded
        // Stop current sound and trigger next
        if (this.currentAudio) {
            try { this.currentAudio.stop(); } catch {}
            try { this.currentAudio.unload(); } catch {}
            this.currentAudio = null;
        }
        // Reuse current provider and urls
        const provider = this.currentProvider;
        const playNext = async () => {
            this.sequenceIndex += 1;
            if (this.sequenceIndex >= this.sequenceQueue.length) {
                this.sequenceActive = false;
                this.isPlaying = false;
                this.isPaused = false;
                this.currentText = '';
                this.currentSequenceId = null;
                return;
            }
            const seg = this.sequenceQueue[this.sequenceIndex];
            this.currentText = seg.text;
            const audioUrl = this.sequenceUrls[this.sequenceIndex];
            try {
                this.lastObjectUrl = audioUrl;
                const sound = new Howl({
                    src: [audioUrl], html5: true, format: [this.currentAudioFormat], volume: this.narratorVolume,
                    onend: async () => { try { if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl); } catch {} this.lastObjectUrl = null; this.currentSoundId = null; await playNext(); },
                    onloaderror: async () => { try { if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl); } catch {} this.lastObjectUrl = null; this.currentSoundId = null; await playNext(); },
                    onplayerror: async () => { try { if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl); } catch {} this.lastObjectUrl = null; this.currentSoundId = null; await playNext(); },
                });
                this.currentAudio = sound;
                this.isPlaying = true;
                this.isPaused = false;
                this.currentSoundId = sound.play();
            } catch (e) {
                this.currentSoundId = null; await playNext();
            }
        };
        await playNext();
    }

    /** Previous segment in sequence */
    async prev(): Promise<void> { await this.jumpTo(this.sequenceIndex - 1); }
    /** Next segment in sequence */
    async next(): Promise<void> { await this.jumpTo(this.sequenceIndex + 1); }

    /**
     * Generate audio URL for a segment with per-provider mapping and robust fallback.
     */
    private async generateAudioUrlForSegment(seg: TTSSegment, provider: TTSProvider): Promise<string> {
        const roleKey: 'narrator' | 'male' | 'female' | 'unknown' = seg.role === 'narrator'
            ? 'narrator'
            : seg.gender === 'male'
                ? 'male'
                : seg.gender === 'female'
                    ? 'female'
                    : 'unknown';

        const providers = this.getFallbackOrder(provider);
        let lastError: any = null;
        for (const p of providers) {
            try {
                if (p === TTSProvider.GEMINI) {
                    return await this.geminiTTS(seg.text, { voiceName: this.voiceProfile[roleKey] });
                }
                if (p === TTSProvider.CHIRP) {
                    return await this.chirpTTS(seg.text, { voiceName: this.chirpVoiceProfile[roleKey] });
                }
                if (p === TTSProvider.SILERO) {
                    return await this.sileroTTS(seg.text, { speaker: this.sileroVoiceProfile[roleKey] });
                }
                // ElevenLabs
                return await this.elevenLabsTTS(seg.text, { voiceId: this.elevenlabsVoiceProfile[roleKey] });
            } catch (e) {
                lastError = e;
                continue;
            }
        }
        throw lastError || new Error('All TTS providers failed for segment');
    }

    /**
     * Pause current audio
     */
    pauseAudio(): void {
        if (this.currentAudio && this.isPlaying && !this.isPaused) {
            try {
                if (this.currentSoundId != null) {
                    this.currentAudio.pause(this.currentSoundId);
                } else {
                    this.currentAudio.pause();
                }
            } catch {}
            this.isPaused = true;
            console.log('⏸️ Audio paused');
        }
    }

    /**
     * Resume paused audio
     */
    resumeAudio(): void {
        if (this.currentAudio && this.isPaused) {
            try {
                // Howler returns a sound id on play(); resume needs that id
                if (this.currentSoundId != null) {
                    this.currentAudio.play(this.currentSoundId);
                } else {
                    this.currentSoundId = this.currentAudio.play();
                }
            } catch {}
            this.isPaused = false;
            console.log('▶️ Audio resumed');
        }
    }

    /**
     * Stop current audio
     */
    stopAudio(): void {
        if (this.currentAudio) {
            try { this.currentAudio.stop(); } catch {}
            try { this.currentAudio.unload(); } catch {}
            this.currentAudio = null;
        }
        // Reset sequence state
        this.sequenceQueue = [];
        this.sequenceIndex = -1;
        this.sequenceActive = false;
        this.isPlaying = false;
        this.isPaused = false;
        this.currentText = '';
        try { if (this.lastObjectUrl) URL.revokeObjectURL(this.lastObjectUrl); } catch {}
        this.lastObjectUrl = null;
        this.currentSoundId = null;
        console.log('⏹️ Audio stopped');
    }

    /**
     * Clear in-memory TTS cache (call on new action/start)
     */
    clearCache(): void {
        this.audioCache.clear();
        console.log('🧹 TTS cache cleared');
    }

    /**
     * Get current narrator state
     */
    getState(): NarratorState {
        return {
            isPlaying: this.isPlaying,
            isPaused: this.isPaused,
            currentAudio: this.currentAudio,
            currentText: this.currentText,
            provider: this.currentProvider,
            sequenceActive: this.sequenceActive,
            sequenceIndex: this.sequenceIndex,
            sequenceLength: this.sequenceQueue.length,
        };
    }

    /**
     * Convert text to speech and play it immediately
     */
    async speakText(text: string, options: TTSOptions = {}): Promise<void> {
        try {
            this.currentText = text;
            const audioUrl = await this.textToSpeech(text, options);
            await this.playAudio(audioUrl);
        } catch (error) {
            console.error('❌ Failed to speak text:', error);
            this.currentText = '';
            throw error;
        }
    }

    /** Set narrator volume (0..1) and persist */
    setNarratorVolume(volume: number): void {
        const v = Math.max(0, Math.min(1, Number(volume)));
        this.narratorVolume = v;
        try { localStorage.setItem('narrator-volume', String(v)); } catch {}
        if (this.currentAudio) {
            try { this.currentAudio.volume(v); } catch {}
        }
        console.log('🔊 Narrator volume set to', v);
    }

    /** Get narrator volume */
    getNarratorVolume(): number {
        return this.narratorVolume;
    }

    /**
     * Set the preferred TTS provider
     */
    setProvider(provider: TTSProvider): void {
        this.currentProvider = provider;
        console.log(`🔧 TTS provider set to: ${provider}`);
    }

    /**
     * Get current TTS provider
     */
    getProvider(): TTSProvider {
        return this.currentProvider;
    }
}

// Export singleton instance
export const ttsService = new TTSService();
export default ttsService;

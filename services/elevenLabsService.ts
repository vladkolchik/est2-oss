import { ELEVENLABS_DEFAULTS } from "../config/elevenlabs";
import { byokHeaders } from './byokService';

// Default voice/model settings (client-safe; no API key on client)
const DEFAULT_VOICE_ID = ELEVENLABS_DEFAULTS.DEFAULT_VOICE_ID;
const DEFAULT_MODEL_ID = ELEVENLABS_DEFAULTS.DEFAULT_MODEL_ID;

export interface TTSOptions {
    voiceId?: string;
    modelId?: string;
    outputFormat?: string;
}

export interface NarratorState {
    isPlaying: boolean;
    isPaused: boolean;
    currentAudio: HTMLAudioElement | null;
    currentText: string;
}

class ElevenLabsService {
    private currentAudio: HTMLAudioElement | null = null;
    private isPlaying = false;
    private isPaused = false;

    /**
     * Convert text to speech and return audio URL
     */
    async textToSpeech(text: string, options: TTSOptions = {}): Promise<string> {
        try {
            const voiceId = options.voiceId || DEFAULT_VOICE_ID;
            const modelId = options.modelId || DEFAULT_MODEL_ID;
            const outputFormat = options.outputFormat || ELEVENLABS_DEFAULTS.DEFAULT_OUTPUT_FORMAT;

            console.log('🎤 Requesting TTS from backend:', { voiceId, modelId });

            const response = await fetch(`/api/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...byokHeaders() },
                body: JSON.stringify({ text, voiceId, modelId, outputFormat }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || 'Backend TTS proxy failed');
            }

            // Receive audio/mpeg and convert to blob URL
            const blob = await response.blob();
            const audioUrl = URL.createObjectURL(blob);
            return audioUrl;
        } catch (error) {
            console.error('❌ Text-to-speech via backend failed:', error);
            throw new Error(`Failed to convert text to speech: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Play audio from URL
     */
    async playAudio(audioUrl: string): Promise<void> {
        try {
            // Stop any currently playing audio
            this.stopAudio();

            const audio = new Audio(audioUrl);
            this.currentAudio = audio;
            this.isPlaying = true;
            this.isPaused = false;

            // Set up event listeners
            audio.addEventListener('ended', () => {
                this.isPlaying = false;
                this.isPaused = false;
                this.currentAudio = null;
                URL.revokeObjectURL(audioUrl); // Clean up the blob URL
            });

            audio.addEventListener('error', (error) => {
                console.error('❌ Audio playback error:', error);
                this.isPlaying = false;
                this.isPaused = false;
                this.currentAudio = null;
            });

            await audio.play();
            console.log('🔊 Audio playback started');
        } catch (error) {
            console.error('❌ Failed to play audio:', error);
            this.isPlaying = false;
            this.isPaused = false;
            this.currentAudio = null;
            throw error;
        }
    }

    /**
     * Pause current audio
     */
    pauseAudio(): void {
        if (this.currentAudio && this.isPlaying && !this.isPaused) {
            this.currentAudio.pause();
            this.isPaused = true;
            console.log('⏸️ Audio paused');
        }
    }

    /**
     * Resume paused audio
     */
    resumeAudio(): void {
        if (this.currentAudio && this.isPaused) {
            this.currentAudio.play();
            this.isPaused = false;
            console.log('▶️ Audio resumed');
        }
    }

    /**
     * Stop current audio
     */
    stopAudio(): void {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
            this.currentAudio = null;
        }
        this.isPlaying = false;
        this.isPaused = false;
        console.log('⏹️ Audio stopped');
    }

    /**
     * Get current narrator state
     */
    getState(): NarratorState {
        return {
            isPlaying: this.isPlaying,
            isPaused: this.isPaused,
            currentAudio: this.currentAudio,
            currentText: '', // This would need to be tracked separately if needed
        };
    }

    /**
     * Convert text to speech and play it immediately
     */
    async speakText(text: string, options: TTSOptions = {}): Promise<void> {
        try {
            const audioUrl = await this.textToSpeech(text, options);
            await this.playAudio(audioUrl);
        } catch (error) {
            console.error('❌ Failed to speak text:', error);
            throw error;
        }
    }
}

// Export singleton instance
export const elevenLabsService = new ElevenLabsService();
export default elevenLabsService;

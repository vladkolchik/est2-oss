# 🎤 Narrator Feature Setup Guide

This guide covers the text-to-speech narrator in EST2.

## TTS Providers

The narrator supports four providers, selectable in the NARRATOR dropdown in the game header. On failure they fall back in order: Gemini -> Chirp 3 HD -> ElevenLabs -> Silero.

| Provider | Model / voices | Setup |
|---|---|---|
| Gemini (primary) | `gemini-2.5-flash-preview-tts`, voices Enceladus/Orus/Aoede/Charon | `GEMINI_API_KEY` in `backend/.env` |
| Chirp 3 HD | `en-US-Chirp3-HD-*` (Google Cloud TTS) | `GCP_TTS_API_KEY` in `backend/.env` |
| ElevenLabs | `eleven_multilingual_v2`, voice IDs in `config/elevenlabs.ts` | `ELEVENLABS_API_KEY` in `backend/.env` (see below) |
| Silero (local, free) | `v3_en` / `v4_ru` / ..., speakers like `en_0` or `aidar` | auto-provisioned — see below |

### Silero (self-hosted, auto-provisioned)

The backend starts a local Silero server automatically (`SILERO_AUTOSTART=true` by default). First start requires Python 3.9+ on PATH and takes a few minutes: it creates `backend/.silero/venv`, installs CPU-only PyTorch (one-time, ~1.5-2 GB on disk) and downloads the model (~60-150 MB). Subsequent starts take seconds. Synthesis runs in real time on CPU.

Configuration in `backend/.env`: `SILERO_MODEL` (default `v3_en`), `SILERO_SPEAKER` (default `en_0`; for `v4_ru` use `aidar`, `baya`, `kseniya`, `xenia`, `eugene`), `SILERO_PORT`, `SILERO_THREADS`. Per-role voices (narrator / male NPC / female NPC) are mapped in `sileroVoiceProfile` in `services/ttsService.ts`. To use an external Silero server instead, set `SILERO_TTS_URL`.

## Overview (ElevenLabs setup)

The rest of this guide covers ElevenLabs configuration — high-quality cloud voices used as one of the fallback providers.

## Features

- **Text-to-Speech**: Converts narrative text to natural-sounding speech
- **Audio Controls**: Play, pause, resume, and stop narration
- **Visual Indicators**: Shows playing/paused status with animated indicators
- **Error Handling**: Displays helpful error messages if TTS fails
- **Configurable Voices**: Easy to change narrator voice and settings

## Setup Instructions

### 1. Get ElevenLabs API Key

1. Visit [ElevenLabs](https://elevenlabs.io/)
2. Sign up for an account (free tier available)
3. Go to [API Keys](https://elevenlabs.io/app/settings/api-keys)
4. Create a new API key
5. Copy your API key

### 2. Configure API Key (Server-side only)

Set a server environment variable (do not expose to client):

- Name: `ELEVENLABS_API_KEY`
- Where:
  - Local dev: `backend/.env` (loaded by `backend/index.js` via `dotenv`)
  - Docker Compose / Coolify: the `.env` next to `compose.yaml` or the resource's Environment Variables
  - Players can also enter their own key in the API KEYS dialog (BYOK)

The frontend no longer uses `VITE_ELEVENLABS_API_KEY`. All TTS requests go through `/api/tts` on the backend, keeping the key private.

### 3. Install Dependencies

The ElevenLabs library is already installed. If you need to reinstall:

```bash
npm install @elevenlabs/elevenlabs-js
```

### 4. Test the Feature

1. Start your development server: `npm run dev`
2. Start a new game or load an existing save
3. Look for the narrator controls in the story display area
4. Click the "🎤 Narrator" button to enable narration
5. Click the play button (🔊) to hear the latest narrative text

## Usage

### Narrator Controls

The narrator controls appear at the top of the story display:

- **🎤 Narrator**: Toggle narrator on/off
- **🔊 Play**: Start playing the latest narrative text
- **⏸️ Pause**: Pause current narration
- **▶️ Resume**: Resume paused narration
- **⏹️ Stop**: Stop current narration
- **Status Indicator**: Green pulsing dot = playing, Yellow dot = paused

### How It Works

1. The narrator automatically extracts the latest narrative text from the story history
2. When you click play, it converts the text to speech using ElevenLabs
3. The audio plays through your browser's audio system
4. You can control playback with the audio controls

## Customization

### Changing the Narrator Voice

1. Open `config/elevenlabs.ts`
2. Modify the `VOICES` object:
   ```typescript
   VOICES: {
       NARRATOR: 'your_preferred_voice_id_here',
       // ... other voices
   }
   ```

### Available Voices

You can find available voices by:
1. Visiting [ElevenLabs Voice Library](https://elevenlabs.io/voice-library)
2. Copying the voice ID from any voice you like
3. Updating the configuration

### Changing Voice Settings

In `config/elevenlabs.ts`, you can modify:
- `DEFAULT_MODEL_ID`: The AI model used for speech generation
- `DEFAULT_OUTPUT_FORMAT`: Audio quality and format
- `DEFAULT_VOICE_ID`: The default narrator voice

## Troubleshooting

### Common Issues

1. **"API key not configured" error**
   - Make sure you've set your API key in `config/elevenlabs.ts` or as `VITE_ELEVENLABS_API_KEY`
   - Check that the API key is correct and active

2. **"Failed to convert text to speech" error**
   - Check your internet connection
   - Verify your ElevenLabs account has remaining credits
   - Try a shorter text to test

3. **Audio not playing**
   - Check browser audio permissions
   - Ensure your system volume is up
   - Try refreshing the page

4. **Slow audio generation**
   - This is normal for the first request
   - Subsequent requests should be faster
   - Consider using shorter text chunks

### Debug Mode

Enable debug logging by opening browser developer tools (F12) and checking the console for detailed error messages.

## API Usage and Costs

- ElevenLabs offers a free tier with limited characters per month
- Check your usage at [ElevenLabs Usage](https://elevenlabs.io/app/settings/usage)
- Consider implementing text chunking for very long narratives to optimize costs

## Security Notes

- Never commit your actual API key to version control
- Use environment variables for production deployments
- The `.env` file is already in `.gitignore` to prevent accidental commits

## Support

If you encounter issues:
1. Check the browser console for error messages
2. Verify your ElevenLabs account status
3. Test with a simple text like "Hello world" to isolate issues

---

Enjoy your new narrator feature! 🎮🎤

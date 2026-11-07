require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
const { getNextGameState, generateImage } = require('./geminiService');
const { generateSceneDescriptor } = require('./artistService');
const supabaseWorldService = require('./supabaseWorldService');
const sileroManager = require('./sileroManager');
const byok = require('./byok');
const openrouterClient = require('./openrouterClient');

const app = express();
const port = process.env.PORT || 3001; // Port for the backend server

let servicesInitPromise = null;
let servicesInitDone = false;
let servicesInitError = null;

async function initializeMemoryServices() {
  try {
    console.log('Initializing memory services...');
    await supabaseWorldService.init();
    console.log('Memory services initialized successfully');
  } catch (error) {
    servicesInitError = error;
    console.error('Failed to initialize memory services:', error);
    // The app can still run without memory service
  } finally {
    servicesInitDone = true;
  }
}

function ensureServicesInitializationStarted() {
  if (!servicesInitPromise) {
    servicesInitPromise = initializeMemoryServices();
  }
  return servicesInitPromise;
}

async function waitForServicesInitialization() {
  if (servicesInitDone) return;

  const maxWaitMs = Number(process.env.SERVICES_INIT_MAX_WAIT_MS || 45000);
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), maxWaitMs));
  const result = await Promise.race([
    ensureServicesInitializationStarted().then(() => 'done'),
    timeoutPromise
  ]);

  if (result === 'timeout') {
    throw new Error(`Memory services initialization timeout after ${maxWaitMs}ms`);
  }
}

// Initialize memory services on startup
ensureServicesInitializationStarted();

// Auto-provision the local Silero TTS server (non-blocking; first run installs deps)
sileroManager.ensureStarted().catch((err) => {
  console.warn('Silero autostart failed:', err?.message || err);
});

// Middleware
app.use(cors({ exposedHeaders: ['x-session-id', 'x-byok-warnings'] })); // Allow requests from the frontend (running on a different port)
app.use(express.json({ limit: '50mb' })); // Allow the server to parse JSON request bodies, with a higher limit for game state
// BYOK: players' own provider keys from x-byok-* headers, scoped to the request (after the body parser)
app.use(byok.middleware);

// Which providers have a usable server key and whether players must bring their own
app.get('/api/byok/status', (req, res) => {
  res.json(byok.publicStatus());
});

// Main route for handling player actions
app.post('/api/action', async (req, res) => {
  try {
    try {
      await waitForServicesInitialization();
    } catch (initWaitError) {
      return res.status(503).json({
        error: 'Server is still initializing memory services. Please retry in a few seconds.',
        details: initWaitError?.message || String(initWaitError)
      });
    }

    const { currentState, playerAction, mentions } = req.body;
    const headerSessionId = req.headers['x-session-id'];
    const bodySessionId = currentState && currentState.sessionId ? currentState.sessionId : undefined;
    let sessionId = (typeof headerSessionId === 'string' && headerSessionId.trim()) ? headerSessionId.trim() : bodySessionId;
    if (!sessionId) {
      sessionId = randomUUID();
    }

    if (!currentState || !playerAction) {
      return res.status(400).json({ error: 'Missing currentState or playerAction in the request body.' });
    }

    const normalizedMentions = Array.from(
      new Set(
        (Array.isArray(mentions) ? mentions : [])
          .map((m) => String(m || '').trim())
          .filter(Boolean)
      )
    ).slice(0, 12);

    const gmResult = await getNextGameState(currentState, playerAction, sessionId, normalizedMentions);
    const nextState = gmResult?.nextState || gmResult;
    const contextArtifacts = gmResult?.contextArtifacts || null;

    // World memory (Postgres + GraphRAG): turns/events/entities/memories/embeddings
    if (supabaseWorldService.enabled) {
      await supabaseWorldService.recordTurn(sessionId, currentState, playerAction, nextState, {
        mentions: normalizedMentions,
        turnArtifacts: contextArtifacts
      });
    }

    // Expose session id to client
    res.setHeader('x-session-id', sessionId);
    const byokWarnings = byok.getWarnings();
    if (byokWarnings.length) res.setHeader('x-byok-warnings', byokWarnings.join(','));
    try { nextState.sessionId = sessionId; } catch (_) {}
    res.json(nextState);
  } catch (error) {
    if (byok.sendError(res, error)) return;
    console.error('Error in /api/action:', error);
    res.status(500).json({ error: 'A critical error occurred while processing the player action on the server.' });
  }
});

// Route for generating images
app.post('/api/generate-image', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Missing prompt for image generation.' });
        }
        const imageUrl = await generateImage(prompt);
        res.json({ imageUrl });
    } catch (error) {
        if (byok.sendError(res, error, 'gemini')) return;
        console.error('Error in /api/generate-image:', error);
        res.status(500).json({ error: 'The server failed to generate the requested image.' });
    }
});

// Scene descriptor for the parametric renderer — produced by the "artist" agent
// (a separate light-tier LLM call, so the GM model's context stays clean)
app.post('/api/scene-descriptor', async (req, res) => {
    try {
        const { description, locationName, ambience } = req.body || {};
        if (!description || typeof description !== 'string' || !description.trim()) {
            return res.status(400).json({ error: 'Missing description for scene descriptor.' });
        }
        const descriptor = await generateSceneDescriptor({ description, locationName, ambience });
        res.json({ descriptor });
    } catch (error) {
        if (byok.sendError(res, error)) return;
        console.error('Error in /api/scene-descriptor:', error);
        res.status(500).json({ error: 'The artist agent failed to produce a scene descriptor.' });
    }
});

// ElevenLabs Text-to-Speech proxy (keeps API key server-side)
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voiceId, modelId, outputFormat } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Missing or invalid text for TTS.' });
    }

    const apiKey = byok.getKey('elevenlabs');
    if (!apiKey) {
      if (byok.isRequired()) return byok.sendError(res, new byok.ByokError('byok_key_required', 'elevenlabs', 'ElevenLabs API key required. Add your own key in API KEYS.'));
      return res.status(500).json({ error: 'Server is not configured with ELEVENLABS_API_KEY.' });
    }

    // Defaults can be overridden per-request
    const resolvedVoiceId = (typeof voiceId === 'string' && voiceId.trim()) ? voiceId.trim() : '2v1vte5HUbhYR9ZYNAMo';
    const resolvedModelId = (typeof modelId === 'string' && modelId.trim()) ? modelId.trim() : 'eleven_multilingual_v2';
    const resolvedOutputFormat = (typeof outputFormat === 'string' && outputFormat.trim()) ? outputFormat.trim() : 'mp3_44100_128';

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoiceId}?output_format=${encodeURIComponent(resolvedOutputFormat)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'accept': 'audio/mpeg',
        'content-type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: resolvedModelId,
      }),
    });

    if (!response.ok) {
      // Try to parse error body; if not JSON, forward text
      let errPayload;
      try { errPayload = await response.json(); } catch (_) { errPayload = { message: await response.text() }; }
      const status = response.status || 502;
      if ((status === 401 || status === 403) && byok.getUserKey('elevenlabs')) {
        return byok.sendError(res, Object.assign(new Error('ElevenLabs auth failed'), { status }), 'elevenlabs');
      }
      return res.status(status).json({ error: 'ElevenLabs TTS failed', details: errPayload });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    // Stream response to client
    const { Readable } = require('stream');
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);
  } catch (error) {
    console.error('Error in /api/tts:', error);
    res.status(500).json({ error: 'Server error while generating TTS.' });
  }
});

// Helper: wrap PCM in a minimal WAV header
function pcmToWav(pcm, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const wavBuffer = Buffer.alloc(44 + pcm.length);
  let offset = 0;
  wavBuffer.write('RIFF', offset); offset += 4;
  wavBuffer.writeUInt32LE(36 + pcm.length, offset); offset += 4; // file size - 8
  wavBuffer.write('WAVE', offset); offset += 4;
  wavBuffer.write('fmt ', offset); offset += 4;
  wavBuffer.writeUInt32LE(16, offset); offset += 4; // PCM chunk size
  wavBuffer.writeUInt16LE(1, offset); offset += 2;  // PCM format
  wavBuffer.writeUInt16LE(numChannels, offset); offset += 2;
  wavBuffer.writeUInt32LE(sampleRate, offset); offset += 4;
  wavBuffer.writeUInt32LE(byteRate, offset); offset += 4;
  wavBuffer.writeUInt16LE(blockAlign, offset); offset += 2;
  wavBuffer.writeUInt16LE(bitsPerSample, offset); offset += 2;
  wavBuffer.write('data', offset); offset += 4;
  wavBuffer.writeUInt32LE(pcm.length, offset); offset += 4;
  pcm.copy(wavBuffer, offset);
  return wavBuffer;
}

// Gemini Text-to-Speech endpoint (primary TTS provider): Gemini API directly, or the same
// Gemini voices through OpenRouter (/audio/speech) when only an OpenRouter key is available.
app.post('/api/gemini-tts', async (req, res) => {
  try {
    const { text, voiceName, model } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Missing or invalid text for TTS.' });
    }

    const ttsProvider = byok.pickProvider(['gemini', 'openrouter']);
    if (!ttsProvider) {
      if (byok.isRequired()) return byok.sendError(res, new byok.ByokError('byok_key_required', 'gemini', 'Gemini voice needs a Gemini or OpenRouter API key. Add your own key in API KEYS.'));
      return res.status(500).json({ error: 'Server is not configured with GEMINI_API_KEY or OPENROUTER_API_KEY.' });
    }

    // Defaults
    const resolvedVoiceName = (typeof voiceName === 'string' && voiceName.trim()) ? voiceName.trim() : 'Enceladus';

    if (ttsProvider === 'openrouter') {
      try {
        const pcm = await openrouterClient.synthesizeSpeech(text, { voice: resolvedVoiceName });
        const wav = pcmToWav(pcm, 24000, 1, 16);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', wav.length);
        return res.send(wav);
      } catch (error) {
        if (byok.sendError(res, error, 'openrouter')) return;
        console.error('OpenRouter TTS failed:', error?.message || error);
        return res.status(502).json({ error: 'Gemini TTS via OpenRouter failed' });
      }
    }
    const apiKey = byok.getKey('gemini');
    const resolvedModel = (typeof model === 'string' && model.trim()) ? model.trim() : 'gemini-2.5-flash-preview-tts';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent`;

    const requestBody = {
      contents: [{
        parts: [{
          text: text
        }]
      }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: resolvedVoiceName
            }
          }
        }
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errPayload;
      try { 
        errPayload = await response.json(); 
      } catch (_) { 
        errPayload = { message: await response.text() }; 
      }
      const status = response.status || 502;
      if (byok.getUserKey('gemini') && byok.sendError(res, Object.assign(new Error(errPayload?.error?.message || 'Gemini TTS failed'), { status }), 'gemini')) return;
      return res.status(status).json({ error: 'Gemini TTS failed', details: errPayload });
    }

    const jsonResponse = await response.json();
    
    // Extract the audio data from Gemini response
    const audioData = jsonResponse?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    
    if (!audioData) {
      return res.status(500).json({ error: 'No audio data received from Gemini TTS' });
    }

    // Convert base64 to binary audio data (PCM 16-bit, 24kHz, mono)
    const pcmBuffer = Buffer.from(audioData, 'base64');


    const wavBuffer = pcmToWav(pcmBuffer, 24000, 1, 16);

    // Set appropriate headers for audio response
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', wavBuffer.length);
    
    // Send the audio data
    res.send(wavBuffer);
    
  } catch (error) {
    console.error('Error in /api/gemini-tts:', error);
    res.status(500).json({ error: 'Server error while generating Gemini TTS.' });
  }
});

// Chirp 3 HD Text-to-Speech (Google Cloud Text-to-Speech)
app.post('/api/chirp-tts', async (req, res) => {
  try {
    const { text, voiceName, languageCode } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Missing or invalid text for TTS.' });
    }

    // Voice defaults: Enceladus everywhere
    const resolvedLanguage = (typeof languageCode === 'string' && languageCode.trim()) ? languageCode.trim() : 'en-US';
    const resolvedVoice = (typeof voiceName === 'string' && voiceName.trim()) ? voiceName.trim() : 'en-US-Chirp3-HD-Enceladus';

    // Use API key auth (no service account)
    const apiKey = byok.getKey('gcpTts');
    if (!apiKey) {
      if (byok.isRequired()) return byok.sendError(res, new byok.ByokError('byok_key_required', 'gcpTts', 'Google Cloud TTS API key required. Add your own key in API KEYS.'));
      return res.status(500).json({ error: 'Server is not configured with GCP_TTS_API_KEY (Cloud TTS API key).' });
    }

    // Key goes in a header, not the URL, so it never lands in proxy or error logs
    const ttsUrl = 'https://texttospeech.googleapis.com/v1beta1/text:synthesize';
    const requestBody = {
      input: { text },
      voice: {
        languageCode: resolvedLanguage,
        name: resolvedVoice
      },
      audioConfig: {
        audioEncoding: 'MP3',
        // optional: 24000 for consistency with other providers
        sampleRateHertz: 24000
      }
    };

    const response = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      let errPayload;
      try { errPayload = await response.json(); } catch (_) { errPayload = { message: await response.text() }; }
      const status = response.status || 502;
      if (byok.getUserKey('gcpTts') && byok.sendError(res, Object.assign(new Error(errPayload?.error?.message || 'Chirp TTS failed'), { status }), 'gcpTts')) return;
      return res.status(status).json({ error: 'Chirp TTS failed', details: errPayload });
    }

    const json = await response.json();
    const audioContent = json.audioContent; // base64 MP3

    if (!audioContent) {
      return res.status(500).json({ error: 'No audio content from Chirp TTS' });
    }

    const audioBuffer = Buffer.from(audioContent, 'base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (error) {
    console.error('Error in /api/chirp-tts:', error);
    res.status(500).json({ error: 'Server error while generating Chirp TTS.' });
  }
});

// Silero TTS proxy (self-hosted Silero TTS server)
// Expects the Silero server to accept POST { text, speaker, sample_rate } and
// reply with WAV audio bytes (or JSON { audio: "<base64 wav>" }).
app.post('/api/silero-tts', async (req, res) => {
  try {
    const { text, speaker, sampleRate } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Missing or invalid text for TTS.' });
    }

    const sileroUrl = process.env.SILERO_TTS_URL;
    if (!sileroUrl) {
      const status = sileroManager.getStatus();
      return res.status(503).json({
        error: `Silero TTS is not ready yet (${status.phase}${status.detail ? `: ${status.detail}` : ''}).`
      });
    }

    const resolvedSpeaker = (typeof speaker === 'string' && speaker.trim())
      ? speaker.trim()
      : (process.env.SILERO_SPEAKER || 'en_0');
    const resolvedSampleRate = Number(sampleRate) || Number(process.env.SILERO_SAMPLE_RATE || 48000);

    const response = await fetch(sileroUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        speaker: resolvedSpeaker,
        sample_rate: resolvedSampleRate,
      }),
    });

    if (!response.ok) {
      let errPayload;
      try { errPayload = await response.json(); } catch (_) { errPayload = { message: await response.text().catch(() => '') }; }
      const status = response.status || 502;
      return res.status(status).json({ error: 'Silero TTS failed', details: errPayload });
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = await response.json();
      const b64 = json.audio || json.audioContent || json.wav;
      if (!b64) {
        return res.status(502).json({ error: 'Silero server returned JSON without audio data.' });
      }
      const audioBuffer = Buffer.from(b64, 'base64');
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', audioBuffer.length);
      return res.send(audioBuffer);
    }

    res.setHeader('Content-Type', contentType.startsWith('audio/') ? contentType : 'audio/wav');
    const { Readable } = require('stream');
    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    console.error('Error in /api/silero-tts:', error);
    res.status(500).json({ error: 'Server error while generating Silero TTS. Is the Silero server running (SILERO_TTS_URL)?' });
  }
});

// Route for memory statistics (for debugging)
app.get('/api/memory-stats', async (req, res) => {
    try {
        const worldStats = await supabaseWorldService.getStats();
        const graphRagState = await supabaseWorldService.getGraphRagState();
        
        res.json({
            world: worldStats,
            activeService: supabaseWorldService.enabled ? 'world' : 'none',
            debug: {
                envVars: {
                    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
                    byokRequired: byok.isRequired(),
                    hasDatabaseUrl: !!process.env.DATABASE_URL,
                    nodeEnv: process.env.NODE_ENV
                },
                worldServiceState: {
                    initialized: supabaseWorldService.initialized,
                    enabled: supabaseWorldService.enabled,
                    lastInitError: supabaseWorldService.lastInitError
                },
                graphRagState: {
                    ...graphRagState
                },
                initGateState: {
                    done: servicesInitDone,
                    hasError: !!servicesInitError,
                    errorMessage: servicesInitError ? (servicesInitError.message || String(servicesInitError)) : null
                }
            }
        });
    } catch (error) {
        console.error('Error in /api/memory-stats:', error);
        res.status(500).json({ error: 'Failed to get memory statistics.' });
    }
});

// Endpoint to clear a specific session namespace
app.post('/api/clear-session', async (req, res) => {
  try {
    const headerSessionId = req.headers['x-session-id'];
    const bodySessionId = req.body && req.body.sessionId ? req.body.sessionId : undefined;
    const sessionId = (typeof headerSessionId === 'string' && headerSessionId.trim()) ? headerSessionId.trim() : bodySessionId;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId (header x-session-id or body.sessionId).' });
    }

    if (supabaseWorldService.enabled) {
      await supabaseWorldService.clearSession(sessionId);
    }

    res.json({ ok: true, cleared: `session-${sessionId}` });
  } catch (error) {
    console.error('Error in /api/clear-session:', error);
    res.status(500).json({ error: 'Failed to clear session memories.' });
  }
});

// --- Cloud session browser (list/continue/rename/delete across devices) ---
// Protected by a shared access key so the session list is not public.
const sessionsAccessKey = () => String(process.env.SESSIONS_ACCESS_KEY || '').trim();

function requireAccessKey(req, res, next) {
  const expected = sessionsAccessKey();
  if (!expected) {
    return res.status(503).json({ error: 'Session browsing is disabled: SESSIONS_ACCESS_KEY is not configured on the server.' });
  }
  const provided = req.headers['x-access-key'];
  if (typeof provided !== 'string' || provided.trim() !== expected) {
    return res.status(401).json({ error: 'Invalid access key.' });
  }
  next();
}

app.get('/api/sessions', requireAccessKey, async (req, res) => {
  try {
    await waitForServicesInitialization();
    if (!supabaseWorldService.enabled) {
      return res.status(503).json({ error: 'Supabase world service is not enabled.' });
    }
    const { sessions, error } = await supabaseWorldService.listSessions();
    if (error) {
      return res.status(500).json({ error: `Failed to list sessions: ${error.message}` });
    }
    res.json({ sessions });
  } catch (error) {
    console.error('Error in GET /api/sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions.' });
  }
});

app.get('/api/sessions/:id', requireAccessKey, async (req, res) => {
  try {
    await waitForServicesInitialization();
    if (!supabaseWorldService.enabled) {
      return res.status(503).json({ error: 'Supabase world service is not enabled.' });
    }
    const { snapshot, error } = await supabaseWorldService.getSessionSnapshot(req.params.id);
    if (error) {
      return res.status(404).json({ error: `Failed to load session: ${error.message}` });
    }
    res.json(snapshot);
  } catch (error) {
    console.error('Error in GET /api/sessions/:id:', error);
    res.status(500).json({ error: 'Failed to load session.' });
  }
});

app.patch('/api/sessions/:id', requireAccessKey, async (req, res) => {
  try {
    await waitForServicesInitialization();
    if (!supabaseWorldService.enabled) {
      return res.status(503).json({ error: 'Supabase world service is not enabled.' });
    }
    const { error } = await supabaseWorldService.renameSession(req.params.id, req.body?.name);
    if (error) {
      return res.status(400).json({ error: `Failed to rename session: ${error.message}` });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Error in PATCH /api/sessions/:id:', error);
    res.status(500).json({ error: 'Failed to rename session.' });
  }
});

app.delete('/api/sessions/:id', requireAccessKey, async (req, res) => {
  try {
    await waitForServicesInitialization();
    const sessionId = req.params.id;
    if (supabaseWorldService.enabled) {
      await supabaseWorldService.clearSession(sessionId);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Error in DELETE /api/sessions/:id:', error);
    res.status(500).json({ error: 'Failed to delete session.' });
  }
});

// Endpoint to mint a new session id
app.post('/api/mint-session', async (req, res) => {
  try {
    const sessionId = randomUUID();
    res.setHeader('x-session-id', sessionId);
    res.json({ sessionId });
  } catch (error) {
    console.error('Error in /api/mint-session:', error);
    res.status(500).json({ error: 'Failed to mint session id.' });
  }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
  });
}

// Exported for server.js (production) and tests
module.exports = app;

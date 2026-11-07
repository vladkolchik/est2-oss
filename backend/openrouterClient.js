// OpenRouter: one key for every model family the game uses (OpenAI-compatible API).
//   - chat:       GM narration, scene artist, GraphRAG summaries (DeepSeek / Gemini models)
//   - embeddings: openai/text-embedding-3-small — same vectors as the OpenAI API, so world
//                 memory embeddings stay compatible whichever key produced them
//   - images:     chat completions with modalities ["image", "text"]
//   - speech:     /audio/speech (Gemini TTS voices)
// The API key comes from byok: the player's own OpenRouter key for this request, else
// OPENROUTER_API_KEY. Model slugs can be overridden with OPENROUTER_*_MODEL env vars.

const byok = require('./byok');

const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

// Model defaults follow TEXT_PROVIDER so switching to OpenRouter keeps the same model family.
const DEFAULT_MODELS = {
    deepseek: { main: 'deepseek/deepseek-v4-pro', light: 'deepseek/deepseek-v4-flash' },
    gemini: { main: 'google/gemini-2.5-flash', light: 'google/gemini-2.5-flash' },
};
const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
const DEFAULT_TTS_MODEL = 'google/gemini-3.8-flash-lite-tts';
const REQUEST_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 120000);

function family() {
    const preferred = String(process.env.TEXT_PROVIDER || 'gemini').trim().toLowerCase();
    return DEFAULT_MODELS[preferred] ? preferred : 'gemini';
}

function envModel(name, fallback) {
    return String(process.env[name] || '').trim() || fallback;
}

const getMainModel = () => envModel('OPENROUTER_MODEL', DEFAULT_MODELS[family()].main);
const getLightModel = () => envModel('OPENROUTER_LIGHT_MODEL', DEFAULT_MODELS[family()].light);
const getEmbeddingModel = () => envModel('OPENROUTER_EMBEDDING_MODEL', DEFAULT_EMBEDDING_MODEL);
const getImageModel = () => envModel('OPENROUTER_IMAGE_MODEL', DEFAULT_IMAGE_MODEL);
const getTtsModel = () => envModel('OPENROUTER_TTS_MODEL', DEFAULT_TTS_MODEL);

function headers(apiKey) {
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Optional attribution headers shown on openrouter.ai
        'HTTP-Referer': process.env.OPENROUTER_APP_URL || 'https://github.com/vladkolchik/est2-oss',
        'X-Title': 'EST2',
    };
}

async function readError(response) {
    let detail = '';
    try { detail = JSON.stringify(await response.json()); } catch (_) { detail = await response.text().catch(() => ''); }
    const error = new Error(`OpenRouter API error ${response.status}: ${detail.slice(0, 600)}`);
    error.status = response.status;
    error.byokProvider = 'openrouter';
    return error;
}

async function post(path, body) {
    const apiKey = byok.requireKey('openrouter');
    let response;
    try {
        response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
            method: 'POST',
            headers: headers(apiKey),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        throw Object.assign(new Error(`OpenRouter request failed: ${error?.message || error}`), { cause: error, byokProvider: 'openrouter' });
    }
    if (!response.ok) throw await readError(response);
    return response;
}

// OpenRouter can report a provider failure inside a 200 response.
function embeddedError(data) {
    const err = data?.error || data?.choices?.[0]?.error;
    if (!err) return null;
    const error = new Error(`OpenRouter provider error: ${err.message || JSON.stringify(err)}`);
    error.status = Number(err.code) || 502;
    error.byokProvider = 'openrouter';
    return error;
}

// Same contract as deepseekClient.chatCompletion.
async function chatCompletion(messages, { model, responseFormat, temperature, thinking } = {}) {
    const body = { model: model || getMainModel(), messages };
    if (responseFormat) body.response_format = responseFormat;
    if (temperature !== undefined) body.temperature = temperature;
    // Light agents skip reasoning tokens (faster and cheaper).
    if (thinking === false) body.reasoning = { enabled: false };

    const response = await post('/chat/completions', body);
    const data = await response.json();
    const failure = embeddedError(data);
    if (failure) throw failure;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw Object.assign(new Error('OpenRouter returned an empty completion.'), { byokProvider: 'openrouter' });
    }
    return content;
}

async function createEmbedding(input) {
    const response = await post('/embeddings', { model: getEmbeddingModel(), input, encoding_format: 'float' });
    const data = await response.json();
    const failure = embeddedError(data);
    if (failure) throw failure;
    return data?.data?.[0]?.embedding || null;
}

// Returns a data: URL.
async function generateImage(prompt) {
    const response = await post('/chat/completions', {
        model: getImageModel(),
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image', 'text'],
    });
    const data = await response.json();
    const failure = embeddedError(data);
    if (failure) throw failure;
    const message = data?.choices?.[0]?.message || {};
    const url = message.images?.[0]?.image_url?.url;
    if (typeof url === 'string' && url) return url;
    throw Object.assign(new Error('OpenRouter returned no image.'), { byokProvider: 'openrouter' });
}

// Returns raw 16-bit mono PCM at 24 kHz.
async function synthesizeSpeech(text, { voice } = {}) {
    const response = await post('/audio/speech', {
        model: getTtsModel(),
        input: text,
        voice: voice || 'Enceladus',
        response_format: 'pcm',
    });
    return Buffer.from(await response.arrayBuffer());
}

module.exports = {
    chatCompletion,
    createEmbedding,
    generateImage,
    synthesizeSpeech,
    getMainModel,
    getLightModel,
    getEmbeddingModel,
    getImageModel,
    getTtsModel,
};

// BYOK (bring your own key): players can supply their own provider API keys.
//
// The browser keeps the keys (localStorage) and sends them as x-byok-* headers with every
// request. The server never stores or logs them: a key lives only in the AsyncLocalStorage
// context of the request that carried it, so every LLM/embedding call made while serving
// that request — including the world-memory jobs that recordTurn drains inline — runs on
// the player's key.
//
// BYOK_REQUIRED=true turns the server keys off for player traffic: a request without its own
// key gets 401 { code: 'byok_key_required' } instead of spending the server's quota.

const { AsyncLocalStorage } = require('async_hooks');
const { createHash } = require('crypto');

const PROVIDERS = {
    openrouter: { header: 'x-byok-openrouter', env: ['OPENROUTER_API_KEY'], label: 'OpenRouter' },
    gemini: { header: 'x-byok-gemini', env: ['GEMINI_API_KEY', 'API_KEY'], label: 'Gemini' },
    deepseek: { header: 'x-byok-deepseek', env: ['DEEPSEEK_API_KEY'], label: 'DeepSeek' },
    openai: { header: 'x-byok-openai', env: ['OPENAI_API_KEY'], label: 'OpenAI' },
    elevenlabs: { header: 'x-byok-elevenlabs', env: ['ELEVENLABS_API_KEY'], label: 'ElevenLabs' },
    gcpTts: { header: 'x-byok-gcp-tts', env: ['GCP_TTS_API_KEY', 'GOOGLE_CLOUD_API_KEY', 'CLOUD_TTS_API_KEY'], label: 'Google Cloud TTS' },
};
const TEXT_PROVIDERS = ['deepseek', 'gemini'];
const MAX_KEY_LENGTH = 512;
const KEY_PATTERN = /^[\x21-\x7e]+$/; // printable ASCII, no spaces

const requestContext = new AsyncLocalStorage();

class ByokError extends Error {
    constructor(code, provider, message) {
        super(message);
        this.name = 'ByokError';
        this.code = code;
        this.provider = provider;
    }
}

function assertProvider(provider) {
    if (!PROVIDERS[provider]) throw new Error(`unknown BYOK provider: ${provider}`);
}

function isRequired() {
    const raw = String(process.env.BYOK_REQUIRED || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function sanitizeKey(value) {
    if (typeof value !== 'string') return null;
    const key = value.trim();
    if (!key || key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) return null;
    return key;
}

// Express middleware: must run after the body parser so route handlers inherit the context.
function middleware(req, res, next) {
    const keys = {};
    for (const [provider, spec] of Object.entries(PROVIDERS)) {
        const key = sanitizeKey(req.headers[spec.header]);
        if (key) keys[provider] = key;
    }
    requestContext.run({ keys, warnings: new Set() }, next);
}

// Run fn with an explicit set of player keys (scripts and tests).
function runWithKeys(keys, fn) {
    const clean = {};
    for (const provider of Object.keys(PROVIDERS)) {
        const key = sanitizeKey(keys?.[provider]);
        if (key) clean[provider] = key;
    }
    return requestContext.run({ keys: clean, warnings: new Set() }, fn);
}

function getUserKey(provider) {
    assertProvider(provider);
    return requestContext.getStore()?.keys?.[provider] || null;
}

function getServerKey(provider) {
    assertProvider(provider);
    for (const name of PROVIDERS[provider].env) {
        const value = String(process.env[name] || '').trim();
        if (value) return value;
    }
    return null;
}

// The key to use for this request: the player's own, else the server's (unless BYOK_REQUIRED).
function getKey(provider) {
    return getUserKey(provider) || (isRequired() ? null : getServerKey(provider));
}

function keySource(provider) {
    if (getUserKey(provider)) return 'user';
    if (!isRequired() && getServerKey(provider)) return 'server';
    return null;
}

function requireKey(provider) {
    const key = getKey(provider);
    if (!key) {
        const { label } = PROVIDERS[provider];
        throw new ByokError('byok_key_required', provider, `${label} API key required. Add your own key in API KEYS.`);
    }
    return key;
}

// First provider of `candidates` the player brought a key for, else the first one usable with
// a server key. A player's key always beats the server's, so their requests bill to them.
function pickProvider(candidates) {
    return candidates.find((p) => getUserKey(p)) || candidates.find((p) => getKey(p)) || null;
}

// Text LLM for this request: 'deepseek' | 'gemini' | 'openrouter' | null. The configured
// provider wins among equals; OpenRouter is the catch-all behind the direct providers.
function pickTextProvider(preferred) {
    const first = TEXT_PROVIDERS.includes(preferred) ? preferred : 'gemini';
    return pickProvider([first, ...TEXT_PROVIDERS.filter((p) => p !== first), 'openrouter']);
}

function requireTextProvider(preferred) {
    const provider = pickTextProvider(preferred);
    if (!provider) {
        throw new ByokError('byok_key_required', 'openrouter',
            'An OpenRouter, DeepSeek or Gemini API key is required. Add your own key in API KEYS.');
    }
    return provider;
}

// SDK clients are cheap but not free; reuse them per (kind, key) with a small LRU.
const CLIENT_CACHE_LIMIT = 32;
const clientCache = new Map();
function cachedClient(kind, key, factory) {
    const id = `${kind}:${createHash('sha256').update(key).digest('hex')}`;
    if (clientCache.has(id)) {
        const client = clientCache.get(id);
        clientCache.delete(id);
        clientCache.set(id, client);
        return client;
    }
    const client = factory(key);
    clientCache.set(id, client);
    if (clientCache.size > CLIENT_CACHE_LIMIT) {
        clientCache.delete(clientCache.keys().next().value);
    }
    return client;
}

function getGeminiClient() {
    const key = getKey('gemini');
    if (!key) return null;
    const { GoogleGenAI } = require('@google/genai');
    return cachedClient('gemini', key, (apiKey) => new GoogleGenAI({ apiKey }));
}

function getOpenAIClient() {
    const key = getKey('openai');
    if (!key) return null;
    const OpenAI = require('openai');
    return cachedClient('openai', key, (apiKey) => new OpenAI({ apiKey }));
}

const CREDIT_ERROR_PATTERN = /insufficient (credits|balance|funds)|requires more credits|not enough credits|payment required/i;

function isCreditError(error) {
    for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
        if (Number(e.status || e.statusCode) === 402) return true;
        if (CREDIT_ERROR_PATTERN.test(String(e.message || ''))) return true;
    }
    return false;
}

const AUTH_ERROR_PATTERN = /api[ _-]?key (not valid|invalid|expired)|invalid[ _-]api[ _-]key|incorrect api key|authentication|unauthori[sz]ed|permission denied|api_key_invalid/i;

function isAuthError(error) {
    for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
        const status = Number(e.status || e.statusCode || e.code);
        if (status === 401 || status === 403) return true;
        if (AUTH_ERROR_PATTERN.test(String(e.message || ''))) return true;
    }
    return false;
}

// A key problem that retrying the same request cannot fix.
function isKeyError(error) {
    return error instanceof ByokError || isAuthError(error) || isCreditError(error);
}

// Which provider an error came from: tagged by our clients (error.byokProvider), else the hint.
function errorProvider(error, hint) {
    for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
        if (e.byokProvider && PROVIDERS[e.byokProvider]) return e.byokProvider;
    }
    return hint || null;
}

// Map an error to a client-facing BYOK response, or null when it is not a key problem.
// Only blame the key when it was the player's own; a broken server key stays a server error.
function describeError(error, provider) {
    for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
        if (e instanceof ByokError) {
            return { status: 401, body: { error: e.message, code: e.code, provider: e.provider } };
        }
    }
    const source = errorProvider(error, provider);
    const candidates = source ? [source] : Object.keys(PROVIDERS);
    const blamed = candidates.find((p) => getUserKey(p));
    if (!blamed) return null;
    const { label } = PROVIDERS[blamed];
    if (isCreditError(error)) {
        return {
            status: 402,
            body: { error: `${label}: not enough credits on your account. Top up or use another key in API KEYS.`, code: 'byok_no_credits', provider: blamed }
        };
    }
    if (isAuthError(error)) {
        return {
            status: 401,
            body: { error: `${label} rejected your API key. Check it in API KEYS.`, code: 'byok_key_invalid', provider: blamed }
        };
    }
    return null;
}

// Non-fatal key problems (e.g. a rejected OpenAI key: the turn still plays, embeddings wait),
// reported to the client in the x-byok-warnings response header as "provider:code" items.
function noteKeyFailure(provider, error) {
    const store = requestContext.getStore();
    if (!store?.warnings || !getUserKey(provider)) return;
    if (isCreditError(error)) store.warnings.add(`${provider}:byok_no_credits`);
    else if (isAuthError(error)) store.warnings.add(`${provider}:byok_key_invalid`);
}

function getWarnings() {
    return Array.from(requestContext.getStore()?.warnings || []);
}

// Responds and returns true when the error is a BYOK problem; otherwise leaves res alone.
function sendError(res, error, provider) {
    const described = describeError(error, provider);
    if (!described) return false;
    res.status(described.status).json(described.body);
    return true;
}

// What the client may show: whether keys are mandatory and which providers have a usable
// server key. Never includes key material.
function publicStatus() {
    const required = isRequired();
    const providers = {};
    for (const [provider, spec] of Object.entries(PROVIDERS)) {
        providers[provider] = { label: spec.label, serverKey: !required && !!getServerKey(provider) };
    }
    return { required, providers };
}

module.exports = {
    PROVIDERS,
    ByokError,
    middleware,
    runWithKeys,
    isRequired,
    getUserKey,
    getServerKey,
    getKey,
    keySource,
    requireKey,
    pickProvider,
    pickTextProvider,
    requireTextProvider,
    getGeminiClient,
    getOpenAIClient,
    isAuthError,
    isCreditError,
    isKeyError,
    noteKeyFailure,
    getWarnings,
    describeError,
    sendError,
    publicStatus,
};

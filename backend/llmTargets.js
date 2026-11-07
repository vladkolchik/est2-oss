// Shared model resolution for the text agents: given the provider byok picked for this
// request, which model to call and which OpenAI-compatible chat client to call it with.
// Gemini (direct) is not chat-compatible here: callers use the @google/genai SDK for it.

const deepseekClient = require('./deepseekClient');
const openrouterClient = require('./openrouterClient');

// `configured` is an env override (ARTIST_MODEL, GRAPH_RAG_SUMMARY_MODEL). It applies only
// when it fits the provider: OpenRouter slugs contain "/", DeepSeek names start with
// "deepseek", anything else is a Gemini model name.
function resolveLightTarget(provider, configured = '') {
    const name = String(configured || '').trim();
    const isSlug = name.includes('/');
    if (provider === 'openrouter') {
        return { provider, model: isSlug ? name : openrouterClient.getLightModel() };
    }
    if (provider === 'deepseek') {
        return { provider, model: !isSlug && name.startsWith('deepseek') ? name : deepseekClient.DEFAULT_LIGHT_MODEL };
    }
    return { provider, model: name && !isSlug && !name.startsWith('deepseek') ? name : 'gemini-2.5-flash' };
}

// chatCompletion(messages, { model, responseFormat, temperature, thinking }) for chat providers.
function chatClientFor(provider) {
    if (provider === 'openrouter') return openrouterClient.chatCompletion;
    if (provider === 'deepseek') return deepseekClient.chatCompletion;
    return null;
}

module.exports = { resolveLightTarget, chatClientFor };

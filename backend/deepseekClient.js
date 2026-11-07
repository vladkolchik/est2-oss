// Shared DeepSeek chat-completions client (OpenAI-compatible API).
// Current models: deepseek-v4-pro (flagship), deepseek-v4-flash (fast/cheap).
// Legacy names deepseek-chat / deepseek-reasoner are retired on 2026-07-24.
// The API key comes from byok: the player's own key for this request, else DEEPSEEK_API_KEY.

const byok = require('./byok');

const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');

const DEFAULT_MAIN_MODEL = 'deepseek-v4-pro';
const DEFAULT_LIGHT_MODEL = 'deepseek-v4-flash';

function isConfigured() {
    return !!byok.getKey('deepseek');
}

function getMainModel() {
    return (process.env.DEEPSEEK_MODEL || DEFAULT_MAIN_MODEL).trim() || DEFAULT_MAIN_MODEL;
}

async function chatCompletion(messages, { model, responseFormat, temperature, thinking } = {}) {
    const apiKey = byok.requireKey('deepseek');

    const body = {
        model: model || getMainModel(),
        messages,
    };
    if (responseFormat) body.response_format = responseFormat;
    if (temperature !== undefined) body.temperature = temperature;
    // V4 models default to thinking mode; light agents pass thinking: false
    // to skip reasoning tokens (faster and cheaper).
    if (thinking === false) body.thinking = { type: 'disabled' };

    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        let errBody;
        try { errBody = JSON.stringify(await response.json()); } catch (_) { errBody = await response.text().catch(() => ''); }
        const error = new Error(`DeepSeek API error ${response.status}: ${errBody}`);
        error.status = response.status;
        throw error;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
        throw new Error('DeepSeek returned an empty completion.');
    }
    return content;
}

module.exports = {
    isConfigured,
    chatCompletion,
    getMainModel,
    DEFAULT_MAIN_MODEL,
    DEFAULT_LIGHT_MODEL,
};

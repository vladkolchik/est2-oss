// "Artist" agent: a separate lightweight LLM call that converts the narrative
// into a compact scene descriptor for the client-side parametric renderer.
// Runs outside the GM model's context on purpose — scene sketching must not
// pollute or distract the main narrative model.
//
// Provider follows TEXT_PROVIDER (override with ARTIST_PROVIDER):
//   deepseek -> deepseek-v4-flash (light tier), gemini -> gemini-2.5-flash.

const { Type } = require('@google/genai');
const byok = require('./byok');
const { resolveLightTarget, chatClientFor } = require('./llmTargets');
// Single source of truth, shared with the frontend renderer (services/sceneRenderer.ts)
const {
    environments: ENVIRONMENTS,
    timesOfDay: TIMES_OF_DAY,
    weathers: WEATHERS,
    moods: MOODS,
    landmarkTypes: LANDMARK_TYPES,
} = require('../shared/sceneVocabulary.json');

const ARTIST_MAX_ATTEMPTS = 3;

const descriptorSchema = {
    type: Type.OBJECT,
    properties: {
        environment: { type: Type.STRING, description: `One of: ${ENVIRONMENTS.join(', ')}` },
        timeOfDay: { type: Type.STRING, description: `One of: ${TIMES_OF_DAY.join(', ')}` },
        weather: { type: Type.STRING, description: `One of: ${WEATHERS.join(', ')}` },
        mood: { type: Type.STRING, description: `One of: ${MOODS.join(', ')}` },
        landmarks: {
            type: Type.ARRAY,
            description: 'Up to 6 visible landmarks, ordered background to foreground.',
            items: {
                type: Type.OBJECT,
                properties: {
                    type: { type: Type.STRING, description: `One of: ${LANDMARK_TYPES.join(', ')}` },
                    position: { type: Type.NUMBER, description: 'Horizontal position 0..1 (0=left, 1=right)' },
                    scale: { type: Type.NUMBER, description: 'Relative size 0..1' }
                },
                required: ['type', 'position', 'scale']
            }
        },
        figures: { type: Type.INTEGER, description: 'Number of humanoid silhouettes visible, 0-5' }
    },
    required: ['environment', 'timeOfDay', 'weather', 'mood', 'landmarks', 'figures']
};

const ARTIST_INSTRUCTION = `You are the scene artist for a post-apocalyptic Fallout-style text RPG.
Given a narrative passage, output ONLY a JSON scene descriptor for a 2D silhouette renderer.
Pick the closest values from the fixed vocabularies — never invent new ones.
Choose 2-6 landmarks that best capture the scene; spread positions across 0..1.
"figures" counts visible people/creatures as silhouettes (0-5).`;

function pickEnum(value, allowed, fallback) {
    const normalized = String(value || '').trim().toLowerCase();
    return allowed.includes(normalized) ? normalized : fallback;
}

function clamp01(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(1, Math.max(0, num));
}

// Coerce a raw model reply into a safe, renderable descriptor.
function normalizeDescriptor(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('descriptor is not a JSON object');
    }
    const landmarksRaw = Array.isArray(raw.landmarks) ? raw.landmarks : [];
    const landmarks = landmarksRaw
        .slice(0, 6)
        .map((l, i) => ({
            type: pickEnum(l?.type, LANDMARK_TYPES, 'rock'),
            position: clamp01(l?.position, (i + 1) / (landmarksRaw.length + 1)),
            scale: clamp01(l?.scale, 0.5)
        }));
    const figures = Number(raw.figures);
    return {
        environment: pickEnum(raw.environment, ENVIRONMENTS, 'desert'),
        timeOfDay: pickEnum(raw.timeOfDay, TIMES_OF_DAY, 'day'),
        weather: pickEnum(raw.weather, WEATHERS, 'clear'),
        mood: pickEnum(raw.mood, MOODS, 'calm'),
        landmarks,
        figures: Number.isFinite(figures) ? Math.min(5, Math.max(0, Math.round(figures))) : 0
    };
}

function extractJsonBlock(text) {
    const trimmed = String(text || '').trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return trimmed;
    return trimmed.slice(start, end + 1);
}

function resolveArtistTarget() {
    const preferred = String(process.env.ARTIST_PROVIDER || process.env.TEXT_PROVIDER || 'gemini').trim().toLowerCase();
    const configured = String(process.env.ARTIST_MODEL || '').trim();
    // Throws byok_key_required (401) when no text provider has a usable key.
    return resolveLightTarget(byok.requireTextProvider(preferred), configured);
}

function getGeminiClient() {
    byok.requireKey('gemini');
    return byok.getGeminiClient();
}

function buildUserPrompt({ description, locationName, ambience }) {
    return [
        locationName ? `LOCATION: ${locationName}` : null,
        ambience ? `AMBIENCE: ${ambience}` : null,
        'NARRATIVE:',
        String(description || '').slice(0, 2400)
    ].filter(Boolean).join('\n');
}

async function generateSceneDescriptor({ description, locationName, ambience }) {
    const target = resolveArtistTarget();
    const userPrompt = buildUserPrompt({ description, locationName, ambience });

    const chat = chatClientFor(target.provider);
    if (chat) {
        const messages = [
            {
                role: 'system',
                content: `${ARTIST_INSTRUCTION}\n\nYour entire reply MUST be a single valid JSON object conforming to this JSON schema:\n${JSON.stringify(descriptorSchema)}`
            },
            { role: 'user', content: userPrompt },
        ];
        let lastError = null;
        for (let attempt = 1; attempt <= ARTIST_MAX_ATTEMPTS; attempt++) {
            let content = null;
            try {
                content = await chat(messages, {
                    model: target.model,
                    responseFormat: { type: 'json_object' },
                    temperature: 0.6,
                    thinking: false,
                });
                return normalizeDescriptor(JSON.parse(extractJsonBlock(content)));
            } catch (error) {
                lastError = error;
                console.warn(`Artist (${target.provider}) attempt ${attempt}/${ARTIST_MAX_ATTEMPTS} failed:`, error.message);
                if (byok.isKeyError(error)) break;
                if (content) {
                    messages.push({ role: 'assistant', content });
                    messages.push({
                        role: 'user',
                        content: `Your previous reply was rejected: ${error.message}. Respond again with ONLY the corrected JSON object.`
                    });
                }
            }
        }
        throw lastError || new Error('Artist agent failed.');
    }

    // Gemini path: structured output enforces the schema server-side.
    const response = await getGeminiClient().models.generateContent({
        model: target.model,
        contents: userPrompt,
        config: {
            systemInstruction: ARTIST_INSTRUCTION,
            responseMimeType: 'application/json',
            responseSchema: descriptorSchema,
        },
    });
    return normalizeDescriptor(JSON.parse(String(response.text || '').trim()));
}

module.exports = { generateSceneDescriptor, resolveArtistTarget };

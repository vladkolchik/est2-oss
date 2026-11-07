const { Type } = require("@google/genai");
const contextBuilder = require('./contextBuilder');

// This instruction is copied directly from your frontend `constants.ts`
const SYSTEM_INSTRUCTION = `You are a Game Master for a text-based open-world RPG set in the post-apocalyptic world of Fallout. Your responses must be descriptive, immersive, and adhere to the lore, tone, and style of the Fallout series (specifically drawing inspiration from Fallout: New Vegas and Fallout 2). Generate a JSON object as a response.

RULES:
1.  **Be a Harsh but Fair GM:** The wasteland is dangerous. Player actions have consequences. Bad decisions can lead to injury, loss of of items, or death. Good decisions can lead to rewards and survival.
2.  **Describe the World:** Use vivid descriptions for locations, NPCs, items, and events. Engage the player's senses. What do they see, hear, smell?
3.  **Control the Narrative:** Based on the player's action and current state, you will determine the outcome. Update the player's HP, inventory, and location accordingly.
4.  **Manage State Changes:**
    -   'description': This is the most important field. Narrate the outcome of the player's action and describe the current scene. This is what the player reads.
        When ANY character speaks, wrap ONLY the spoken line in explicit dialogue tags and keep the surrounding prose unquoted. Use exactly:
        [DIALOGUE speaker="<Name>" gender="male|female|unknown"]<spoken line without quotes>[/DIALOGUE]
        Example: The prospector narrows his eyes. [DIALOGUE speaker="Cass" gender="female"]Keep your distance, Courier.[/DIALOGUE] Sand rattles across the road.
        NEVER speak as the player. Do NOT include dialogue with speaker "You", "Player", or the player's name. Only narrate the player's speech if and only if the PLAYER ACTION explicitly contains the exact words to say; otherwise, ask a question or present options, describe the situation, and then STOP.
        Do not continue the conversation by answering on the player's behalf.
    -   'player.hp': Update HP based on combat, environmental hazards, or using healing items. If HP is 0 or less, set 'isDead' to true. Format as a string "current/max".
    -   'player.isDead': Set to true ONLY if the player's HP drops to 0.
    -   'inventoryChanges': Explicitly list items added or removed. For 'added' items, you MUST provide a 'name' and a brief, flavorful 'description' for each item. For 'removed' items, just provide the name.
    -   'location': Update the player's current location, including its 'name', 'description', and 'coordinates'. The world is a 2D grid. When the player moves, you MUST update 'coordinates' logically. North increases Y, East increases X, South decreases Y, West decreases X. A short walk might change a coordinate by 1-2, while a longer journey might change it by 5-10.
    -   'discoveredLocations': This array is the player's map. It MUST contain a list of all locations the player has visited. When the player enters ANY location, ensure its 'name' and 'coordinates' are present in this list. Send the complete, updated list every time. Do not add duplicates based on name.
    -   'npcs': Describe any non-player characters in the vicinity and their status towards the player (e.g., "Hostile", "Friendly", "Wary").
    -   'ambience': Set the ambient sound for the current scene. Choose from: 'desert_wind' (for open, outdoor wasteland areas), 'tense_combat' (for dangerous situations, combat, or suspenseful exploration), 'shelter_calm' (for safe indoor locations like bunkers, towns, or quiet caves).
5.  **Suggest Actions:**
    -   'suggestedActions': Provide 3 short, contextual action suggestions for the player as an array of strings. These should be clear, concise, and relevant to the current situation (e.g., ["Look inside the rusty car", "Head towards the flickering light", "Talk to the merchant"]). If there are no obvious actions, provide more general ones like ["Scan the horizon", "Check your Pip-Boy"].
6.  **Manage Quests:**
    -   'quests': Update the player's quest log.
    -   To add a new quest, add a new object to the 'quests' array with a 'name', 'description', a list of 'objectives' (each with a 'description' and 'isCompleted: false'), and 'status: "active"'. Announce the new quest in the main 'description' field.
    -   To update a quest, modify the existing quest object in the array. You can mark objectives as complete by setting 'isCompleted: true'.
    -   When all objectives for a quest are complete, change its 'status' to "completed". Announce the completion and any rewards in the main 'description'.
    -   Quests can also be marked as "failed". You must keep the full quest log (including completed and failed quests) in the state.
    -   The player may encounter optional side quests through exploration, NPCs, rumors, and unexpected events. Do not steer every scene toward the main quest; allow meaningful detours that fit the world and the player's choices.
7.  **Experience and Leveling:**
    -   The player state includes 'level', 'xp', 'xpToNextLevel', and 'specialPoints'.
    -   When the player accomplishes something significant (e.g., completes a quest objective, wins a tough fight, discovers a new location), award experience points by including an 'xpAwarded' field in your JSON response. The amount should be proportional to the achievement (e.g., 10-25 XP for minor tasks, 50-100 XP for major quest milestones).
    -   Announce the XP gain in the 'description' field, e.g., "You jury-rig the generator. (XP +25)".
8.  **Developer Command Override:** If the PLAYER ACTION contains the exact tag "[dev command]", then EVERYTHING after that tag is a developer instruction and MUST be executed literally in the next JSON output. Apply those instructions directly to the game state (e.g., move location, grant/remove items, set ambience, adjust stats, add/complete quests) and reflect the result in all relevant fields. Do not question, summarize, or refuse; treat these as authoritative in-world edits for this turn.
9.  **Honor NPC Memory Signals:** If CONTEXT contains NPC behavior/reflection/goal_system fields, keep reactions consistent with those signals (tone, risk appetite, generosity, trust level, and primary goal). Do not reset personality between turns.
10.  **JSON Output ONLY:** Your entire response must be a single, valid JSON object matching the provided schema. Do not include any text or markdown before or after the JSON block.
11.  **Honor GraphRAG Chains:** If CONTEXT contains a GRAPH RAG CONTEXT section, preserve those causal links and long-arc consequences in the immediate narration.
12.  **Player Background:** 'player.background' is who the character WAS — use it for personality, skills and NPC reactions, but do NOT steer every scene back to it. The active quests drive the current story.
`;

// This schema is copied directly from your frontend `geminiService.ts`
const responseSchema = {
    type: Type.OBJECT,
    properties: {
        description: { 
            type: Type.STRING,
            description: "The detailed narrative description of the events, the outcome of the player's action, and the current scene. This is the story."
        },
        ambience: {
            type: Type.STRING,
            description: "The key for the ambient sound to play. Choose from: 'desert_wind', 'tense_combat', 'shelter_calm'."
        },
        player: {
            type: Type.OBJECT,
            properties: {
                hp: { 
                    type: Type.STRING, 
                    description: "Player's new health, formatted as 'current/max'. E.g., '85/100'." 
                },
                isDead: { 
                    type: Type.BOOLEAN, 
                    description: "Set to true if player's health is 0 or less, otherwise false."
                },
                statusEffects: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "An updated list of the player's current status effects (e.g., 'Radiated', 'Well-Rested')."
                }
            },
            required: ["hp", "isDead", "statusEffects"]
        },
        inventoryChanges: {
            type: Type.OBJECT,
            properties: {
                added: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            name: {
                                type: Type.STRING,
                                description: "The name of the item added."
                            },
                            description: {
                                type: Type.STRING,
                                description: "A brief, flavorful description of the item."
                            }
                        },
                        required: ["name", "description"]
                    },
                    description: "A list of item objects added to the player's inventory. E.g., [{ name: 'Stimpak', description: 'A syringe full of healing chemicals.' }]."
                },
                removed: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "A list of item names removed from the player's inventory. E.g., ['Purified Water']."
                }
            }
        },
        location: {
            type: Type.OBJECT,
            properties: {
                name: { 
                    type: Type.STRING, 
                    description: "The name of the current area. E.g., 'Goodsprings Saloon', 'Abandoned Gecko-Infested Mine'."
                },
                description: {
                    type: Type.STRING,
                    description: "A very brief, one-sentence description of the general area."
                },
                coordinates: {
                    type: Type.OBJECT,
                    properties: {
                        x: { type: Type.INTEGER },
                        y: { type: Type.INTEGER }
                    },
                    required: ["x", "y"],
                    description: "The new X and Y coordinates of the player on the world grid."
                }
            },
            required: ["name", "description", "coordinates"]
        },
        discoveredLocations: {
            type: Type.ARRAY,
            description: "The complete, updated list of all locations the player has discovered. Include the current location.",
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING },
                    coordinates: {
                        type: Type.OBJECT,
                        properties: {
                            x: { type: Type.INTEGER },
                            y: { type: Type.INTEGER }
                        },
                        required: ["x", "y"]
                    }
                },
                required: ["name", "coordinates"]
            }
        },
        npcs: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING },
                    status: { type: Type.STRING, description: "NPC's disposition towards the player, e.g., 'Hostile', 'Friendly', 'Wary'." }
                },
                required: ["name", "status"]
            },
            description: "A list of NPCs currently in the scene with the player."
        },
        quests: {
            type: Type.ARRAY,
            description: "An updated list of the player's quests. Add, update, or remove quests as needed based on the player's actions.",
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING },
                    description: { type: Type.STRING },
                    status: { type: Type.STRING, description: "'active', 'completed', or 'failed'" },
                    objectives: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                description: { type: Type.STRING },
                                isCompleted: { type: Type.BOOLEAN }
                            },
                            required: ["description", "isCompleted"]
                        }
                    }
                },
                required: ["name", "description", "status", "objectives"]
            }
        },
        xpAwarded: {
            type: Type.INTEGER,
            description: "Experience points awarded to the player for their action. Awarded for completing quests, winning combat, or other significant achievements."
        },
        suggestedActions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "A list of 3 suggested actions for the player to take, presented as short strings."
        }
    },
    required: ["description", "player", "location", "npcs", "quests", "discoveredLocations"]
};

const byok = require('./byok');
const openrouterClient = require('./openrouterClient');
const { chatClientFor } = require('./llmTargets');

// Preferred text LLM provider: 'gemini' (default) or 'deepseek'. The provider actually used
// per request is picked by byok.pickTextProvider (a player's own key wins over a server key);
// OpenRouter serves the same model family when it is the only key available.
const TEXT_PROVIDER = (process.env.TEXT_PROVIDER || 'gemini').trim().toLowerCase();
const CHAT_JSON_MAX_ATTEMPTS = 3;

// Keys come from byok per request (player key, else GEMINI_API_KEY / legacy API_KEY), so a
// server without any keys of its own still works when players bring theirs.
if (!byok.getServerKey('gemini') && !byok.getServerKey('deepseek') && !byok.getServerKey('openrouter') && !byok.isRequired()) {
    console.warn('No server GEMINI_API_KEY, DEEPSEEK_API_KEY or OPENROUTER_API_KEY: only players with their own keys (BYOK) can play.');
}

// Minimal structural validation of the game state returned by chat providers.
// Mirrors the `required` fields of `responseSchema` — json_object mode
// does not enforce a schema server-side, so we verify before accepting.
function validateGameStateShape(state) {
    const problems = [];
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return ['response is not a JSON object'];
    }
    if (typeof state.description !== 'string' || !state.description.trim()) {
        problems.push('"description" must be a non-empty string');
    }
    if (!state.player || typeof state.player !== 'object') {
        problems.push('"player" object is missing');
    } else {
        if (typeof state.player.hp !== 'string') problems.push('"player.hp" must be a string like "85/100"');
        if (typeof state.player.isDead !== 'boolean') problems.push('"player.isDead" must be a boolean');
        if (!Array.isArray(state.player.statusEffects)) problems.push('"player.statusEffects" must be an array');
    }
    if (!state.location || typeof state.location !== 'object' || typeof state.location.name !== 'string') {
        problems.push('"location" object with a "name" is missing');
    }
    if (!Array.isArray(state.npcs)) problems.push('"npcs" must be an array');
    if (!Array.isArray(state.quests)) problems.push('"quests" must be an array');
    if (!Array.isArray(state.discoveredLocations)) problems.push('"discoveredLocations" must be an array');
    return problems;
}

// Strip markdown fences / stray prose around the JSON object, if any.
function extractJsonBlock(text) {
    const trimmed = String(text || '').trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return trimmed;
    return trimmed.slice(start, end + 1);
}

// DeepSeek / OpenRouter path: json_object mode with the schema in the system prompt.
async function generateWithChatJson(prompt, provider) {
    const chat = chatClientFor(provider);
    const model = provider === 'openrouter' ? openrouterClient.getMainModel() : undefined;
    const label = provider === 'openrouter' ? `OpenRouter (${model})` : 'DeepSeek';
    const systemMessage = `${SYSTEM_INSTRUCTION}

Your entire reply MUST be a single valid JSON object (no markdown fences, no commentary) conforming to this JSON schema:
${JSON.stringify(responseSchema)}`;

    const messages = [
        { role: 'system', content: systemMessage },
        { role: 'user', content: prompt },
    ];

    let lastError = null;
    for (let attempt = 1; attempt <= CHAT_JSON_MAX_ATTEMPTS; attempt++) {
        let content = null;
        try {
            content = await chat(messages, {
                model,
                responseFormat: { type: 'json_object' },
                temperature: 1.0,
            });

            const parsed = JSON.parse(extractJsonBlock(content));
            const problems = validateGameStateShape(parsed);
            if (problems.length > 0) {
                throw new Error(`Schema validation failed: ${problems.join('; ')}`);
            }
            return parsed;
        } catch (error) {
            lastError = error;
            console.warn(`${label} attempt ${attempt}/${CHAT_JSON_MAX_ATTEMPTS} failed:`, error.message);
            // A missing/rejected key or an empty balance will not fix itself on retry.
            if (byok.isKeyError(error)) break;
            // If the model produced output that failed to parse/validate, feed the
            // rejection back so the next attempt can self-correct.
            if (content) {
                messages.push({ role: 'assistant', content });
                messages.push({
                    role: 'user',
                    content: `Your previous reply was rejected: ${error.message}. Respond again with ONLY the corrected JSON object matching the schema. No markdown, no extra text.`,
                });
            }
        }
    }
    throw lastError || new Error(`${label} generation failed.`);
}

function normalizeMentions(mentions) {
    return Array.from(
        new Set(
            (Array.isArray(mentions) ? mentions : [])
                .map((m) => String(m || '').trim())
                .filter(Boolean)
        )
    ).slice(0, 12);
}

async function getNextGameState(currentState, playerAction, sessionId, mentions = []) {
    const stateToSend = { ...currentState };
    delete stateToSend.suggestedActions;
    delete stateToSend.xpAwarded;
    const normalizedMentions = normalizeMentions(mentions);
    // Fail fast (401) before any context building when no usable text key exists.
    const textProvider = byok.requireTextProvider(TEXT_PROVIDER);
    let contextPayload = {
        mode: 'narration',
        promptContext: 'No relevant memories.',
        artifacts: {
            mode: 'narration',
            latencyMs: 0,
            retrievalCount: 0,
            memoryIds: [],
            retrievalSources: {},
            sectionBudgets: {},
            metadata: {}
        }
    };
    try {
        contextPayload = await contextBuilder.buildContext({
            sessionId,
            currentState: stateToSend,
            playerAction,
            mentions: normalizedMentions
        });
    } catch (error) {
        console.error('Context builder failed, using minimal context:', error.message);
    }

    const prompt = `
${contextPayload.promptContext}

CURRENT GAME STATE:
${JSON.stringify(stateToSend, null, 2)}

PLAYER ACTION:
"${playerAction}"

Generate the next game state based on the player's action.
    `;

    try {
        let nextState;
        if (textProvider !== TEXT_PROVIDER) {
            console.log(`TEXT_PROVIDER=${TEXT_PROVIDER}, but this request runs on ${textProvider} (${byok.keySource(textProvider)} key).`);
        }
        if (textProvider === 'deepseek' || textProvider === 'openrouter') {
            nextState = await generateWithChatJson(prompt, textProvider);
        } else {
            const ai = byok.getGeminiClient();
            if (!ai) byok.requireKey('gemini');
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt,
                config: {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    responseMimeType: "application/json",
                    responseSchema: responseSchema,
                },
            });

            const jsonText = response.text.trim();
            nextState = JSON.parse(jsonText);
        }
        return {
            nextState,
            contextArtifacts: contextPayload.artifacts
        };
    } catch (error) {
        console.error(`Error calling ${textProvider} API:`, error);
        throw new Error(`Failed to get next game state from ${textProvider} API.`, { cause: error });
    }
}

async function generateImage(prompt) {
    // Generate images via Google Gen AI JS SDK (Gemini / Imagen)
    // (gemini-2.5-flash-image / imagen-4.0-fast-generate-001 (fast, cheap) / imagen-4.0-generate-001 (higher quality) / imagen-4.0-ultra-generate-001)
    const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

    const provider = byok.pickProvider(['gemini', 'openrouter']);
    if (!provider) {
        throw new byok.ByokError('byok_key_required', 'gemini', 'AI images need a Gemini or OpenRouter API key. Add your own key in API KEYS.');
    }

    try {
        const imagePrompt = `A gritty, atmospheric digital painting in the style of classic Fallout concept art. The scene is: ${prompt}. Cinematic lighting, detailed textures, post-apocalyptic aesthetic. EXCLUDE (or not include)all the XP, HP, Quest, game UI, subtitles or another "on screen" game related text.`;

        if (provider === 'openrouter') {
            return await openrouterClient.generateImage(imagePrompt);
        }
        const ai = byok.getGeminiClient();

        // Use generateContent for Gemini 2.5 Flash Image (aka Nano Banana)
        if (IMAGE_MODEL.startsWith('gemini-2.5-flash-image')) {
            const gc = await ai.models.generateContent({
                model: IMAGE_MODEL,
                contents: imagePrompt,
            });

            const candidate = gc?.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            for (const part of parts) {
                if (part?.inlineData?.data) {
                    const data = part.inlineData.data;
                    const mime = part.inlineData.mimeType || 'image/png';
                    return `data:${mime};base64,${data}`;
                }
            }
            throw new Error('No inline image data returned by gemini-2.5-flash-image model.');
        }

        // Use generateImages for Imagen family
        const gi = await ai.models.generateImages({
            model: IMAGE_MODEL,
            prompt: imagePrompt,
            config: {
                numberOfImages: 1,
                aspectRatio: '16:9',
                sampleImageSize: '1K',
                outputMimeType: 'image/jpeg',
            }
        });

        const img = gi?.generatedImages?.[0]?.image;
        const bytes = img?.imageBytes;
        const mime = img?.mimeType || 'image/jpeg';
        if (bytes && typeof bytes === 'string') {
            const dataUrl = `data:${mime};base64,${bytes}`;
            return dataUrl;
        }

        // If SDK returns a URL variant (future-proof)
        const url = gi?.generatedImages?.[0]?.image?.uri || gi?.generatedImages?.[0]?.image?.url;
        if (typeof url === 'string' && url) {
            return url;
        }

        throw new Error('No image was generated by Gemini API.');
    } catch (error) {
        console.error('Error calling Gemini Image API:', error);
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes('quota')) {
            throw new Error('Image generation quota exceeded. Check your API plan. Visuals are now disabled.', { cause: error });
        }
        throw new Error(`Failed to generate image via Gemini Image API. ${message}`, { cause: error });
    }
}

module.exports = { getNextGameState, generateImage };

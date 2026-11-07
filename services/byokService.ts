// BYOK (bring your own key): the player's own provider API keys.
//
// Keys stay in this browser (localStorage) and travel to our backend as x-byok-* headers
// with each request; the backend uses them for that request only and never stores them.

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001');
const STORAGE_KEY = 'gemini-fallout-rpg-byok';

export type ByokProvider = 'openrouter' | 'deepseek' | 'gemini' | 'openai' | 'elevenlabs' | 'gcpTts';

export interface ByokProviderInfo {
    id: ByokProvider;
    label: string;
    header: string;
    usedFor: string;
    keyUrl: string;
    placeholder: string;
    // Providers this one can stand in for when their own key is missing
    covers?: ByokProvider[];
}

export const BYOK_PROVIDERS: ByokProviderInfo[] = [
    {
        id: 'openrouter',
        label: 'OpenRouter',
        header: 'x-byok-openrouter',
        usedFor: 'One key for narration, scene sketches, world memory (embeddings + summaries), AI images and the Gemini voice',
        keyUrl: 'https://openrouter.ai/settings/keys',
        placeholder: 'sk-or-v1-...',
        covers: ['deepseek', 'gemini', 'openai'],
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        header: 'x-byok-deepseek',
        usedFor: 'Game master narration, scene sketches, world summaries',
        keyUrl: 'https://platform.deepseek.com/api_keys',
        placeholder: 'sk-...',
    },
    {
        id: 'gemini',
        label: 'Gemini',
        header: 'x-byok-gemini',
        usedFor: 'Narration (if no DeepSeek key), AI images, Gemini voice',
        keyUrl: 'https://aistudio.google.com/apikey',
        placeholder: 'AIza...',
    },
    {
        id: 'openai',
        label: 'OpenAI',
        header: 'x-byok-openai',
        usedFor: 'Memory embeddings for the world memory (GraphRAG)',
        keyUrl: 'https://platform.openai.com/api-keys',
        placeholder: 'sk-...',
    },
    {
        id: 'elevenlabs',
        label: 'ElevenLabs',
        header: 'x-byok-elevenlabs',
        usedFor: 'ElevenLabs narrator voice',
        keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
        placeholder: 'sk_...',
    },
    {
        id: 'gcpTts',
        label: 'Google Cloud TTS',
        header: 'x-byok-gcp-tts',
        usedFor: 'Chirp 3 HD narrator voice (Cloud Text-to-Speech API key)',
        keyUrl: 'https://console.cloud.google.com/apis/credentials',
        placeholder: 'AIza...',
    },
];

export type ByokKeys = Partial<Record<ByokProvider, string>>;

export interface ByokStatus {
    required: boolean;
    providers: Partial<Record<ByokProvider, { label: string; serverKey: boolean }>>;
}

export class ByokError extends Error {
    code: string;
    provider: ByokProvider | null;
    constructor(message: string, code: string, provider: ByokProvider | null) {
        super(message);
        this.name = 'ByokError';
        this.code = code;
        this.provider = provider;
    }
}

const KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;

export function isValidKeyFormat(key: string): boolean {
    return KEY_PATTERN.test(key);
}

export function getByokKeys(): ByokKeys {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        const keys: ByokKeys = {};
        for (const { id } of BYOK_PROVIDERS) {
            const value = typeof parsed?.[id] === 'string' ? parsed[id].trim() : '';
            if (value && isValidKeyFormat(value)) keys[id] = value;
        }
        return keys;
    } catch {
        return {};
    }
}

export function setByokKeys(keys: ByokKeys) {
    const clean: ByokKeys = {};
    for (const { id } of BYOK_PROVIDERS) {
        const value = (keys[id] || '').trim();
        if (value && isValidKeyFormat(value)) clean[id] = value;
    }
    try {
        if (Object.keys(clean).length) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        // storage unavailable (private mode): keys simply aren't remembered
    }
    window.dispatchEvent(new CustomEvent('byok-keys-change'));
}

export function hasByokKey(provider: ByokProvider): boolean {
    return !!getByokKeys()[provider];
}

// Headers to attach to every backend request that may call a paid provider.
export function byokHeaders(): Record<string, string> {
    const keys = getByokKeys();
    const headers: Record<string, string> = {};
    for (const { id, header } of BYOK_PROVIDERS) {
        const key = keys[id];
        if (key) headers[header] = key;
    }
    return headers;
}

let cachedStatus: ByokStatus | null = null;

export async function fetchByokStatus(): Promise<ByokStatus | null> {
    try {
        const response = await fetch(`${BACKEND_URL}/api/byok/status`);
        if (!response.ok) return cachedStatus;
        cachedStatus = await response.json() as ByokStatus;
        return cachedStatus;
    } catch {
        return cachedStatus;
    }
}

// Whether a provider can work right now: the player has a key, or the server has one.
// Unknown status (not fetched yet / old backend) counts as usable.
export function canUseProvider(provider: ByokProvider): boolean {
    if (hasByokKey(provider)) return true;
    if (!cachedStatus) return true;
    return !!cachedStatus.providers?.[provider]?.serverKey;
}

export function canUseAnyProvider(providers: ByokProvider[]): boolean {
    return providers.some(canUseProvider);
}

// Turn a backend error body into a ByokError when it is a key problem.
export function toByokError(body: unknown): ByokError | null {
    const data = body as { error?: string; code?: string; provider?: string } | null;
    if (!data || typeof data.code !== 'string' || !data.code.startsWith('byok_')) return null;
    const provider = BYOK_PROVIDERS.some(p => p.id === data.provider) ? data.provider as ByokProvider : null;
    return new ByokError(data.error || 'API key problem.', data.code, provider);
}

export interface ByokWarning {
    provider: ByokProvider;
    code: string;
}

// The backend reports non-fatal key problems (e.g. rejected OpenAI key) in x-byok-warnings.
export function readByokWarnings(response: Response): ByokWarning[] {
    const raw = response.headers.get('x-byok-warnings');
    if (!raw) return [];
    return raw.split(',')
        .map(item => item.trim().split(':'))
        .filter(([provider, code]) => BYOK_PROVIDERS.some(p => p.id === provider) && !!code)
        .map(([provider, code]) => ({ provider: provider as ByokProvider, code }));
}

export function providerLabel(provider: ByokProvider | null): string {
    return BYOK_PROVIDERS.find(p => p.id === provider)?.label || 'API';
}

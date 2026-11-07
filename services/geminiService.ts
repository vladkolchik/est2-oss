import type { GameState } from '../types';
import type { SceneDescriptor } from './sceneRenderer';
import { byokHeaders, readByokWarnings, toByokError } from './byokService';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001');

const SESSION_STORAGE_KEY = 'gemini-fallout-rpg-sessionId';

function getStoredSessionId(): string | null {
    try {
        return localStorage.getItem(SESSION_STORAGE_KEY);
    } catch {
        return null;
    }
}

// Adopt an existing session (e.g. picked from the cloud session browser)
// so subsequent /api/action calls continue it.
export function adoptSessionId(sessionId: string) {
    setStoredSessionId(sessionId);
}

function setStoredSessionId(sessionId: string | null) {
    try {
        if (sessionId) {
            localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
        } else {
            localStorage.removeItem(SESSION_STORAGE_KEY);
        }
    } catch {
        // ignore storage errors
    }
}

export async function mintSession(): Promise<string> {
    const r = await fetch(`${BACKEND_URL}/api/mint-session`, { method: 'POST' });
    if (!r.ok) {
        throw new Error('Failed to mint session');
    }
    const j = await r.json();
    const sid = j.sessionId || r.headers.get('x-session-id');
    if (!sid) throw new Error('Minted session missing id');
    setStoredSessionId(sid);
    return sid;
}

export async function clearSession(sessionId?: string): Promise<void> {
    const sid = sessionId || getStoredSessionId();
    if (!sid) return;
    const r = await fetch(`${BACKEND_URL}/api/clear-session`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-session-id': sid,
        },
        body: JSON.stringify({ sessionId: sid })
    });
    if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to clear session');
    }
}

export async function getNextGameState(currentState: GameState, playerAction: string, mentions: string[] = []): Promise<Partial<GameState>> {
    try {
        const sid = getStoredSessionId();
        const normalizedMentions = Array.from(
            new Set(
                (Array.isArray(mentions) ? mentions : [])
                    .map((m) => String(m || '').trim())
                    .filter(Boolean)
            )
        ).slice(0, 12);

        const response = await fetch(`${BACKEND_URL}/api/action`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(sid ? { 'x-session-id': sid } : {}),
                ...byokHeaders(),
            },
            body: JSON.stringify({
                currentState: sid ? { ...currentState, sessionId: sid } : currentState,
                playerAction,
                mentions: normalizedMentions
            }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Backend error:', errorData);
            throw toByokError(errorData) || new Error(errorData.error || 'The radio signal is dead. The server is not responding.');
        }

        const warnings = readByokWarnings(response);
        if (warnings.length) {
            window.dispatchEvent(new CustomEvent('byok-warning', { detail: warnings }));
        }

        const data = await response.json();
        const newSid: string | null = data.sessionId || response.headers.get('x-session-id');
        if (newSid && newSid !== sid) {
            setStoredSessionId(newSid);
        }
        return data;
    } catch (error) {
        console.error("Error fetching next game state from backend:", error);
        if (error instanceof TypeError) { // Network error
            throw new Error('Cannot reach the backend server. Is it running?');
        }
        throw error;
    }
}

// Ask the backend "artist" agent (separate light-tier LLM call) for a scene
// descriptor that the client-side parametric renderer turns into an image.
export async function fetchSceneDescriptor(description: string, locationName?: string, ambience?: string): Promise<SceneDescriptor> {
    const response = await fetch(`${BACKEND_URL}/api/scene-descriptor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...byokHeaders() },
        body: JSON.stringify({ description, locationName, ambience }),
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw toByokError(errorData) || new Error(errorData.error || 'Failed to fetch scene descriptor.');
    }
    const data = await response.json();
    if (!data.descriptor) throw new Error('Scene descriptor missing in response.');
    return data.descriptor as SceneDescriptor;
}

export async function generateImage(prompt: string): Promise<string> {
    try {
        const sid = getStoredSessionId();
        const response = await fetch(`${BACKEND_URL}/api/generate-image`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(sid ? { 'x-session-id': sid } : {}),
                ...byokHeaders(),
            },
            body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Backend error (image gen):', errorData);
            const byokError = toByokError(errorData);
            if (byokError) throw byokError;
             // Propagate the specific quota error message if available
            if (errorData.error && errorData.error.includes('quota exceeded')) {
                throw new Error("Image generation quota exceeded. Check your API plan. Visuals are now disabled.");
            }
            throw new Error(errorData.error || 'Failed to generate image from backend.');
        }

        const data = await response.json();
        return data.imageUrl;
    } catch (error) {
        console.error("Error fetching image from backend:", error);
        if (error instanceof TypeError) { // Network error
            throw new Error('Cannot reach the backend server for image generation.');
        }
        throw error;
    }
}

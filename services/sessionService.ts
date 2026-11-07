import type { GameState } from '../types';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001');

const ACCESS_KEY_STORAGE_KEY = 'gemini-fallout-rpg-accesskey';

export interface SessionSummary {
    sessionId: string;
    name: string | null;
    createdAt: string;
    lastPlayedAt: string;
    turnCount: number;
    location: string | null;
    level: number | null;
    hp: string | null;
    isDead: boolean;
}

export interface SessionSnapshot {
    sessionId: string;
    turns: Array<{ turn_no: number; player_action: string; gm_description: string | null }>;
    lastTurn: {
        turnNo: number;
        currentState: Partial<GameState>;
        nextState: Partial<GameState>;
    };
}

export class SessionApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export function getStoredAccessKey(): string | null {
    try {
        return localStorage.getItem(ACCESS_KEY_STORAGE_KEY);
    } catch {
        return null;
    }
}

export function setStoredAccessKey(key: string | null) {
    try {
        if (key) {
            localStorage.setItem(ACCESS_KEY_STORAGE_KEY, key);
        } else {
            localStorage.removeItem(ACCESS_KEY_STORAGE_KEY);
        }
    } catch {
        // ignore storage errors
    }
}

async function sessionRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const key = getStoredAccessKey();
    let response: Response;
    try {
        response = await fetch(`${BACKEND_URL}${path}`, {
            ...init,
            headers: {
                'Content-Type': 'application/json',
                ...(key ? { 'x-access-key': key } : {}),
                ...(init.headers || {}),
            },
        });
    } catch {
        throw new SessionApiError('Cannot reach the backend server.', 0);
    }
    if (!response.ok) {
        const err = await response.json().catch(() => ({} as { error?: string }));
        throw new SessionApiError(err.error || `Request failed (${response.status})`, response.status);
    }
    return response.json() as Promise<T>;
}

export async function listSessions(): Promise<SessionSummary[]> {
    const data = await sessionRequest<{ sessions: SessionSummary[] }>('/api/sessions');
    return data.sessions || [];
}

export async function fetchSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    return sessionRequest<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
    await sessionRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
    });
}

export async function deleteSession(sessionId: string): Promise<void> {
    await sessionRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
    });
}

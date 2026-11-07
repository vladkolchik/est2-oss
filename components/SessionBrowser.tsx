
import React, { useCallback, useEffect, useState } from 'react';
import { soundService } from '../services/soundService';
import {
    listSessions,
    renameSession,
    deleteSession,
    getStoredAccessKey,
    setStoredAccessKey,
    SessionApiError,
    type SessionSummary,
} from '../services/sessionService';

interface SessionBrowserProps {
    onContinue: (sessionId: string) => void;
    disabled: boolean;
}

function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
        return iso;
    }
}

function sessionLabel(session: SessionSummary): string {
    return session.name || `Vault Log #${session.sessionId.slice(0, 8)}`;
}

const SessionBrowser: React.FC<SessionBrowserProps> = ({ onContinue, disabled }) => {
    const [hasKey, setHasKey] = useState<boolean>(() => !!getStoredAccessKey());
    const [keyInput, setKeyInput] = useState('');
    const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [unavailable, setUnavailable] = useState(false);

    const loadSessions = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const list = await listSessions();
            setSessions(list);
        } catch (e) {
            if (e instanceof SessionApiError && e.status === 401) {
                setStoredAccessKey(null);
                setHasKey(false);
                setSessions(null);
                setError('Access denied. Check the access code.');
            } else if (e instanceof SessionApiError && (e.status === 503 || e.status === 0)) {
                // Backend unreachable or cloud sessions not configured — hide quietly
                setUnavailable(true);
            } else {
                setError((e as Error).message);
            }
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasKey) {
            loadSessions();
        }
    }, [hasKey, loadSessions]);

    const handleConnect = (e: React.FormEvent) => {
        e.preventDefault();
        const key = keyInput.trim();
        if (!key) return;
        soundService.playUi('ui_menu_ok');
        setStoredAccessKey(key);
        setKeyInput('');
        setHasKey(true);
    };

    const handleRename = async (session: SessionSummary) => {
        const name = window.prompt('New session name:', session.name || '');
        if (name === null) return;
        try {
            await renameSession(session.sessionId, name);
            await loadSessions();
        } catch (e) {
            setError((e as Error).message);
        }
    };

    const handleDelete = async (session: SessionSummary) => {
        const confirmed = window.confirm(
            `Delete "${sessionLabel(session)}" permanently? This erases its whole story and long-term memory.`
        );
        if (!confirmed) return;
        try {
            await deleteSession(session.sessionId);
            await loadSessions();
        } catch (e) {
            setError((e as Error).message);
        }
    };

    if (unavailable) return null;

    return (
        <div className="mt-8 w-full max-w-2xl border-2 border-[#15ff00]/50 bg-black/50 p-4 text-[#15ff00]">
            <div className="flex justify-between items-baseline mb-3">
                <h2 className="text-2xl text-glow">CLOUD SESSIONS</h2>
                {hasKey && (
                    <button
                        onClick={() => { soundService.playUi('ui_click'); loadSessions(); }}
                        disabled={isLoading}
                        className="text-sm px-2 py-0.5 border border-[#15ff00]/50 hover:bg-[#15ff00]/10 disabled:opacity-50"
                    >
                        {isLoading ? 'SCANNING…' : 'REFRESH'}
                    </button>
                )}
            </div>

            {!hasKey ? (
                <form onSubmit={handleConnect} className="flex items-center gap-2 text-lg">
                    <span className="text-glow">&gt;</span>
                    <input
                        type="password"
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        placeholder="Enter access code..."
                        className="flex-grow bg-transparent border-b border-[#15ff00]/50 focus:outline-none focus:border-[#15ff00] text-[#15ff00] placeholder-[#15ff00]/40"
                        aria-label="Access code"
                    />
                    <button
                        type="submit"
                        className="px-3 py-1 border border-[#15ff00]/70 hover:bg-green-900/50 transition-colors"
                    >
                        CONNECT
                    </button>
                </form>
            ) : isLoading && sessions === null ? (
                <p className="opacity-70 animate-pulse">Contacting RobCo mainframe...</p>
            ) : sessions && sessions.length > 0 ? (
                <ul className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {sessions.map((session) => (
                        <li key={session.sessionId} className="border border-[#15ff00]/30 p-2 flex items-center gap-3">
                            <div className="flex-grow min-w-0">
                                <p className={`font-bold truncate ${session.isDead ? 'text-red-400' : 'text-glow'}`}>
                                    {sessionLabel(session)} {session.isDead && <span className="text-sm">[DECEASED]</span>}
                                </p>
                                <p className="text-sm opacity-70 truncate">
                                    {session.level ? `LVL ${session.level} · ` : ''}
                                    {session.location ? `${session.location} · ` : ''}
                                    {session.turnCount} turns · {formatDate(session.lastPlayedAt)}
                                </p>
                            </div>
                            <button
                                onMouseEnter={() => soundService.playUi('ui_menu_focus')}
                                onClick={() => { soundService.playUi('ui_menu_ok'); onContinue(session.sessionId); }}
                                disabled={disabled}
                                className="px-3 py-1 border border-[#15ff00]/70 hover:bg-green-900/50 transition-colors text-glow disabled:opacity-50 shrink-0"
                            >
                                CONTINUE
                            </button>
                            <button
                                onClick={() => handleRename(session)}
                                disabled={disabled}
                                className="px-2 py-1 border border-[#15ff00]/40 hover:bg-[#15ff00]/10 transition-colors text-sm disabled:opacity-50 shrink-0"
                                title="Rename session"
                            >
                                REN
                            </button>
                            <button
                                onClick={() => handleDelete(session)}
                                disabled={disabled}
                                className="px-2 py-1 border border-red-500/50 text-red-400 hover:bg-red-900/30 transition-colors text-sm disabled:opacity-50 shrink-0"
                                title="Delete session permanently"
                            >
                                DEL
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="opacity-70">No sessions recorded in the mainframe yet.</p>
            )}

            {error && <p className="mt-2 text-red-500 text-sm">{error}</p>}
        </div>
    );
};

export default SessionBrowser;

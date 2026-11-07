import React, { useEffect, useRef, useState } from 'react';
import { soundService } from '../services/soundService';
import {
    BYOK_PROVIDERS,
    fetchByokStatus,
    getByokKeys,
    isValidKeyFormat,
    setByokKeys,
    type ByokKeys,
    type ByokProvider,
    type ByokStatus,
} from '../services/byokService';

interface ApiKeysModalProps {
    onClose: () => void;
    // Provider to draw attention to (e.g. after the server rejected or required its key)
    focusProvider?: ByokProvider | null;
    message?: string | null;
}

const ApiKeysModal: React.FC<ApiKeysModalProps> = ({ onClose, focusProvider, message }) => {
    const [draft, setDraft] = useState<ByokKeys>(() => getByokKeys());
    const [saved, setSaved] = useState<ByokKeys>(() => getByokKeys());
    const [visible, setVisible] = useState<Partial<Record<ByokProvider, boolean>>>({});
    const [status, setStatus] = useState<ByokStatus | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const focusRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let alive = true;
        fetchByokStatus().then((s) => { if (alive) setStatus(s); });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        focusRef.current?.focus();
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const invalid = BYOK_PROVIDERS.filter(({ id }) => {
        const value = (draft[id] || '').trim();
        return value && !isValidKeyFormat(value);
    });
    const dirty = BYOK_PROVIDERS.some(({ id }) => (draft[id] || '').trim() !== (saved[id] || ''));

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault();
        if (invalid.length) return;
        soundService.playUi('ui_menu_ok');
        setByokKeys(draft);
        const stored = getByokKeys();
        setSaved(stored);
        setDraft(stored);
        setNotice('Keys saved on this device.');
    };

    const handleClearAll = () => {
        soundService.playUi('ui_click');
        setByokKeys({});
        setSaved({});
        setDraft({});
        setNotice('All keys removed from this device.');
    };

    const coveredBy = (id: ByokProvider) =>
        BYOK_PROVIDERS.find(p => p.id !== id && p.covers?.includes(id) && saved[p.id]);

    const badgeFor = (id: ByokProvider) => {
        if (saved[id]) return { text: 'YOUR KEY', cls: 'border-[#15ff00] text-glow' };
        const via = coveredBy(id);
        if (via) return { text: `VIA ${via.label.toUpperCase()}`, cls: 'border-[#15ff00]/60 opacity-80' };
        if (status?.providers?.[id]?.serverKey) return { text: 'SERVER KEY', cls: 'border-[#15ff00]/40 opacity-70' };
        if (status?.required) return { text: 'NEEDED', cls: 'border-yellow-400/70 text-yellow-300' };
        if (status) return { text: 'NOT SET', cls: 'border-[#15ff00]/30 opacity-60' };
        return null;
    };

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="api-keys-title">
            <form
                onSubmit={handleSave}
                onClick={e => e.stopPropagation()}
                className="w-full max-w-2xl max-h-[90vh] border-2 border-[#15ff00]/50 bg-black/95 flex flex-col text-[#15ff00]"
            >
                <div className="flex justify-between items-center px-4 sm:px-6 pt-4 sm:pt-6 pb-2">
                    <h2 id="api-keys-title" className="text-3xl sm:text-4xl text-glow">API KEYS</h2>
                    <button type="button" onClick={onClose} className="text-3xl px-3 py-1 border-2 border-transparent hover:border-[#15ff00]/50 transition-colors" aria-label="Close API keys">
                        &times;
                    </button>
                </div>

                <div className="flex-grow overflow-y-auto px-4 sm:px-6 pb-2 space-y-4">
                    <p className="text-base opacity-80">
                        {status?.required
                            ? 'This terminal runs on your own keys. Narration needs an OpenRouter, DeepSeek or Gemini key; the rest are optional.'
                            : 'Optional. Your keys replace the server’s for your requests, so usage is billed to you.'}
                        {' '}An OpenRouter key alone covers everything except the ElevenLabs and Chirp voices.
                    </p>
                    {message && (
                        <p className="text-base text-red-400 border border-red-500/50 bg-red-900/20 px-3 py-2" role="alert">{message}</p>
                    )}

                    <ul className="space-y-4">
                        {BYOK_PROVIDERS.map((provider) => {
                            const badge = badgeFor(provider.id);
                            const value = draft[provider.id] || '';
                            const isInvalid = invalid.some(p => p.id === provider.id);
                            const isFocus = focusProvider === provider.id;
                            const inputId = `byok-${provider.id}`;
                            return (
                                <li key={provider.id} className={`border p-3 ${isFocus ? 'border-yellow-400/70' : 'border-[#15ff00]/30'}`}>
                                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                        <label htmlFor={inputId} className="text-xl font-bold">{provider.label}</label>
                                        <div className="flex items-center gap-3 text-sm">
                                            {badge && <span className={`px-2 py-0.5 border ${badge.cls}`}>{badge.text}</span>}
                                            <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer" className="underline opacity-80 hover:opacity-100">GET KEY</a>
                                        </div>
                                    </div>
                                    <p className="text-sm opacity-70 mb-2">{provider.usedFor}</p>
                                    <div className="flex items-center gap-2">
                                        <span className="text-glow">&gt;</span>
                                        <input
                                            id={inputId}
                                            ref={isFocus || (!focusProvider && provider.id === BYOK_PROVIDERS[0].id) ? focusRef : undefined}
                                            type={visible[provider.id] ? 'text' : 'password'}
                                            value={value}
                                            onChange={(e) => { setNotice(null); setDraft(prev => ({ ...prev, [provider.id]: e.target.value })); }}
                                            placeholder={provider.placeholder}
                                            autoComplete="off"
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                            spellCheck={false}
                                            className="min-w-0 flex-grow bg-transparent border-b border-[#15ff00]/50 focus:outline-none focus:border-[#15ff00] text-[#15ff00] placeholder-[#15ff00]/30 text-base py-1"
                                            aria-invalid={isInvalid}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setVisible(prev => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                                            className="px-2 py-1 border border-[#15ff00]/40 hover:bg-[#15ff00]/10 text-sm shrink-0"
                                            aria-label={visible[provider.id] ? `Hide ${provider.label} key` : `Show ${provider.label} key`}
                                        >
                                            {visible[provider.id] ? 'HIDE' : 'SHOW'}
                                        </button>
                                        {value && (
                                            <button
                                                type="button"
                                                onClick={() => { setNotice(null); setDraft(prev => ({ ...prev, [provider.id]: '' })); }}
                                                className="px-2 py-1 border border-red-500/50 text-red-400 hover:bg-red-900/30 text-sm shrink-0"
                                                aria-label={`Remove ${provider.label} key`}
                                            >
                                                DEL
                                            </button>
                                        )}
                                    </div>
                                    {isInvalid && <p className="text-sm text-red-400 mt-1">Key must be printable characters with no spaces.</p>}
                                </li>
                            );
                        })}
                    </ul>

                    <p className="text-sm opacity-60">
                        Keys are kept only in this browser. They are sent to the game server with each request, used for that request and never saved on the server.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 border-t border-[#15ff00]/30 px-4 sm:px-6 py-3">
                    <button
                        type="submit"
                        disabled={!dirty || invalid.length > 0}
                        className="px-5 py-2 bg-green-900/50 border-2 border-[#15ff00] text-lg text-glow hover:bg-green-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        SAVE
                    </button>
                    <button
                        type="button"
                        onClick={handleClearAll}
                        disabled={!Object.keys(saved).length && !Object.values(draft).some(Boolean)}
                        className="px-4 py-2 border border-red-500/50 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        CLEAR ALL
                    </button>
                    {notice && <span className="text-base opacity-90" role="status">{notice}</span>}
                </div>
            </form>
        </div>
    );
};

export default ApiKeysModal;

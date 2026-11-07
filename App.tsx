
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Howl, Howler } from 'howler';
import type { GameState, StoryEntry, SPECIAL } from './types';
import { getNextGameState, generateImage, fetchSceneDescriptor, mintSession, adoptSessionId } from './services/geminiService';
import { fetchSessionSnapshot } from './services/sessionService';
import { parseDescriptionEntries, applyGameUpdate } from './services/gameStateUtils';
import SessionBrowser from './components/SessionBrowser';
import { renderScene } from './services/sceneRenderer';
import { getCachedDescriptor, cacheDescriptor, clearSceneCache } from './services/sceneCache';
import { INITIAL_GAME_STATE, GAME_TITLE, AMBIENT_SOUNDS } from './constants';
import type { CharacterProfile } from './characterPresets';
import CharacterCreation from './components/CharacterCreation';
import StoryDisplay from './components/StoryDisplay';
import PlayerInput from './components/PlayerInput';
import StatusBar from './components/StatusBar';
import Inventory from './components/Inventory';
import QuestLog from './components/QuestLog';
import QuestLogModal from './components/QuestLogModal';
import InventoryModal from './components/InventoryModal';
import LevelUpModal from './components/LevelUpModal';
import GameHeader from './components/GameHeader';
import LoadingScreen from './components/LoadingScreen';
import GameOverScreen from './components/GameOverScreen';
import ActionButtons from './components/ActionButtons';
import MapModal from './components/MapModal';
import ImageViewer from './components/ImageViewer';
import ApiKeysModal from './components/ApiKeysModal';
import { ByokError, fetchByokStatus, providerLabel, type ByokProvider, type ByokWarning } from './services/byokService';
import { ttsService } from './services/ttsService';
import { soundService } from './services/soundService';

const SAVE_KEY_GAMESTATE = 'gemini-fallout-rpg-gamestate';
const SAVE_KEY_STORY = 'gemini-fallout-rpg-storyhistory';
const SAVE_KEY_AUDIO = 'gemini-fallout-rpg-audio';
const AMBIENCE_VOLUME = (() => { try { return Number(localStorage.getItem('ambient-volume') || '0.6'); } catch { return 0.6; } })();
const CROSSFADE_MS = 2500;
const BRACED_MENTION_REGEX = /@\{([^}]+)\}/g;
const SIMPLE_MENTION_REGEX = /(^|\s)@([^\s@{}]+)/g;

function extractMentionsFromText(text: string): string[] {
  const input = String(text || '');
  if (!input) return [];

  const collected: string[] = [];
  let match: RegExpExecArray | null;

  BRACED_MENTION_REGEX.lastIndex = 0;
  while ((match = BRACED_MENTION_REGEX.exec(input)) !== null) {
    const value = String(match[1] || '').trim();
    if (value) collected.push(value);
  }

  SIMPLE_MENTION_REGEX.lastIndex = 0;
  while ((match = SIMPLE_MENTION_REGEX.exec(input)) !== null) {
    const value = String(match[2] || '').trim();
    if (value) collected.push(value);
  }

  return Array.from(new Set(collected)).slice(0, 12);
}

function buildMentionOptions(state: GameState): string[] {
  const options = new Set<string>();

  if (state?.location?.name) options.add(state.location.name);
  for (const npc of state?.npcs || []) {
    if (npc?.name) options.add(npc.name);
  }
  for (const quest of state?.quests || []) {
    if (quest?.name) options.add(quest.name);
  }
  for (const loc of state?.discoveredLocations || []) {
    if (loc?.name) options.add(loc.name);
  }
  for (const item of state?.player?.inventory || []) {
    if (item?.name) options.add(item.name);
  }

  return Array.from(options).slice(0, 64);
}

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(INITIAL_GAME_STATE);
  const [storyHistory, setStoryHistory] = useState<StoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isStarted, setIsStarted] = useState<boolean>(false);
  const [isCreatingCharacter, setIsCreatingCharacter] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isQuestLogOpen, setIsQuestLogOpen] = useState<boolean>(false);
  const [inventoryModal, setInventoryModal] = useState<{ open: boolean; itemName?: string }>({ open: false });
  const [isLevelUpOpen, setIsLevelUpOpen] = useState<boolean>(false);
  const [isMapOpen, setIsMapOpen] = useState<boolean>(false);
  const [saveFileExists, setSaveFileExists] = useState<boolean>(false);
  const [saveMessage, setSaveMessage] = useState<string>('');
  const [isRadioPlaying, setIsRadioPlaying] = useState<boolean>(false);
  // BYOK: own API keys dialog, opened from the menu or when the server rejects/requires a key
  const [apiKeysModal, setApiKeysModal] = useState<{ open: boolean; provider?: ByokProvider | null; message?: string | null }>({ open: false });
  const [byokWarning, setByokWarning] = useState<{ provider: ByokProvider; text: string } | null>(null);
  const latestSequenceRef = useRef<{ id: string; segments: { type: 'narrative' | 'dialogue'; text: string; gender?: 'male' | 'female' | 'unknown'; speaker?: string }[] } | null>(null);

  const [isImageGenEnabled, setIsImageGenEnabled] = useState<boolean>(true);
  // 'sketch' — cheap parametric render via the artist agent; 'ai' — full image model
  const [imageMode, setImageMode] = useState<'sketch' | 'ai'>(() => {
    try { return localStorage.getItem('image-mode') === 'ai' ? 'ai' : 'sketch'; } catch { return 'sketch'; }
  });
  const [isGeneratingImage, setIsGeneratingImage] = useState<boolean>(false);
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(null);
  const [imageGenError, setImageGenError] = useState<string | null>(null);
  const [lastTriedAction, setLastTriedAction] = useState<string | null>(null);
  // Stable narration batch id per user-initiated update
  const currentNarrationBatchIdRef = useRef<string | null>(null);
  
  // Howler.js ambience instance and current key
  const ambienceRef = useRef<Howl | null>(null);
  const ambienceKeyRef = useRef<string | null>(null);
  const mentionOptions = useMemo(() => buildMentionOptions(gameState), [gameState]);

  useEffect(() => {
    const savedGameState = localStorage.getItem(SAVE_KEY_GAMESTATE);
    if (savedGameState) {
        setSaveFileExists(true);
    }
  }, []);

  // Mute/unmute globally
  useEffect(() => {
    Howler.mute(isMuted);
  }, [isMuted]);

  // Handle ambience playback with howler.js
  useEffect(() => {
    const nextKey = !isStarted ? 'main_menu' : (gameState.ambience || 'desert_wind');
    const nextSrc = AMBIENT_SOUNDS[nextKey as keyof typeof AMBIENT_SOUNDS] || AMBIENT_SOUNDS.desert_wind;
    const sources = Array.isArray(nextSrc) ? nextSrc : [nextSrc];
    
    console.log('🎵 Ambience change:', { nextKey, nextSrc, sources, isStarted, isMuted });

    // If the same ambience is already active, ensure play/pause matches mute state
    if (ambienceKeyRef.current === nextKey && ambienceRef.current) {
      const snd = ambienceRef.current;
      if (!isMuted) {
        // Try play if not playing
        try {
          // Ensure volume is up when unmuting
          const ambientBase = Number(localStorage.getItem('ambient-volume') || AMBIENCE_VOLUME);
          const targetVol = isRadioPlaying ? ambientBase * 0.35 : ambientBase;
          snd.volume(targetVol);
          snd.play();
        } catch (_) {}
      } else {
        try {
          // Gentle fade on mute
          snd.fade(snd.volume(), 0, CROSSFADE_MS);
          snd.pause();
        } catch (_) {}
      }
      return;
    }

    // Swap ambience track with crossfade
    try {
      // Stop and unload previous
      if (ambienceRef.current) {
        const prev = ambienceRef.current;
        try {
          const fromVol = prev.volume();
          // Fade out previous, then stop/unload
          prev.fade(fromVol, 0, CROSSFADE_MS);
          prev.once('fade', () => {
            try { prev.stop(); } catch (_) {}
            try { prev.unload(); } catch (_) {}
          });
        } catch (_) {
          try { prev.stop(); } catch (_) {}
          try { prev.unload(); } catch (_) {}
        }
      }

      const snd = new Howl({
        src: sources,
        loop: true,
        volume: 0,
        html5: false,
        onplayerror: () => {
          // Retry after unlock as per howler docs
          snd.once('unlock', () => {
            if (!isMuted) snd.play();
          });
        },
      });

      ambienceRef.current = snd;
      ambienceKeyRef.current = nextKey;

      if (!isMuted) {
        try {
          const ambientBase = Number(localStorage.getItem('ambient-volume') || AMBIENCE_VOLUME);
          const targetVol = isRadioPlaying ? ambientBase * 0.35 : ambientBase;
          
          // Start playing at 0 volume
          snd.volume(0);
          snd.play();
          
          // Delay fade-in slightly to overlap with fade-out
          setTimeout(() => {
            snd.fade(0, targetVol, CROSSFADE_MS - 500);
          }, 500);
        } catch (_) {}
      }
    } catch (e) {
      console.warn('Failed to initialize ambience sound:', e);
    }

    // Cleanup when component unmounts
    return () => {
      if (ambienceRef.current) {
        try { ambienceRef.current.stop(); } catch (_) {}
        try { ambienceRef.current.unload(); } catch (_) {}
        ambienceRef.current = null;
        ambienceKeyRef.current = null;
      }
    };
  }, [gameState.ambience, isStarted, isMuted, isRadioPlaying]);

  // React live to ambient-volume-change from SoundControls
  useEffect(() => {
    const handler = (e: Event) => {
      const v = (e as CustomEvent).detail?.volume;
      if (typeof v !== 'number') return;
      const snd = ambienceRef.current;
      if (!snd) return;
      try {
        const targetVol = isRadioPlaying ? v * 0.35 : v;
        snd.volume(targetVol);
      } catch {}
    };
    window.addEventListener('ambient-volume-change', handler as EventListener);
    return () => window.removeEventListener('ambient-volume-change', handler as EventListener);
  }, [isRadioPlaying]);

  // Play UI/action sounds in a few key places
  useEffect(() => {
    // Example: play a subtle confirm when a new narration batch starts
    const id = currentNarrationBatchIdRef.current;
    if (id) {
      try { soundService.playAction('action_confirm'); } catch {}
    }
  }, [currentNarrationBatchIdRef.current]);

  const handleImageGeneration = useCallback(async (description: string, locationName?: string, ambience?: string) => {
    if (!isImageGenEnabled || !description) return;

    setImageGenError(null);

    // Sketch mode: show a cached frame for known locations instantly,
    // then refresh it silently once the artist agent responds.
    const cached = imageMode === 'sketch' && locationName ? getCachedDescriptor(locationName) : null;
    if (cached) {
        setCurrentImageUrl(renderScene(cached));
    }
    setIsGeneratingImage(!cached);

    try {
        if (imageMode === 'sketch') {
            const descriptor = await fetchSceneDescriptor(description, locationName, ambience);
            if (locationName) cacheDescriptor(locationName, descriptor);
            setCurrentImageUrl(renderScene(descriptor));
        } else {
            const imageUrl = await generateImage(description);
            setCurrentImageUrl(imageUrl);
        }
    } catch (e) {
        const err = e as Error;
        console.error("Image generation failed:", err.message);
        if (cached) {
            // Keep the cached frame; a failed refresh is not worth an error banner
            console.warn('Scene refresh failed, keeping cached frame.');
        } else {
            setCurrentImageUrl(null);
            setImageGenError(err.message);
        }

        // If it's a quota error, automatically disable the feature
        if (err.message.includes('quota exceeded')) {
            setIsImageGenEnabled(false);
        }
    } finally {
        setIsGeneratingImage(false);
    }
  }, [isImageGenEnabled, imageMode]);

  const processGameUpdate = useCallback((update: Partial<GameState>, actionText?: string) => {
    if (actionText) {
        setStoryHistory(prev => [...prev, { type: 'action', text: actionText }]);
    }
    if (update.description) {
        const { entries, sequence } = parseDescriptionEntries(update.description);
        setStoryHistory(prev => [...prev, ...entries]);
        // Use stable id for this batch (set at action start)
        const sequenceId = currentNarrationBatchIdRef.current || `seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        latestSequenceRef.current = { id: sequenceId, segments: sequence };
        handleImageGeneration(update.description, update.location?.name, update.ambience);
    }

    setGameState(prev => {
        const { state, leveledUp } = applyGameUpdate(prev, update);
        if (leveledUp) {
            setTimeout(() => setIsLevelUpOpen(true), 500);
        }
        return state;
    });
  }, [handleImageGeneration]);

  // Prime the BYOK status cache (lets TTS skip voices without a usable key) and surface
  // non-fatal key problems the backend reports, such as a rejected OpenAI key.
  useEffect(() => {
    fetchByokStatus();
    const onWarning = (e: Event) => {
      const warnings = (e as CustomEvent).detail as ByokWarning[];
      const problem = warnings.find(w => w.code === 'byok_key_invalid' || w.code === 'byok_no_credits');
      if (problem) {
        const label = providerLabel(problem.provider);
        const what = problem.code === 'byok_no_credits' ? `${label}: not enough credits.` : `${label} rejected your API key.`;
        setByokWarning({ provider: problem.provider, text: `${what} Memory embeddings are paused until it is fixed.` });
      }
    };
    window.addEventListener('byok-warning', onWarning);
    return () => window.removeEventListener('byok-warning', onWarning);
  }, []);

  const openApiKeys = useCallback((provider: ByokProvider | null = null, message: string | null = null) => {
    setApiKeysModal({ open: true, provider, message });
  }, []);

  const closeApiKeys = useCallback(() => {
    setApiKeysModal({ open: false });
    setByokWarning(null);
    fetchByokStatus();
  }, []);

  // Restore a session recorded in the cloud (Supabase turns log): rebuild the
  // story from turn history and the game state from the last turn's pair.
  const handleContinueSession = useCallback(async (sessionId: string) => {
    setIsLoading(true);
    setError(null);
    try {
        const snapshot = await fetchSessionSnapshot(sessionId);

        const story: StoryEntry[] = [];
        for (const turn of snapshot.turns) {
            // Turn 1 is the synthetic "The game begins..." prompt — not a player action
            if (turn.turn_no > 1 && turn.player_action) {
                story.push({ type: 'action', text: turn.player_action });
            }
            if (turn.gm_description) {
                story.push(...parseDescriptionEntries(turn.gm_description).entries);
            }
        }

        const base: GameState = {
            ...INITIAL_GAME_STATE,
            ...snapshot.lastTurn.currentState,
            player: { ...INITIAL_GAME_STATE.player, ...(snapshot.lastTurn.currentState.player || {}) },
        };
        const { state, leveledUp } = applyGameUpdate(base, snapshot.lastTurn.nextState);

        adoptSessionId(sessionId);
        setGameState(state);
        setStoryHistory(story);
        clearSceneCache();
        setCurrentImageUrl(null);
        // Mirror into the local quick-save slot so LOAD LAST SAVE matches this session
        try {
            localStorage.setItem(SAVE_KEY_GAMESTATE, JSON.stringify(state));
            localStorage.setItem(SAVE_KEY_STORY, JSON.stringify(story));
            setSaveFileExists(true);
        } catch {}
        setIsStarted(true);
        if (leveledUp) {
            setTimeout(() => setIsLevelUpOpen(true), 500);
        }
    } catch (e) {
        console.error('Failed to continue cloud session:', e);
        setError((e as Error).message || 'Failed to load session from the cloud.');
    } finally {
        setIsLoading(false);
    }
  }, []);
  
  const startGame = useCallback(async (profile?: CharacterProfile) => {
    setIsLoading(true);
    setError(null);
    const baseState: GameState = profile ? {
        ...INITIAL_GAME_STATE,
        description: profile.background,
        player: {
            ...INITIAL_GAME_STATE.player,
            ...(profile.name ? { name: profile.name } : {}),
            background: profile.background,
            special: profile.special,
            inventory: profile.inventory,
            statusEffects: profile.statusEffects,
        },
    } : INITIAL_GAME_STATE;
    if (!isStarted) {
        setStoryHistory([]);
        setGameState(baseState);
    }
    setCurrentImageUrl(null);
    setImageGenError(null);
    try {
        // Start a new narration batch for the initial scenario
        currentNarrationBatchIdRef.current = `seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // Clear any previous TTS cache to avoid mixing across sessions
        try { ttsService.clearCache(); } catch {}
        setIsMuted(false); // Enable audio on user interaction
        // Ensure we have a session id
        try { await mintSession(); } catch {}
        const openingAction = profile
            ? `The game begins. The player character is ${profile.name || 'an unnamed drifter'}. Background: ${profile.background} Generate the starting scenario for them in the Mojave desert, reflecting this background and their S.P.E.C.I.A.L. stats, and ${profile.openingHint}.`
            : "The game begins. Generate the starting scenario for a lone wanderer in the Mojave desert, and create a starting quest to find out who they are.";
        const initialState = await getNextGameState(baseState, openingAction);
        processGameUpdate(initialState);
    } catch (e) {
        console.error(e);
        if (e instanceof ByokError) {
            setError(e.message);
            openApiKeys(e.provider, e.message);
        } else {
            setError('Failed to initialize the wasteland. The signal is lost. Please refresh and try again.');
        }
    } finally {
        setIsLoading(false);
        setIsStarted(true);
        setIsCreatingCharacter(false);
    }
  }, [processGameUpdate, isStarted, openApiKeys]);

  const handlePlayerAction = async (action: string, mentions: string[] = []) => {
    if (!action.trim() || isLoading || isLevelUpOpen) return;
    setIsLoading(true);
    setError(null);
    setGameState(prev => ({...prev, suggestedActions: [] }));
    setLastTriedAction(action);
    // New narration batch id for this action
    currentNarrationBatchIdRef.current = `seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Clear TTS cache to avoid cross-action reuse; ensures caching only within one action batch
    try { ttsService.clearCache(); } catch {}
    
    try {
      const actionMentions = mentions.length ? mentions : extractMentionsFromText(action);
      const nextState = await getNextGameState(gameState, action, actionMentions);
      processGameUpdate(nextState, action);
    } catch (e) {
      console.error(e);
      const errorMessage = e instanceof ByokError
        ? e.message
        : 'Radio interference... Command not understood. Try something else.';
      if (e instanceof ByokError) openApiKeys(e.provider, e.message);
      setError(errorMessage);
      setStoryHistory(prev => [...prev, { type: 'error', text: errorMessage }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLevelUpConfirm = (newSpecial: SPECIAL) => {
    setGameState(prev => ({
        ...prev,
        player: {
            ...prev.player,
            special: newSpecial,
            specialPoints: 0
        }
    }));
    setIsLevelUpOpen(false);
  };

  const handleSaveGame = () => {
    try {
        localStorage.setItem(SAVE_KEY_GAMESTATE, JSON.stringify(gameState));
        localStorage.setItem(SAVE_KEY_STORY, JSON.stringify(storyHistory));
        // Persist audio config alongside the save
        const audioConfig = {
          isMuted,
          radioVolume: Number(localStorage.getItem('radio-volume') || '0.6'),
          radioStation: localStorage.getItem('radio-station') || 'new_vegas',
          narratorVolume: Number(localStorage.getItem('narrator-volume') || '0.8'),
          ambientVolume: Number(localStorage.getItem('ambient-volume') || '0.6'),
          uiVolume: Number(localStorage.getItem('ui-volume') || '0.8'),
        };
        localStorage.setItem(SAVE_KEY_AUDIO, JSON.stringify(audioConfig));
        setSaveFileExists(true);
        setSaveMessage('Game Saved!');
        setTimeout(() => setSaveMessage(''), 2000); // Message disappears after 2s
    } catch (e) {
        console.error("Failed to save game:", e);
        setSaveMessage('Error Saving!');
        setTimeout(() => setSaveMessage(''), 2000);
    }
  };

  const handleLoadGame = () => {
      try {
          const savedGameStateJSON = localStorage.getItem(SAVE_KEY_GAMESTATE);
          const savedStoryHistoryJSON = localStorage.getItem(SAVE_KEY_STORY);

          if (savedGameStateJSON && savedStoryHistoryJSON) {
              const loadedGameState = JSON.parse(savedGameStateJSON) as GameState;
              const loadedStoryHistory = JSON.parse(savedStoryHistoryJSON) as StoryEntry[];

              setGameState(loadedGameState);
              setStoryHistory(loadedStoryHistory);
              setIsStarted(true);
              // Restore audio config if available
              try {
                  const audioJSON = localStorage.getItem(SAVE_KEY_AUDIO);
                  if (audioJSON) {
                      const audio = JSON.parse(audioJSON) as {
                          isMuted?: boolean; radioVolume?: number; radioStation?: string;
                          narratorVolume?: number; ambientVolume?: number; uiVolume?: number;
                      };
                      if (typeof audio.isMuted === 'boolean') setIsMuted(audio.isMuted);
                      if (typeof audio.radioVolume === 'number') {
                          try { localStorage.setItem('radio-volume', String(audio.radioVolume)); } catch {}
                          window.dispatchEvent(new CustomEvent('radio-volume-change', { detail: { volume: audio.radioVolume } }));
                      }
                      if (typeof audio.radioStation === 'string') {
                          try { localStorage.setItem('radio-station', audio.radioStation); } catch {}
                          window.dispatchEvent(new CustomEvent('radio-station-change', { detail: { station: audio.radioStation } }));
                      }
                      if (typeof audio.narratorVolume === 'number') {
                          try { localStorage.setItem('narrator-volume', String(audio.narratorVolume)); } catch {}
                          try { ttsService.setNarratorVolume(audio.narratorVolume); } catch {}
                      }
                      if (typeof audio.ambientVolume === 'number') {
                          try { localStorage.setItem('ambient-volume', String(audio.ambientVolume)); } catch {}
                          window.dispatchEvent(new CustomEvent('ambient-volume-change', { detail: { volume: audio.ambientVolume } }));
                          window.dispatchEvent(new CustomEvent('action-volume-change', { detail: { volume: audio.ambientVolume } }));
                      }
                      if (typeof audio.uiVolume === 'number') {
                          try { localStorage.setItem('ui-volume', String(audio.uiVolume)); } catch {}
                          window.dispatchEvent(new CustomEvent('ui-volume-change', { detail: { volume: audio.uiVolume } }));
                      }
                  } else {
                      setIsMuted(false);
                  }
              } catch {
                  setIsMuted(false);
              }
              setError(null);
              setCurrentImageUrl(null);
              setImageGenError(null);
          } else {
              setError("No save file found or it's corrupted.");
          }
      } catch (e) {
          console.error("Failed to load game:", e);
          setError("Failed to load save file. It may be corrupted.");
          localStorage.removeItem(SAVE_KEY_GAMESTATE);
          localStorage.removeItem(SAVE_KEY_STORY);
          setSaveFileExists(false);
      }
  };

  // UX: New Game starts a fresh session; the previous one stays in the cloud
  // and can be resumed from the session browser (or deleted there explicitly).
  const handleNewGameClick = useCallback(async () => {
    const hasSave = !!localStorage.getItem(SAVE_KEY_GAMESTATE);
    if (hasSave) {
      const confirm = window.confirm('Start a new game session? Your current playthrough stays saved in the cloud and can be resumed from the sessions list.');
      if (!confirm) return;
      localStorage.removeItem(SAVE_KEY_GAMESTATE);
      localStorage.removeItem(SAVE_KEY_STORY);
      clearSceneCache();
      setSaveFileExists(false);
    }
    setIsCreatingCharacter(true);
  }, []);
  
  const toggleMute = () => setIsMuted(prev => !prev);
  
  const handleToggleImageMode = () => {
    setImageMode(prev => {
      const next = prev === 'sketch' ? 'ai' : 'sketch';
      try { localStorage.setItem('image-mode', next); } catch {}
      return next;
    });
  };

  const handleToggleImageGen = () => {
    setIsImageGenEnabled(prev => {
        const newState = !prev;
        if (!newState) {
            setCurrentImageUrl(null);
        } else {
            // If we are enabling it, clear any previous errors.
            setImageGenError(null);
        }
        return newState;
    });
  };

  const apiKeysModalEl = apiKeysModal.open ? (
      <ApiKeysModal onClose={closeApiKeys} focusProvider={apiKeysModal.provider} message={apiKeysModal.message} />
  ) : null;

  if (!isStarted) {
      if (isCreatingCharacter) {
          return (
              <>
                  <CharacterCreation
                      onConfirm={startGame}
                      onCancel={() => setIsCreatingCharacter(false)}
                      disabled={isLoading}
                  />
                  {error && <p className="fixed bottom-4 left-1/2 -translate-x-1/2 text-red-500 bg-black/80 px-3 py-1">{error}</p>}
                  {apiKeysModalEl}
              </>
          );
      }
      return (
          <div className="w-full h-screen flex flex-col items-center justify-center bg-black p-4">
              {/* ambience handled by howler.js */}
              <h1 className="text-6xl text-glow mb-4">{GAME_TITLE}</h1>
              <p className="text-xl mb-8">A Gemini-Powered Text Adventure</p>
              <div className="flex flex-col sm:flex-row gap-4">
                <button 
                    onClick={handleNewGameClick}
                    disabled={isLoading}
                    className="px-8 py-4 bg-green-900/50 border-2 border-[#15ff00] text-[#15ff00] text-2xl hover:bg-green-800/50 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed text-glow"
                >
                    NEW GAME
                </button>
                {saveFileExists && (
                    <button
                        onClick={handleLoadGame}
                        disabled={isLoading}
                        className="px-8 py-4 bg-black/50 border-2 border-[#15ff00]/70 text-[#15ff00] text-2xl hover:bg-green-900/50 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed text-glow"
                    >
                        LOAD LAST SAVE
                    </button>
                )}
                <button
                    onClick={() => { soundService.playUi('ui_menu_ok'); openApiKeys(); }}
                    className="px-8 py-4 bg-black/50 border-2 border-[#15ff00]/50 text-[#15ff00] text-2xl hover:bg-green-900/50 transition-all duration-300 text-glow"
                >
                    API KEYS
                </button>
              </div>
              <SessionBrowser onContinue={handleContinueSession} disabled={isLoading} />
              {error && <p className="mt-4 text-red-500">{error}</p>}
              {apiKeysModalEl}
          </div>
      );
  }

  if (gameState.player.isDead) {
      return <GameOverScreen 
          onRestart={() => {
              setIsStarted(false);
              setIsMuted(true);
          }} 
          onLoad={handleLoadGame}
          saveExists={saveFileExists}
      />;
  }

  const actionsDisabled = isLoading || isLevelUpOpen;

  // derive latest narrative text for narrator
  const latestNarrativeText = (() => {
    for (let i = storyHistory.length - 1; i >= 0; i--) {
      const e = storyHistory[i];
      if (e.type === 'narrative' && e.text && e.text.trim()) return e.text;
    }
    return '';
  })();

  return (
    <div className="w-full min-h-screen bg-black text-[#15ff00] p-2 sm:p-4 flex flex-col">
       {isLevelUpOpen && (
          <LevelUpModal 
              player={gameState.player}
              onConfirm={handleLevelUpConfirm}
          />
       )}
       {inventoryModal.open && (
          <InventoryModal
              inventory={gameState.player.inventory}
              onClose={() => setInventoryModal({ open: false })}
              onAction={handlePlayerAction}
              actionsDisabled={actionsDisabled}
              initialItemName={inventoryModal.itemName}
          />
       )}
       {isQuestLogOpen && (
          <QuestLogModal
              quests={gameState.quests} 
              onClose={() => setIsQuestLogOpen(false)} 
          />
      )}
      {apiKeysModalEl}
      {isMapOpen && (
          <MapModal
              playerLocation={gameState.location}
              discoveredLocations={gameState.discoveredLocations}
              onClose={() => setIsMapOpen(false)}
          />
      )}
      {/* ambience handled by howler.js */}
      <div className="container mx-auto max-w-7xl border-2 border-[#15ff00]/50 p-2 sm:p-4 bg-black/80 flex flex-col flex-grow">
        <GameHeader 
            title={GAME_TITLE} 
            location={gameState.location.name}
            isMuted={isMuted}
            onToggleMute={toggleMute}
            onSaveGame={handleSaveGame}
            saveMessage={saveMessage}
            onOpenMap={() => setIsMapOpen(true)}
            onOpenApiKeys={() => openApiKeys()}
            isImageGenEnabled={isImageGenEnabled}
            onToggleImageGen={handleToggleImageGen}
            imageMode={imageMode}
            onToggleImageMode={handleToggleImageMode}
            narratorText={latestNarrativeText}
            narratorSequence={latestSequenceRef.current?.segments || []}
            narratorSequenceId={latestSequenceRef.current?.id}
            onRadioPlayingChange={setIsRadioPlaying}
        />

        <div className="flex flex-col md:flex-row flex-grow gap-4 min-h-0">
          {/* Left Panel */}
          <div className="flex flex-col md:w-1/3 lg:w-1/4 space-y-4">
            <StatusBar player={gameState.player} />
            <Inventory inventory={gameState.player.inventory} onOpenModal={(itemName) => setInventoryModal({ open: true, itemName })} />
            <QuestLog quests={gameState.quests} onOpenModal={() => setIsQuestLogOpen(true)} />
          </div>

          {/* Right Panel */}
          <div className="flex flex-col md:w-2/3 lg:w-3/4 flex-grow min-h-0">
            <ImageViewer 
                imageUrl={currentImageUrl}
                isLoading={isGeneratingImage}
                isEnabled={isImageGenEnabled}
                error={imageGenError}
            />
            <StoryDisplay storyHistory={storyHistory} />
            <ActionButtons 
                actions={gameState.suggestedActions || []} 
                onAction={handlePlayerAction}
                disabled={actionsDisabled}
            />
            <div className="mt-4 relative">
                {byokWarning && (
                  <div className="mb-2 flex flex-wrap items-center justify-center gap-2 text-yellow-300 text-base" role="status">
                    <span>{byokWarning.text}</span>
                    <button
                      onClick={() => openApiKeys(byokWarning.provider, byokWarning.text)}
                      className="px-2 py-0.5 border border-yellow-400/60 hover:bg-yellow-500/10 text-sm"
                    >
                      API KEYS
                    </button>
                    <button onClick={() => setByokWarning(null)} className="px-2 text-lg" aria-label="Dismiss warning">&times;</button>
                  </div>
                )}
                {isLoading && <LoadingScreen />}
                <PlayerInput onAction={handlePlayerAction} disabled={actionsDisabled} mentionOptions={mentionOptions} />
                 {error && (
                   <div className="text-center mt-2">
                     <p className="text-red-500 animate-pulse">{error}</p>
                     {lastTriedAction && (
                       <button
                         onClick={() => handlePlayerAction(lastTriedAction)}
                         disabled={isLoading}
                         className="mt-2 px-4 py-1 bg-black/50 border border-[#15ff00] text-[#15ff00] hover:bg-green-900/40 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                       >
                         RETRY LAST COMMAND
                       </button>
                     )}
                   </div>
                 )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;

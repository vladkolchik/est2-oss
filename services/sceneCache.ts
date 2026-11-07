// Persistent cache of scene descriptors keyed by location name.
// Rendering from a cached descriptor is instant, so re-entering a known
// location shows a frame immediately while a fresh descriptor loads behind it.

import type { SceneDescriptor } from './sceneRenderer';

const STORAGE_KEY = 'scene-descriptor-cache-v1';
const MAX_ENTRIES = 80;

interface CacheEntry {
    d: SceneDescriptor;
    t: number; // last-used timestamp for LRU trimming
}

function load(): Record<string, CacheEntry> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function save(cache: Record<string, CacheEntry>) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); } catch { /* storage full/unavailable */ }
}

function normalizeKey(locationName: string): string {
    return locationName.trim().toLowerCase();
}

export function getCachedDescriptor(locationName: string): SceneDescriptor | null {
    if (!locationName || !locationName.trim()) return null;
    const cache = load();
    const entry = cache[normalizeKey(locationName)];
    if (!entry || !entry.d) return null;
    entry.t = Date.now();
    save(cache);
    return entry.d;
}

export function cacheDescriptor(locationName: string, descriptor: SceneDescriptor) {
    if (!locationName || !locationName.trim()) return;
    const cache = load();
    cache[normalizeKey(locationName)] = { d: descriptor, t: Date.now() };
    // LRU trim
    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => (cache[a].t || 0) - (cache[b].t || 0))
            .slice(0, keys.length - MAX_ENTRIES)
            .forEach(k => delete cache[k]);
    }
    save(cache);
}

export function clearSceneCache() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// Parametric scene renderer: turns a compact SceneDescriptor (produced by the
// backend "artist" agent) into a layered silhouette painting on a canvas.
// Deterministic: the same descriptor always renders the same image.

import vocabulary from '../shared/sceneVocabulary.json';

export interface SceneLandmark {
    type: string;
    position: number; // 0..1 horizontal
    scale: number;    // 0..1 relative size
}

export interface SceneDescriptor {
    environment: 'desert' | 'town' | 'interior' | 'ruins' | 'cave' | 'road' | 'industrial' | 'water';
    timeOfDay: 'dawn' | 'day' | 'dusk' | 'night';
    weather: 'clear' | 'dusty' | 'fog' | 'storm' | 'rad_storm';
    mood: 'calm' | 'tense' | 'hostile' | 'mysterious' | 'hopeful';
    landmarks: SceneLandmark[];
    figures: number;
}

const WIDTH = 1024;
const HEIGHT = 576;

// Deterministic PRNG (mulberry32) seeded from the descriptor
function makeRng(seedText: string): () => number {
    let h = 1779033703 ^ seedText.length;
    for (let i = 0; i < seedText.length; i++) {
        h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface SkyPalette { top: string; bottom: string; sun: string | null; ground: string; far: string; near: string; }

function palette(d: SceneDescriptor): SkyPalette {
    const byTime: Record<SceneDescriptor['timeOfDay'], SkyPalette> = {
        dawn:  { top: '#2b2036', bottom: '#c96f4a', sun: '#ffd9a0', ground: '#241d18', far: '#4a3a42', near: '#33272b' },
        day:   { top: '#7a8f96', bottom: '#c2b280', sun: '#fff2c8', ground: '#3d3627', far: '#6b6353', near: '#4a4436' },
        dusk:  { top: '#1d1b30', bottom: '#b3502e', sun: '#ff9e5e', ground: '#1d1712', far: '#3d2c33', near: '#291e22' },
        night: { top: '#05070f', bottom: '#12203a', sun: '#dfe8ff', ground: '#080a10', far: '#141c2c', near: '#0c111d' },
    };
    const p = { ...byTime[d.timeOfDay] };
    // Weather / mood tinting
    if (d.weather === 'rad_storm') { p.top = '#0d2214'; p.bottom = '#3f6d2a'; p.sun = null; }
    if (d.weather === 'storm') { p.top = '#181c22'; p.bottom = '#3a4149'; p.sun = null; }
    if (d.weather === 'fog') { p.bottom = mix(p.bottom, '#9aa39c', 0.45); p.top = mix(p.top, '#7c837d', 0.3); }
    if (d.mood === 'hostile') { p.bottom = mix(p.bottom, '#8a2f1d', 0.3); }
    if (d.mood === 'mysterious') { p.top = mix(p.top, '#3a2a55', 0.4); }
    if (d.mood === 'hopeful') { p.bottom = mix(p.bottom, '#e8c87a', 0.25); }
    return p;
}

function mix(hexA: string, hexB: string, t: number): string {
    const a = parseInt(hexA.slice(1), 16), b = parseInt(hexB.slice(1), 16);
    const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
    const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
    const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
    return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

// --- Landmark silhouettes (drawn around x, standing on ground line y, height h) ---

type LandmarkPainter = (ctx: CanvasRenderingContext2D, x: number, y: number, h: number, rng: () => number) => void;

const painters: Record<string, LandmarkPainter> = {
    ruined_building: (ctx, x, y, h, rng) => {
        const w = h * (0.5 + rng() * 0.4);
        ctx.beginPath();
        ctx.moveTo(x - w / 2, y);
        ctx.lineTo(x - w / 2, y - h * (0.55 + rng() * 0.35));
        // Jagged broken top
        let cx = x - w / 2;
        while (cx < x + w / 2) {
            const step = w * (0.12 + rng() * 0.2);
            ctx.lineTo(Math.min(cx + step, x + w / 2), y - h * (0.35 + rng() * 0.6));
            cx += step;
        }
        ctx.lineTo(x + w / 2, y);
        ctx.closePath();
        ctx.fill();
        // Window holes
        punchWindows(ctx, x - w / 2, y, w, h * 0.6, rng, 0.55);
    },
    intact_building: (ctx, x, y, h, rng) => {
        const w = h * (0.55 + rng() * 0.3);
        ctx.fillRect(x - w / 2, y - h, w, h);
        ctx.fillRect(x - w * 0.18, y - h - h * 0.12, w * 0.36, h * 0.12); // roof cap
        punchWindows(ctx, x - w / 2, y, w, h, rng, 0.8);
    },
    mountain: (ctx, x, y, h, rng) => {
        const w = h * (2.2 + rng());
        ctx.beginPath();
        ctx.moveTo(x - w / 2, y);
        ctx.lineTo(x - w * 0.1 + rng() * w * 0.2, y - h);
        ctx.lineTo(x + w / 2, y);
        ctx.closePath();
        ctx.fill();
    },
    rock: (ctx, x, y, h, rng) => {
        ctx.beginPath();
        ctx.moveTo(x - h * 0.7, y);
        ctx.quadraticCurveTo(x - h * 0.4, y - h * (0.7 + rng() * 0.3), x + rng() * h * 0.3, y - h * 0.8);
        ctx.quadraticCurveTo(x + h * 0.6, y - h * 0.4, x + h * 0.7, y);
        ctx.closePath();
        ctx.fill();
    },
    cactus: (ctx, x, y, h) => {
        const w = h * 0.14;
        ctx.fillRect(x - w / 2, y - h, w, h);
        ctx.fillRect(x - h * 0.32, y - h * 0.72, h * 0.32, w);
        ctx.fillRect(x - h * 0.32, y - h * 0.95, w, h * 0.28);
        ctx.fillRect(x + w / 2, y - h * 0.55, h * 0.26, w);
        ctx.fillRect(x + w / 2 + h * 0.26 - w, y - h * 0.8, w, h * 0.3);
    },
    dead_tree: (ctx, x, y, h, rng) => {
        ctx.lineWidth = Math.max(2, h * 0.05);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - h * 0.55);
        ctx.stroke();
        drawBranch(ctx, x, y - h * 0.55, h * 0.45, -Math.PI / 2, 3, rng);
    },
    power_line: (ctx, x, y, h) => {
        ctx.lineWidth = Math.max(2, h * 0.03);
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x, y - h);
        ctx.moveTo(x - h * 0.3, y - h * 0.85); ctx.lineTo(x + h * 0.3, y - h * 0.85);
        ctx.moveTo(x - h * 0.22, y - h * 0.7); ctx.lineTo(x + h * 0.22, y - h * 0.7);
        ctx.stroke();
        // Sagging wires
        ctx.beginPath();
        ctx.moveTo(x - h * 0.3, y - h * 0.85);
        ctx.quadraticCurveTo(x - h * 1.2, y - h * 0.6, x - h * 2, y - h * 0.82);
        ctx.moveTo(x + h * 0.3, y - h * 0.85);
        ctx.quadraticCurveTo(x + h * 1.2, y - h * 0.6, x + h * 2, y - h * 0.82);
        ctx.stroke();
    },
    water_tower: (ctx, x, y, h) => {
        const w = h * 0.5;
        ctx.lineWidth = Math.max(2, h * 0.04);
        ctx.beginPath();
        ctx.moveTo(x - w * 0.4, y); ctx.lineTo(x - w * 0.25, y - h * 0.55);
        ctx.moveTo(x + w * 0.4, y); ctx.lineTo(x + w * 0.25, y - h * 0.55);
        ctx.moveTo(x - w * 0.33, y - h * 0.25); ctx.lineTo(x + w * 0.33, y - h * 0.25);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(x, y - h * 0.72, w * 0.5, h * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x - w * 0.5, y - h * 0.78); ctx.lineTo(x, y - h); ctx.lineTo(x + w * 0.5, y - h * 0.78);
        ctx.closePath();
        ctx.fill();
    },
    car_wreck: (ctx, x, y, h) => {
        const w = h * 2;
        ctx.beginPath();
        ctx.moveTo(x - w / 2, y);
        ctx.lineTo(x - w / 2 + w * 0.08, y - h * 0.45);
        ctx.lineTo(x - w * 0.18, y - h * 0.5);
        ctx.lineTo(x - w * 0.08, y - h * 0.85);
        ctx.lineTo(x + w * 0.22, y - h * 0.85);
        ctx.lineTo(x + w * 0.34, y - h * 0.5);
        ctx.lineTo(x + w / 2, y - h * 0.42);
        ctx.lineTo(x + w / 2, y);
        ctx.closePath();
        ctx.fill();
    },
    campfire: (ctx, x, y, h) => {
        ctx.save();
        // Logs
        ctx.lineWidth = Math.max(2, h * 0.08);
        ctx.beginPath();
        ctx.moveTo(x - h * 0.4, y); ctx.lineTo(x + h * 0.4, y - h * 0.1);
        ctx.moveTo(x + h * 0.4, y); ctx.lineTo(x - h * 0.4, y - h * 0.1);
        ctx.stroke();
        // Glow + flame
        const glow = ctx.createRadialGradient(x, y - h * 0.3, 2, x, y - h * 0.3, h * 1.6);
        glow.addColorStop(0, 'rgba(255,170,60,0.7)');
        glow.addColorStop(1, 'rgba(255,120,30,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - h * 1.6, y - h * 2, h * 3.2, h * 2.2);
        ctx.fillStyle = '#ffb054';
        ctx.beginPath();
        ctx.moveTo(x - h * 0.18, y - h * 0.08);
        ctx.quadraticCurveTo(x - h * 0.05, y - h * 0.6, x, y - h * 0.75);
        ctx.quadraticCurveTo(x + h * 0.08, y - h * 0.5, x + h * 0.18, y - h * 0.08);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    },
    tent: (ctx, x, y, h) => {
        const w = h * 1.4;
        ctx.beginPath();
        ctx.moveTo(x - w / 2, y); ctx.lineTo(x, y - h); ctx.lineTo(x + w / 2, y);
        ctx.closePath();
        ctx.fill();
    },
    antenna: (ctx, x, y, h) => {
        ctx.lineWidth = Math.max(2, h * 0.025);
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x, y - h);
        ctx.moveTo(x - h * 0.2, y); ctx.lineTo(x, y - h * 0.5);
        ctx.moveTo(x + h * 0.2, y); ctx.lineTo(x, y - h * 0.5);
        ctx.moveTo(x - h * 0.12, y - h * 0.75); ctx.lineTo(x + h * 0.12, y - h * 0.75);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y - h, h * 0.035, 0, Math.PI * 2);
        ctx.fill();
    },
    bridge: (ctx, x, y, h) => {
        const w = h * 3;
        ctx.fillRect(x - w / 2, y - h * 0.55, w, h * 0.12);
        ctx.lineWidth = Math.max(2, h * 0.05);
        ctx.beginPath();
        for (let i = -2; i <= 2; i++) {
            ctx.moveTo(x + i * w * 0.2, y - h * 0.45);
            ctx.lineTo(x + i * w * 0.2, y);
        }
        ctx.moveTo(x - w / 2, y - h * 0.55);
        ctx.quadraticCurveTo(x, y - h * 1.15, x + w / 2, y - h * 0.55);
        ctx.stroke();
    },
    crater: (ctx, x, y, h) => {
        ctx.beginPath();
        ctx.ellipse(x, y, h * 1.2, h * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.ellipse(x, y + h * 0.05, h * 0.9, h * 0.18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    },
    sign: (ctx, x, y, h) => {
        ctx.lineWidth = Math.max(2, h * 0.06);
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x, y - h * 0.85);
        ctx.stroke();
        ctx.fillRect(x - h * 0.45, y - h, h * 0.9, h * 0.32);
    },
    vault_door: (ctx, x, y, h) => {
        const r = h * 0.5;
        const cy = y - r;
        // Gear teeth
        for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            ctx.save();
            ctx.translate(x + Math.cos(a) * r, cy + Math.sin(a) * r);
            ctx.rotate(a);
            ctx.fillRect(-r * 0.06, -r * 0.1, r * 0.16, r * 0.2);
            ctx.restore();
        }
        ctx.beginPath();
        ctx.arc(x, cy, r, 0, Math.PI * 2);
        ctx.fill();
        // Hub and spokes carved out
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = Math.max(2, r * 0.08);
        for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, cy);
            ctx.lineTo(x + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(x, cy, r * 0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    },
    billboard: (ctx, x, y, h, rng) => {
        const w = h * 1.6;
        ctx.lineWidth = Math.max(2, h * 0.05);
        ctx.beginPath();
        ctx.moveTo(x - w * 0.25, y); ctx.lineTo(x - w * 0.25, y - h * 0.55);
        ctx.moveTo(x + w * 0.25, y); ctx.lineTo(x + w * 0.25, y - h * 0.55);
        ctx.stroke();
        // Panel with a torn corner
        ctx.beginPath();
        ctx.moveTo(x - w / 2, y - h);
        ctx.lineTo(x + w * (0.28 + rng() * 0.15), y - h);
        ctx.lineTo(x + w * 0.42, y - h * 0.85);
        ctx.lineTo(x + w / 2, y - h * 0.82);
        ctx.lineTo(x + w / 2, y - h * 0.5);
        ctx.lineTo(x - w / 2, y - h * 0.5);
        ctx.closePath();
        ctx.fill();
    },
    windmill: (ctx, x, y, h, rng) => {
        ctx.lineWidth = Math.max(2, h * 0.035);
        ctx.beginPath();
        ctx.moveTo(x - h * 0.14, y); ctx.lineTo(x, y - h);
        ctx.moveTo(x + h * 0.14, y); ctx.lineTo(x, y - h);
        ctx.moveTo(x - h * 0.1, y - h * 0.4); ctx.lineTo(x + h * 0.1, y - h * 0.4);
        ctx.stroke();
        const spin = rng() * Math.PI;
        for (let i = 0; i < 4; i++) {
            const a = spin + (i / 4) * Math.PI * 2;
            ctx.save();
            ctx.translate(x, y - h);
            ctx.rotate(a);
            ctx.fillRect(0, -h * 0.035, h * 0.42, h * 0.07);
            ctx.restore();
        }
    },
    gas_pump: (ctx, x, y, h) => {
        const w = h * 0.45;
        ctx.fillRect(x - w / 2, y - h, w, h);
        ctx.fillRect(x - w * 0.3, y - h - h * 0.08, w * 0.6, h * 0.08);
        ctx.lineWidth = Math.max(2, h * 0.06);
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y - h * 0.7);
        ctx.quadraticCurveTo(x + w * 1.3, y - h * 0.55, x + w * 1.1, y - h * 0.15);
        ctx.stroke();
        ctx.save(); // window slot
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x - w * 0.3, y - h * 0.85, w * 0.6, h * 0.22);
        ctx.restore();
    },
    barrel: (ctx, x, y, h) => {
        const w = h * 0.7;
        ctx.fillRect(x - w / 2, y - h, w, h);
        ctx.beginPath();
        ctx.ellipse(x, y - h, w / 2, h * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = Math.max(1.5, h * 0.05);
        ctx.beginPath();
        ctx.moveTo(x - w / 2, y - h * 0.35); ctx.lineTo(x + w / 2, y - h * 0.35);
        ctx.moveTo(x - w / 2, y - h * 0.7); ctx.lineTo(x + w / 2, y - h * 0.7);
        ctx.stroke();
        ctx.restore();
    },
    fence: (ctx, x, y, h) => {
        const span = h * 2.4;
        ctx.lineWidth = Math.max(2, h * 0.06);
        const posts = 6;
        for (let i = 0; i < posts; i++) {
            const px = x - span / 2 + (i * span) / (posts - 1);
            ctx.beginPath();
            ctx.moveTo(px, y); ctx.lineTo(px, y - h * 0.6);
            ctx.stroke();
        }
        ctx.lineWidth = Math.max(1.5, h * 0.03);
        ctx.beginPath();
        ctx.moveTo(x - span / 2, y - h * 0.5); ctx.lineTo(x + span / 2, y - h * 0.45);
        ctx.moveTo(x - span / 2, y - h * 0.28); ctx.lineTo(x + span / 2, y - h * 0.24);
        ctx.stroke();
    },
    shack: (ctx, x, y, h) => {
        const w = h * 1.2;
        ctx.fillRect(x - w / 2, y - h * 0.7, w, h * 0.7);
        ctx.beginPath(); // slanted roof
        ctx.moveTo(x - w / 2 - w * 0.08, y - h * 0.7);
        ctx.lineTo(x - w / 2, y - h);
        ctx.lineTo(x + w / 2 + w * 0.08, y - h * 0.82);
        ctx.lineTo(x + w / 2 + w * 0.08, y - h * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(x - w * 0.12, y - h * 0.5, w * 0.24, h * 0.5); // doorway
        ctx.restore();
    },
    watch_tower: (ctx, x, y, h) => {
        const w = h * 0.55;
        ctx.lineWidth = Math.max(2, h * 0.04);
        ctx.beginPath();
        ctx.moveTo(x - w / 2, y); ctx.lineTo(x - w * 0.3, y - h * 0.6);
        ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w * 0.3, y - h * 0.6);
        ctx.moveTo(x - w * 0.4, y - h * 0.3); ctx.lineTo(x + w * 0.4, y - h * 0.3);
        // Ladder
        ctx.moveTo(x, y); ctx.lineTo(x, y - h * 0.6);
        ctx.stroke();
        // Cabin + roof
        ctx.fillRect(x - w * 0.45, y - h * 0.88, w * 0.9, h * 0.28);
        ctx.beginPath();
        ctx.moveTo(x - w * 0.55, y - h * 0.88);
        ctx.lineTo(x, y - h);
        ctx.lineTo(x + w * 0.55, y - h * 0.88);
        ctx.closePath();
        ctx.fill();
    },
    train_car: (ctx, x, y, h, rng) => {
        const w = h * 1.9;
        ctx.fillRect(x - w / 2, y - h * 0.75, w, h * 0.55);
        // Wheels
        for (let i = 0; i < 3; i++) {
            const wx = x - w * 0.32 + i * w * 0.32;
            ctx.beginPath();
            ctx.arc(wx, y - h * 0.1, h * 0.12, 0, Math.PI * 2);
            ctx.fill();
        }
        // Window strip
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        for (let i = 0; i < 4; i++) {
            if (rng() < 0.75) ctx.fillRect(x - w * 0.38 + i * w * 0.22, y - h * 0.62, w * 0.13, h * 0.16);
        }
        ctx.restore();
    },
    smokestack: (ctx, x, y, h, rng) => {
        ctx.beginPath();
        ctx.moveTo(x - h * 0.16, y);
        ctx.lineTo(x - h * 0.09, y - h);
        ctx.lineTo(x + h * 0.09, y - h);
        ctx.lineTo(x + h * 0.16, y);
        ctx.closePath();
        ctx.fill();
        // Smoke puffs
        ctx.save();
        ctx.fillStyle = 'rgba(80,80,80,0.35)';
        let px = x, py = y - h, r = h * 0.1;
        for (let i = 0; i < 4; i++) {
            px += (rng() - 0.3) * h * 0.25;
            py -= r * 1.4;
            r *= 1.35;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    },
    radar_dish: (ctx, x, y, h) => {
        ctx.fillRect(x - h * 0.12, y - h * 0.45, h * 0.24, h * 0.45);
        ctx.save();
        ctx.translate(x, y - h * 0.55);
        ctx.rotate(-0.5);
        ctx.beginPath();
        ctx.ellipse(0, 0, h * 0.45, h * 0.16, 0, 0, Math.PI);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = Math.max(2, h * 0.04);
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(0, -h * 0.3);
        ctx.stroke();
        ctx.restore();
    },
    barricade: (ctx, x, y, h, rng) => {
        // Sandbag mound
        ctx.beginPath();
        ctx.moveTo(x - h * 1.1, y);
        ctx.quadraticCurveTo(x, y - h * 0.75, x + h * 1.1, y);
        ctx.closePath();
        ctx.fill();
        // Crossed planks
        ctx.lineWidth = Math.max(2, h * 0.08);
        ctx.beginPath();
        ctx.moveTo(x - h * 0.5, y); ctx.lineTo(x + h * (0.2 + rng() * 0.2), y - h * 0.9);
        ctx.moveTo(x + h * 0.5, y); ctx.lineTo(x - h * (0.2 + rng() * 0.2), y - h * 0.9);
        ctx.stroke();
    },
};

// The artist's vocabulary lives in shared/sceneVocabulary.json — every type it
// can emit must have a painter here, otherwise it silently degrades to a rock.
for (const type of vocabulary.landmarkTypes) {
    if (!painters[type]) {
        console.warn(`sceneRenderer: no painter for landmark type "${type}" from shared/sceneVocabulary.json — it will render as a rock`);
    }
}

function punchWindows(ctx: CanvasRenderingContext2D, left: number, groundY: number, w: number, h: number, rng: () => number, litChance: number) {
    ctx.save();
    const cols = Math.max(2, Math.floor(w / 26));
    const rows = Math.max(2, Math.floor(h / 34));
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (rng() > 0.45) continue;
            const wx = left + w * 0.12 + (c * w * 0.76) / cols;
            const wy = groundY - h * 0.12 - (r * h * 0.78) / rows;
            if (rng() < litChance * 0.25) {
                ctx.fillStyle = 'rgba(255,200,110,0.65)'; // dim lit window
            } else {
                ctx.fillStyle = 'rgba(0,0,0,0.5)';
            }
            ctx.fillRect(wx, wy - 9, 7, 9);
        }
    }
    ctx.restore();
}

function drawBranch(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, angle: number, depth: number, rng: () => number) {
    if (depth <= 0 || len < 4) return;
    const ex = x + Math.cos(angle) * len;
    const ey = y + Math.sin(angle) * len;
    ctx.lineWidth = Math.max(1, depth * 1.5);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    drawBranch(ctx, ex, ey, len * (0.55 + rng() * 0.2), angle - (0.3 + rng() * 0.5), depth - 1, rng);
    drawBranch(ctx, ex, ey, len * (0.55 + rng() * 0.2), angle + (0.3 + rng() * 0.5), depth - 1, rng);
}

function drawFigure(ctx: CanvasRenderingContext2D, x: number, y: number, h: number) {
    const headR = h * 0.14;
    ctx.beginPath();
    ctx.arc(x, y - h + headR, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath(); // torso + legs as a tapered shape
    ctx.moveTo(x - h * 0.16, y - h + headR * 2.4);
    ctx.lineTo(x + h * 0.16, y - h + headR * 2.4);
    ctx.lineTo(x + h * 0.1, y - h * 0.45);
    ctx.lineTo(x + h * 0.14, y);
    ctx.lineTo(x + h * 0.04, y);
    ctx.lineTo(x, y - h * 0.4);
    ctx.lineTo(x - h * 0.04, y);
    ctx.lineTo(x - h * 0.14, y);
    ctx.lineTo(x - h * 0.1, y - h * 0.45);
    ctx.closePath();
    ctx.fill();
}

// --- Scene templates ---

function drawOutdoor(ctx: CanvasRenderingContext2D, d: SceneDescriptor, p: SkyPalette, rng: () => number) {
    const horizon = HEIGHT * 0.62;

    // Sky
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, p.top);
    sky.addColorStop(1, p.bottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WIDTH, horizon);

    // Stars at night
    if (d.timeOfDay === 'night' && d.weather !== 'storm' && d.weather !== 'rad_storm') {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        for (let i = 0; i < 90; i++) {
            const sx = rng() * WIDTH, sy = rng() * horizon * 0.85;
            ctx.globalAlpha = 0.2 + rng() * 0.7;
            ctx.fillRect(sx, sy, rng() < 0.15 ? 2 : 1, 1);
        }
        ctx.globalAlpha = 1;
    }

    // Sun / moon
    if (p.sun) {
        const sunX = WIDTH * (0.25 + rng() * 0.5);
        const sunY = d.timeOfDay === 'day' ? horizon * 0.3 : horizon * (0.62 + rng() * 0.2);
        const r = d.timeOfDay === 'night' ? 26 : 42;
        const glow = ctx.createRadialGradient(sunX, sunY, r * 0.4, sunX, sunY, r * 3.2);
        glow.addColorStop(0, p.sun + 'cc');
        glow.addColorStop(1, p.sun + '00');
        ctx.fillStyle = glow;
        ctx.fillRect(sunX - r * 3.2, sunY - r * 3.2, r * 6.4, r * 6.4);
        ctx.fillStyle = p.sun;
        ctx.beginPath();
        ctx.arc(sunX, sunY, r, 0, Math.PI * 2);
        ctx.fill();
        if (d.timeOfDay === 'night') { // subtle craters
            ctx.fillStyle = 'rgba(0,0,0,0.15)';
            ctx.beginPath();
            ctx.arc(sunX - r * 0.3, sunY - r * 0.2, r * 0.25, 0, Math.PI * 2);
            ctx.arc(sunX + r * 0.25, sunY + r * 0.3, r * 0.18, 0, Math.PI * 2);
            ctx.arc(sunX + r * 0.35, sunY - r * 0.35, r * 0.12, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Distant mountain layer
    ctx.fillStyle = p.far;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    let mx = 0;
    while (mx < WIDTH) {
        const peakW = 120 + rng() * 260;
        ctx.lineTo(mx + peakW / 2, horizon - 30 - rng() * 90);
        mx += peakW;
        ctx.lineTo(Math.min(mx, WIDTH), horizon);
    }
    ctx.closePath();
    ctx.fill();

    // Ground
    const ground = ctx.createLinearGradient(0, horizon, 0, HEIGHT);
    ground.addColorStop(0, mix(p.ground, p.bottom, 0.25));
    ground.addColorStop(1, p.ground);
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizon, WIDTH, HEIGHT - horizon);

    // Road for road/town scenes
    if (d.environment === 'road' || d.environment === 'town') {
        ctx.fillStyle = mix(p.ground, '#000000', 0.35);
        ctx.beginPath();
        ctx.moveTo(WIDTH * 0.44, horizon);
        ctx.lineTo(WIDTH * 0.56, horizon);
        ctx.lineTo(WIDTH * 0.85, HEIGHT);
        ctx.lineTo(WIDTH * 0.15, HEIGHT);
        ctx.closePath();
        ctx.fill();
        // Dashed centerline
        ctx.strokeStyle = 'rgba(220,210,160,0.4)';
        ctx.lineWidth = 4;
        ctx.setLineDash([18, 26]);
        ctx.beginPath();
        ctx.moveTo(WIDTH * 0.5, horizon);
        ctx.lineTo(WIDTH * 0.5, HEIGHT);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Water strip
    if (d.environment === 'water') {
        const waterTop = horizon + (HEIGHT - horizon) * 0.25;
        ctx.fillStyle = mix(p.top, '#1d3a4a', 0.5);
        ctx.fillRect(0, waterTop, WIDTH, HEIGHT - waterTop);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 14; i++) {
            const wy = waterTop + rng() * (HEIGHT - waterTop);
            const wx = rng() * WIDTH;
            ctx.beginPath();
            ctx.moveTo(wx, wy);
            ctx.lineTo(wx + 30 + rng() * 80, wy);
            ctx.stroke();
        }
    }

    return horizon;
}

function drawIndoor(ctx: CanvasRenderingContext2D, d: SceneDescriptor, p: SkyPalette, rng: () => number) {
    const isCave = d.environment === 'cave';
    const wall = isCave ? '#17130f' : '#1a1c1a';
    const floorY = HEIGHT * 0.7;

    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Floor
    const floor = ctx.createLinearGradient(0, floorY, 0, HEIGHT);
    floor.addColorStop(0, mix(wall, '#3a352c', 0.5));
    floor.addColorStop(1, mix(wall, '#000000', 0.3));
    ctx.fillStyle = floor;
    ctx.fillRect(0, floorY, WIDTH, HEIGHT - floorY);

    // Light source: doorway / cave mouth with ambient glow
    const doorX = WIDTH * (0.3 + rng() * 0.4);
    const doorW = WIDTH * 0.12;
    const doorH = HEIGHT * 0.42;
    const lightColor = d.weather === 'rad_storm' ? '#7ddc6a' : (d.timeOfDay === 'night' ? '#9db8e8' : '#ffd9a0');
    const glow = ctx.createRadialGradient(doorX, floorY - doorH / 2, 10, doorX, floorY - doorH / 2, WIDTH * 0.5);
    glow.addColorStop(0, lightColor + '55');
    glow.addColorStop(1, lightColor + '00');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.fillStyle = lightColor;
    if (isCave) {
        ctx.beginPath();
        ctx.moveTo(doorX - doorW, floorY);
        ctx.quadraticCurveTo(doorX - doorW * 0.6, floorY - doorH * 1.2, doorX, floorY - doorH);
        ctx.quadraticCurveTo(doorX + doorW * 0.7, floorY - doorH * 0.9, doorX + doorW, floorY);
        ctx.closePath();
        ctx.fill();
    } else {
        ctx.fillRect(doorX - doorW / 2, floorY - doorH, doorW, doorH);
        ctx.fillStyle = wall;
        ctx.fillRect(doorX - doorW / 2 + doorW * 0.46, floorY - doorH, doorW * 0.08, doorH); // door frame split
    }

    // Perspective lines (ceiling/floor) for built interiors
    if (!isCave) {
        ctx.strokeStyle = 'rgba(120,255,120,0.06)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 7; i++) {
            ctx.beginPath();
            ctx.moveTo(0, floorY + (i * (HEIGHT - floorY)) / 7);
            ctx.lineTo(WIDTH, floorY + (i * (HEIGHT - floorY)) / 8);
            ctx.stroke();
        }
    } else {
        // Stalactites
        ctx.fillStyle = mix(wall, '#000000', 0.4);
        for (let i = 0; i < 12; i++) {
            const sx = rng() * WIDTH;
            const sh = 20 + rng() * 70;
            ctx.beginPath();
            ctx.moveTo(sx - 14, 0);
            ctx.lineTo(sx, sh);
            ctx.lineTo(sx + 14, 0);
            ctx.closePath();
            ctx.fill();
        }
    }

    return floorY;
}

function drawWeather(ctx: CanvasRenderingContext2D, d: SceneDescriptor, rng: () => number) {
    if (d.weather === 'dusty') {
        ctx.fillStyle = 'rgba(194,164,110,0.14)';
        ctx.fillRect(0, HEIGHT * 0.45, WIDTH, HEIGHT * 0.55);
        ctx.fillStyle = 'rgba(220,190,130,0.5)';
        for (let i = 0; i < 120; i++) {
            ctx.globalAlpha = 0.1 + rng() * 0.4;
            ctx.fillRect(rng() * WIDTH, HEIGHT * 0.3 + rng() * HEIGHT * 0.7, 1 + rng() * 2, 1);
        }
        ctx.globalAlpha = 1;
    }
    if (d.weather === 'fog') {
        for (let i = 0; i < 4; i++) {
            const fy = HEIGHT * (0.35 + i * 0.15);
            const band = ctx.createLinearGradient(0, fy - 40, 0, fy + 40);
            band.addColorStop(0, 'rgba(200,205,198,0)');
            band.addColorStop(0.5, `rgba(200,205,198,${0.10 + i * 0.05})`);
            band.addColorStop(1, 'rgba(200,205,198,0)');
            ctx.fillStyle = band;
            ctx.fillRect(0, fy - 40, WIDTH, 80);
        }
    }
    if (d.weather === 'storm' || d.weather === 'rad_storm') {
        const isRad = d.weather === 'rad_storm';
        ctx.strokeStyle = isRad ? 'rgba(140,230,110,0.35)' : 'rgba(180,190,210,0.35)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 140; i++) {
            const rx = rng() * WIDTH, ry = rng() * HEIGHT;
            ctx.beginPath();
            ctx.moveTo(rx, ry);
            ctx.lineTo(rx - 6, ry + 16);
            ctx.stroke();
        }
        // Lightning bolt
        if (rng() < 0.8) {
            ctx.strokeStyle = isRad ? 'rgba(170,255,140,0.9)' : 'rgba(240,240,255,0.9)';
            ctx.lineWidth = 2.5;
            let lx = WIDTH * (0.15 + rng() * 0.7), ly = 0;
            ctx.beginPath();
            ctx.moveTo(lx, ly);
            while (ly < HEIGHT * 0.45) {
                lx += (rng() - 0.5) * 60;
                ly += 25 + rng() * 40;
                ctx.lineTo(lx, ly);
            }
            ctx.stroke();
        }
    }
}

function drawCrtOverlay(ctx: CanvasRenderingContext2D) {
    // Vignette
    const vig = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, HEIGHT * 0.45, WIDTH / 2, HEIGHT / 2, HEIGHT * 0.95);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    // Phosphor tint + scanlines to match the Pip-Boy UI
    ctx.fillStyle = 'rgba(21,255,0,0.03)';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    for (let y = 0; y < HEIGHT; y += 3) {
        ctx.fillRect(0, y, WIDTH, 1);
    }
}

export function renderScene(descriptor: SceneDescriptor): string {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    const rng = makeRng(JSON.stringify(descriptor));
    const p = palette(descriptor);

    const indoor = descriptor.environment === 'interior' || descriptor.environment === 'cave';
    const groundY = indoor ? drawIndoor(ctx, descriptor, p, rng) : drawOutdoor(ctx, descriptor, p, rng);

    // Landmarks: sorted by scale so bigger ones sit further back
    const sorted = [...(descriptor.landmarks || [])].sort((a, b) => b.scale - a.scale);
    sorted.forEach((landmark, i) => {
        const painter = painters[landmark.type] || painters.rock;
        const depth = i / Math.max(1, sorted.length - 1); // 0 = back, 1 = front
        const y = groundY + depth * (HEIGHT - groundY) * 0.55;
        const h = (indoor ? 90 : 130) * (0.35 + landmark.scale * 0.9) * (0.7 + depth * 0.5);
        const shade = mix(p.far, p.near, depth);
        ctx.fillStyle = shade;
        ctx.strokeStyle = shade;
        painter(ctx, landmark.position * WIDTH, y, h, rng);
    });

    // Figures in the foreground
    const figureCount = Math.min(5, Math.max(0, descriptor.figures || 0));
    ctx.fillStyle = mix(p.near, '#000000', 0.4);
    for (let i = 0; i < figureCount; i++) {
        const fx = WIDTH * (0.25 + rng() * 0.5);
        const fy = groundY + (HEIGHT - groundY) * (0.45 + rng() * 0.4);
        drawFigure(ctx, fx, fy, 60 + rng() * 30);
    }

    drawWeather(ctx, descriptor, rng);
    drawCrtOverlay(ctx);

    return canvas.toDataURL('image/png');
}

// Auto-provisions and supervises a local Silero TTS server (backend/silero/server.py).
//
// On first run this creates a Python venv under backend/.silero/venv, installs
// CPU-only torch (~1.5-2 GB on disk, one-time) and downloads the Silero model
// (~60-150 MB). Subsequent starts are fast. Controlled via env:
//   SILERO_AUTOSTART=true|false (default true; skipped when SILERO_TTS_URL is set externally)
//   SILERO_MODEL=v3_en | v4_ru | v3_de | v3_es | v3_fr (default v3_en)
//   SILERO_SPEAKER, SILERO_PORT (default 8010), SILERO_THREADS (default 4)

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SILERO_DIR = path.join(__dirname, '.silero');
const VENV_DIR = path.join(SILERO_DIR, 'venv');
const MODELS_DIR = path.join(SILERO_DIR, 'models');
const SERVER_SCRIPT = path.join(__dirname, 'silero', 'server.py');

const state = {
    phase: 'idle', // idle | installing | starting | ready | error | disabled
    detail: null,
    child: null,
    url: null,
};

function getStatus() {
    return { phase: state.phase, detail: state.detail, url: state.url };
}

function venvPython() {
    return process.platform === 'win32'
        ? path.join(VENV_DIR, 'Scripts', 'python.exe')
        : path.join(VENV_DIR, 'bin', 'python');
}

function findSystemPython() {
    const candidates = process.platform === 'win32'
        ? [['py', ['-3']], ['python', []], ['python3', []]]
        : [['python3', []], ['python', []]];
    for (const [cmd, extraArgs] of candidates) {
        try {
            const result = spawnSync(cmd, [...extraArgs, '--version'], { encoding: 'utf8', windowsHide: true });
            if (result.status === 0) return { cmd, extraArgs };
        } catch (_) { /* try next */ }
    }
    return null;
}

function runCommand(cmd, args, label) {
    return new Promise((resolve, reject) => {
        console.log(`[silero-manager] ${label}: ${cmd} ${args.join(' ')}`);
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stderrTail = '';
        child.stdout.on('data', (d) => {
            const line = String(d).trim();
            if (line) console.log(`[silero-manager] ${line.slice(0, 300)}`);
        });
        child.stderr.on('data', (d) => { stderrTail = (stderrTail + String(d)).slice(-2000); });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${label} failed (exit ${code}): ${stderrTail.slice(-500)}`));
        });
    });
}

async function ensureVenvWithTorch() {
    if (!fs.existsSync(venvPython())) {
        const python = findSystemPython();
        if (!python) {
            throw new Error('Python 3 not found on PATH. Install Python 3.9+ or set SILERO_TTS_URL to an external server.');
        }
        state.detail = 'creating venv';
        await runCommand(python.cmd, [...python.extraArgs, '-m', 'venv', VENV_DIR], 'create venv');
    }

    const check = spawnSync(venvPython(), ['-c', 'import torch, numpy'], { encoding: 'utf8', windowsHide: true });
    if (check.status !== 0) {
        state.detail = 'installing torch (one-time, ~1.5-2 GB — this can take several minutes)';
        console.log('[silero-manager] installing CPU torch into venv — one-time setup, please wait...');
        const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', 'torch', 'numpy'];
        // On Linux/macOS the default PyPI torch bundles CUDA; force the small CPU wheel.
        if (process.platform !== 'win32') {
            pipArgs.push('--index-url', 'https://download.pytorch.org/whl/cpu');
        }
        await runCommand(venvPython(), pipArgs, 'pip install torch');
    }
}

async function waitForHealth(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (state.child && state.child.exitCode !== null) {
            throw new Error(`Silero server exited early (code ${state.child.exitCode})`);
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (response.ok) return;
        } catch (_) { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Silero server did not become healthy in time.');
}

async function ensureStarted() {
    const autostart = String(process.env.SILERO_AUTOSTART ?? 'true').trim().toLowerCase() !== 'false';
    if (!autostart) {
        state.phase = 'disabled';
        state.detail = 'SILERO_AUTOSTART=false';
        return getStatus();
    }
    if (process.env.SILERO_TTS_URL) {
        state.phase = 'ready';
        state.url = process.env.SILERO_TTS_URL;
        state.detail = 'using externally configured SILERO_TTS_URL';
        return getStatus();
    }
    if (state.phase === 'ready' || state.phase === 'installing' || state.phase === 'starting') {
        return getStatus();
    }

    const port = Number(process.env.SILERO_PORT || 8010);
    const model = (process.env.SILERO_MODEL || 'v3_en').trim();
    const speaker = (process.env.SILERO_SPEAKER || 'en_0').trim();
    const threads = Number(process.env.SILERO_THREADS || 4);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        state.phase = 'installing';
        await ensureVenvWithTorch();

        state.phase = 'starting';
        state.detail = 'starting server (downloads the model on first run)';
        const child = spawn(venvPython(), [
            SERVER_SCRIPT,
            '--port', String(port),
            '--model', model,
            '--speaker', speaker,
            '--threads', String(threads),
            '--models-dir', MODELS_DIR,
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

        child.stdout.on('data', (d) => {
            const line = String(d).trim();
            if (line) console.log(`[silero] ${line.slice(0, 300)}`);
        });
        child.stderr.on('data', (d) => {
            const line = String(d).trim();
            if (line) console.warn(`[silero] ${line.slice(0, 300)}`);
        });
        child.on('exit', (code) => {
            if (state.phase === 'ready') {
                state.phase = 'error';
                state.detail = `Silero server exited unexpectedly (code ${code})`;
                console.warn(`[silero-manager] server exited with code ${code}`);
            }
            state.child = null;
        });
        state.child = child;

        // First run downloads the model — allow up to 10 minutes.
        await waitForHealth(`${baseUrl}/health`, 10 * 60 * 1000);

        process.env.SILERO_TTS_URL = `${baseUrl}/tts`;
        state.url = process.env.SILERO_TTS_URL;
        state.phase = 'ready';
        state.detail = `model=${model}, speaker=${speaker}`;
        console.log(`[silero-manager] Silero TTS ready at ${state.url}`);
    } catch (error) {
        state.phase = 'error';
        state.detail = error.message;
        console.warn(`[silero-manager] failed to start Silero: ${error.message}`);
        if (state.child) {
            try { state.child.kill(); } catch (_) {}
            state.child = null;
        }
    }
    return getStatus();
}

function shutdown() {
    if (state.child) {
        try { state.child.kill(); } catch (_) {}
        state.child = null;
    }
}

process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

module.exports = { ensureStarted, getStatus, shutdown };

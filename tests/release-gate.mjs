import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';

const ROOT_DIR = process.cwd();

function parseArgs(argv) {
  const out = {
    backendUrl: process.env.RELEASE_GATE_BACKEND_URL || null,
  };
  const passthrough = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--backend-url=')) {
      out.backendUrl = arg.split('=')[1];
      continue;
    }
    if (arg === '--backend-url' && argv[i + 1]) {
      out.backendUrl = argv[i + 1];
      i += 1;
      continue;
    }
    passthrough.push(arg);
  }

  return { ...out, passthrough };
}

function runNodeScript(scriptRelativePath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT_DIR, scriptRelativePath), ...args], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${scriptRelativePath} failed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`));
    });
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const common = [];
  if (args.backendUrl) {
    common.push('--backend-url', args.backendUrl);
  }
  common.push(...args.passthrough);

  await runNodeScript('tests/smoke-world-memory.mjs', common);
  await runNodeScript('tests/eval-memory-gate.mjs', common);
}

run().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});

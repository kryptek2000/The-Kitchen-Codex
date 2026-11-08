import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type VoiceModule = typeof import('../../server/voiceNative.js');

// The production bridge always resolves its worker from the installed
// application. Tests replace the child-process target at the spawn boundary;
// no production environment variable or runtime worker path is involved.
const voiceTestState = vi.hoisted(() => ({ workerPath: '' }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((command: any, args: any = [], options: any = undefined) => {
      const scriptPath = Array.isArray(args) ? args[0] : undefined;
      const installedWorker = path.resolve(process.cwd(), 'server', 'voice', 'voiceChild.cjs');
      if (command === process.execPath && scriptPath === installedWorker && voiceTestState.workerPath) {
        const redirected = actual.spawn(process.execPath, [voiceTestState.workerPath], options);
        return redirected;
      }
      return actual.spawn(command, args, options);
    }),
  };
});

const originalEnv = {
  TKC_NATIVE_VOICE_ENABLED: process.env.TKC_NATIVE_VOICE_ENABLED,
  TKC_KOKORO_MODULE: process.env.TKC_KOKORO_MODULE,
  TKC_VOICE_DIR: process.env.TKC_VOICE_DIR,
  TKC_VOICE_WORKER: process.env.TKC_VOICE_WORKER,
  TKC_VOICE_TEST_HARNESS: process.env.TKC_VOICE_TEST_HARNESS,
  TKC_VOICE_TEST_WORKER: process.env.TKC_VOICE_TEST_WORKER,
  TKC_VOICE_CACHE_DIR: process.env.TKC_VOICE_CACHE_DIR,
  TKC_VOICE_MODEL_SHA256: process.env.TKC_VOICE_MODEL_SHA256,
  TKC_VOICE_VOICE_SHA256: process.env.TKC_VOICE_VOICE_SHA256,
  TKC_VOICE_METADATA_HASHES: process.env.TKC_VOICE_METADATA_HASHES,
  TKC_VOICE_SYNTHESIS_TIMEOUT_MS: process.env.TKC_VOICE_SYNTHESIS_TIMEOUT_MS,
  FAKE_VOICE_LOG: process.env.FAKE_VOICE_LOG,
  FAKE_VOICE_DELAY_MS: process.env.FAKE_VOICE_DELAY_MS,
};

let root: string;
let voiceDir: string;
let cacheDir: string;
let voicePath: string;
let workerPath: string;
let logPath: string;
let mod: VoiceModule | null = null;

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeAsset(filePath: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function manifestForAssets(assets: { model: Buffer; config: Buffer; tokenizer: Buffer; tokenizerConfig: Buffer; voice: Buffer }) {
  return {
    model: { sha256: sha256(assets.model), size: assets.model.length },
    metadata: {
      'config.json': { sha256: sha256(assets.config), size: assets.config.length },
      'tokenizer.json': { sha256: sha256(assets.tokenizer), size: assets.tokenizer.length },
      'tokenizer_config.json': { sha256: sha256(assets.tokenizerConfig), size: assets.tokenizerConfig.length },
    },
    voice: { sha256: sha256(assets.voice), size: assets.voice.length },
  };
}

function writeWorker() {
  const script = `
const fs = require('fs');
const log = process.env.FAKE_VOICE_LOG;
const delay = Number(process.env.FAKE_VOICE_DELAY_MS || '20');
fs.appendFileSync(log, JSON.stringify({event:'start', pid:process.pid, env:{
  cache:process.env.TKC_VOICE_CACHE_DIR,
  revision:process.env.TKC_VOICE_MODEL_REVISION,
  localOnly:process.env.TKC_VOICE_LOCAL_ONLY,
  fingerprint:Boolean(process.env.TKC_VOICE_ASSET_FINGERPRINT),
}})+'\\n');
let buf='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    fs.appendFileSync(log, JSON.stringify({event:'request', pid:process.pid, id:msg.id, text:msg.text, requestId:msg.requestId})+ '\\n');
    if (String(msg.text).includes('HANG')) continue;
    setTimeout(() => {
      if (String(msg.text).includes('FAIL')) {
        process.stdout.write(JSON.stringify({id:msg.id, ok:false, error:'fake failure'})+'\\n');
      } else {
        process.stdout.write(JSON.stringify({id:msg.id, ok:true, audio:Buffer.from('RIFFfake').toString('base64')})+'\\n');
      }
    }, delay);
  }
});
`;
  writeAsset(workerPath, script);
}

function readLog() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function loadModule() {
  vi.resetModules();
  const actual = await import('../../server/voiceNative.js');
  mod = actual;
  return actual;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tkc-voice-'));
  voiceDir = path.join(root, 'server', 'voice');
  cacheDir = path.join(root, 'cache');
  voicePath = path.join(root, 'voices', 'af_heart.bin');
  workerPath = path.join(voiceDir, 'voiceChild.cjs');
  logPath = path.join(root, 'worker.log');
  fs.mkdirSync(voiceDir, { recursive: true });
  fs.mkdirSync(path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx'), { recursive: true });
  // Use the real application-trusted assets so verification passes in the
  // positive case. TKC_VOICE_DIR is intentionally not used.
  const realCache = path.join(os.homedir(), '.cache', 'tkc', 'voice');
  fs.cpSync(realCache, cacheDir, { recursive: true });
  // voice path is fixed to the kokoro-js package asset; no redirection.
  writeWorker();
  voiceTestState.workerPath = workerPath;
  process.env.TKC_NATIVE_VOICE_ENABLED = '1';
  process.env.TKC_VOICE_CACHE_DIR = cacheDir;
  process.env.TKC_VOICE_SYNTHESIS_TIMEOUT_MS = '5000';
  process.env.FAKE_VOICE_LOG = logPath;
  process.env.FAKE_VOICE_DELAY_MS = '20';
  delete process.env.TKC_KOKORO_MODULE;
  delete process.env.TKC_VOICE_WORKER;
  delete process.env.TKC_VOICE_TEST_HARNESS;
  delete process.env.TKC_VOICE_TEST_WORKER;
});

afterEach(() => {
  try { mod?.shutdownNativeVoice(); } catch {}
  mod = null;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('native voice bridge', () => {
  it('is disabled by default', async () => {
    delete process.env.TKC_NATIVE_VOICE_ENABLED;
    const voice = await loadModule();
    expect(voice.isNativeVoiceEnabled()).toBe(false);
  });

  it('rejects synthesis when disabled', async () => {
    delete process.env.TKC_NATIVE_VOICE_ENABLED;
    const voice = await loadModule();
    await expect(voice.synthesizeNativeVoice('Hello', 'af_heart')).rejects.toThrow(/disabled/i);
  });

  it('validates the voice allowlist before queueing', async () => {
    const voice = await loadModule();
    await expect(voice.synthesizeNativeVoice('Hello', 'bad-voice')).rejects.toThrow(/Invalid voice/);
  });

  it('ignores a configured Kokoro module path and keeps authority inside the install', async () => {
    process.env.TKC_KOKORO_MODULE = '/tmp/tkc-missing-kokoro-module.cjs';
    const voice = await loadModule();
    expect(voice.isNativeVoiceRuntimeAvailable()).toBe(true);
  });

  it('rejects an already-aborted request before it reaches the worker queue', async () => {
    const voice = await loadModule();
    const controller = new AbortController();
    controller.abort();
    await expect(voice.synthesizeNativeVoice('Hello', 'af_heart', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('verifies assets once, caches the identity, and revalidates after a change', async () => {
    const voice = await loadModule();
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(true);
    const first = voice.getVoiceIntegrityDiagnostics();
    expect(first.hashCount).toBe(5);
    expect(voice.getNativeVoiceRuntimeStatus().cached).toBe(true);
    expect(voice.getVoiceIntegrityDiagnostics().hashCount).toBe(5);

    const modelPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_q4.onnx');
    const originalModel = fs.readFileSync(modelPath);
    fs.writeFileSync(modelPath, 'corrupt-model');
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(false);
    expect(voice.getVoiceIntegrityDiagnostics().hashCount).toBeGreaterThan(5);

    fs.writeFileSync(modelPath, originalModel);
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(true);
  });

  it('fails closed for missing metadata or voice assets', async () => {
    const voice = await loadModule();
    const configPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'config.json');
    const backup = fs.readFileSync(configPath);
    fs.rmSync(configPath);
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(false);
    fs.writeFileSync(configPath, backup);
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(true);
  });

  it('passes the verified local cache and pinned revision to the worker', async () => {
    const voice = await loadModule();
    const audio = await voice.synthesizeNativeVoice('Hello from the local cache.', 'af_heart');
    expect(audio.length).toBeGreaterThan(0);
    const start = readLog().find((entry) => entry.event === 'start');
    expect(start?.env.cache).toBe(cacheDir);
    expect(start?.env.revision).toBe(voice.HEART_MODEL_REVISION);
    expect(start?.env.localOnly).toBe('1');
    expect(start?.env.fingerprint).toBe(true);
  });

  it('uses one worker and applies foreground priority ahead of queued preparation', async () => {
    process.env.FAKE_VOICE_DELAY_MS = '120';
    const voice = await loadModule();
    const background = Array.from({ length: 7 }, (_, i) => voice.synthesizeNativeVoice(`bg-${i}`, 'af_heart', { kind: 'prepare' }));
    const foreground = voice.synthesizeNativeVoice('foreground', 'af_heart', { kind: 'foreground' });
    const results = await Promise.allSettled([...background, foreground]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const entries = readLog();
    const requests = entries.filter((entry) => entry.event === 'request').map((entry) => entry.text);
    expect(requests[1]).toBe('foreground');
    expect(new Set(entries.filter((entry) => entry.event === 'start').map((entry) => entry.pid)).size).toBe(1);
  });

  it('enforces the queued-request bound and rejects overflow safely', async () => {
    process.env.FAKE_VOICE_DELAY_MS = '150';
    const voice = await loadModule();
    const requests = Array.from({ length: 10 }, (_, i) => voice.synthesizeNativeVoice(`cap-${i}`, 'af_heart', { kind: 'prepare' }));
    const results = await Promise.allSettled(requests);
    expect(results.some((result) => result.status === 'rejected' && /queue is full/.test(String((result as PromiseRejectedResult).reason)))).toBe(true);
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeLessThanOrEqual(9);
  });

  it('promotes an existing queued preparation without duplicating it', async () => {
    process.env.FAKE_VOICE_DELAY_MS = '100';
    const voice = await loadModule();
    const active = voice.synthesizeNativeVoice('active', 'af_heart', { kind: 'prepare' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queued = voice.synthesizeNativeVoice('promote-me', 'af_heart', { kind: 'prepare', requestId: 'promote-me' });
    const other = voice.synthesizeNativeVoice('other', 'af_heart', { kind: 'prepare' });
    expect(voice.promoteNativeVoiceRequest('promote-me').promoted).toBe(true);
    await Promise.allSettled([active, queued, other]);
    const requests = readLog().filter((entry) => entry.event === 'request').map((entry) => entry.text);
    expect(requests[0]).toBe('active');
    expect(requests[1]).toBe('promote-me');
    expect(requests.filter((text) => text === 'promote-me')).toHaveLength(1);
  });

  it('removes a queued request when its consumer aborts', async () => {
    process.env.FAKE_VOICE_DELAY_MS = '120';
    const voice = await loadModule();
    const active = voice.synthesizeNativeVoice('active-abort', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const controller = new AbortController();
    const queued = voice.synthesizeNativeVoice('queued-abort', 'af_heart', { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await active;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readLog().some((entry) => entry.event === 'request' && entry.text === 'queued-abort')).toBe(false);
  });

  it('cancels an active request at the worker boundary and recovers queued demand', async () => {
    process.env.FAKE_VOICE_DELAY_MS = '200';
    const voice = await loadModule();
    const controller = new AbortController();
    const active = voice.synthesizeNativeVoice('active-to-cancel', 'af_heart', { signal: controller.signal });
    for (let i = 0; i < 40; i++) {
      if (readLog().some((entry) => entry.event === 'request' && entry.text === 'active-to-cancel')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const queued = voice.synthesizeNativeVoice('queued-after-cancel', 'af_heart');
    controller.abort();
    await expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).resolves.toBeInstanceOf(Buffer);
    const starts = readLog().filter((entry) => entry.event === 'start');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(readLog().some((entry) => entry.event === 'request' && entry.text === 'queued-after-cancel')).toBe(true);
  });

  it('recovers after an active timeout and fails queued work immediately', async () => {
    process.env.TKC_VOICE_SYNTHESIS_TIMEOUT_MS = '120';
    const voice = await loadModule();
    const hanging = voice.synthesizeNativeVoice('HANG', 'af_heart');
    for (let i = 0; i < 40; i++) {
      if (readLog().some((entry) => entry.event === 'request' && entry.text === 'HANG')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const queued = voice.synthesizeNativeVoice('QUEUED-HANG', 'af_heart');
    await expect(hanging).rejects.toThrow(/timed out/i);
    await expect(queued).rejects.toThrow(/timed out/i);
    await expect(voice.synthesizeNativeVoice('OK after timeout', 'af_heart')).resolves.toBeInstanceOf(Buffer);
    const starts = readLog().filter((entry) => entry.event === 'start');
    expect(starts.length).toBe(2);
    expect(readLog().some((entry) => entry.event === 'request' && entry.text === 'OK after timeout')).toBe(true);
  });
});

describe('voiceChild local-only loading', () => {
  async function spawnChildFixture(trustedSource: string | null) {
    const childRoot = path.join(root, 'child-runtime');
    const childVoiceDir = path.join(childRoot, 'server', 'voice');
    const childLog = path.join(childRoot, 'calls.log');
    const childVoice = path.join(childRoot, 'node_modules', 'kokoro-js', 'voices', 'af_heart.bin');
    fs.mkdirSync(childVoiceDir, { recursive: true });
    fs.mkdirSync(path.dirname(childVoice), { recursive: true });
    fs.mkdirSync(path.join(childRoot, 'node_modules', 'kokoro-js', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(childRoot, 'node_modules', '@huggingface', 'transformers'), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL('../../server/voice/voiceChild.cjs', import.meta.url)), path.join(childVoiceDir, 'voiceChild.cjs'));
    fs.copyFileSync(path.join(os.homedir(), '.cache', 'tkc', 'voice', 'kokoro-js-voices', 'af_heart.bin'), childVoice);
    if (trustedSource) writeAsset(path.join(childVoiceDir, 'trustedAssets.cjs'), trustedSource);
    writeAsset(path.join(childRoot, 'node_modules', 'kokoro-js', 'package.json'), JSON.stringify({ name: 'kokoro-js', main: 'dist/index.js' }));
    writeAsset(path.join(childRoot, 'node_modules', 'kokoro-js', 'dist', 'index.js'), `
const fs = require('fs');
const { env } = require('@huggingface/transformers');
class KokoroTTS {
  constructor(model, tokenizer) { this.model = model; this.tokenizer = tokenizer; }
  async generate() { return { toWav: () => Buffer.from('RIFFchild') }; }
}
module.exports = { KokoroTTS, env };
`);
    writeAsset(path.join(childRoot, 'node_modules', '@huggingface', 'transformers', 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.js' }));
    writeAsset(path.join(childRoot, 'node_modules', '@huggingface', 'transformers', 'index.js'), `
const fs = require('fs');
const env = { allowRemoteModels: true, allowLocalModels: true, localModelPath: '', cacheDir: '', useFSCache: false };
class StyleTextToSpeech2Model {
  static async from_pretrained(id, options) {
    fs.appendFileSync(process.env.FAKE_CHILD_LOG, JSON.stringify({ call: 'model', id, options, env: { ...env } }) + '\\n');
    return {};
  }
}
class AutoTokenizer {
  static async from_pretrained(id, options) {
    fs.appendFileSync(process.env.FAKE_CHILD_LOG, JSON.stringify({ call: 'tokenizer', id, options, env: { ...env } }) + '\\n');
    return () => ({ input_ids: { dims: [1, 2] } });
  }
}
module.exports = { StyleTextToSpeech2Model, AutoTokenizer, env };
`);
    const child = spawn(process.execPath, [path.join(childVoiceDir, 'voiceChild.cjs')], {
      env: {
        ...process.env,
        TKC_VOICE_CACHE_DIR: cacheDir,
        TKC_VOICE_MODEL_ID: 'onnx-community/Kokoro-82M-v1.0-ONNX',
        TKC_VOICE_MODEL_REVISION: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
        TKC_VOICE_MODEL_SHA256: '',
        TKC_VOICE_VOICE_SHA256: '',
        TKC_VOICE_METADATA_HASHES: '',
        TKC_VOICE_ASSET_FINGERPRINT: '',
        FAKE_CHILD_LOG: childLog,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stdin.write(JSON.stringify({ id: 'child-1', text: 'Hello', voice: 'af_heart' }) + '\n');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child timeout')), 8000);
      child.stdout.on('data', () => {
        if (stdout.includes('\n')) { clearTimeout(timer); resolve(); }
      });
      child.on('error', reject);
    });
    child.kill('SIGKILL');
    const calls = fs.existsSync(childLog)
      ? fs.readFileSync(childLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { stdout, calls, childRoot };
  }

  it('sets transformers.js to local-only and passes the pinned revision with authentic authority', async () => {
    const trusted = fs.readFileSync(path.resolve(process.cwd(), 'server', 'voice', 'trustedAssets.cjs'), 'utf8');
    const { stdout, calls } = await spawnChildFixture(trusted);
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.options.revision).toBe('1939ad2a8e416c0acfeecc08a694d14ef25f2231');
      expect(call.options.local_files_only).toBe(true);
      expect(call.env.allowRemoteModels).toBe(false);
      expect(call.env.cacheDir).toBe(cacheDir);
      expect(call.env.localModelPath).toBe(cacheDir);
    }
    expect(stdout).toContain('"ok":true');
  });

  it('rejects missing trusted authority', async () => {
    const { stdout } = await spawnChildFixture(null);
    expect(stdout).toContain('"ok":false');
    expect(stdout).toContain('unavailable');
  });

  it('rejects trusted authority missing HEART_METADATA', async () => {
    const badTrusted = `module.exports = {
      HEART_MODEL_REPOSITORY: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      HEART_MODEL_REVISION: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
      HEART_MODEL_FILE: 'onnx/model_q4.onnx',
      HEART_MODEL_SHA256: '04cf570cf9c4153694f76347ed4b9a48c1b59ff1de0999e6605d123966b197c7',
      HEART_MODEL_SIZE: 305215966,
      HEART_VOICE_FILE: 'voices/af_heart.bin',
      HEART_VOICE_SHA256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
      HEART_VOICE_SIZE: 522240,
    };`;
    const { stdout } = await spawnChildFixture(badTrusted);
    expect(stdout).toContain('"ok":false');
    expect(stdout).toContain('fields');
  });
});

describe('worker and trusted-authority environment isolation', () => {
  it('ignores legacy worker environment overrides and resolves the installed worker', async () => {
    process.env.TKC_VOICE_WORKER = '/tmp/opencode/f6-mock-worker.cjs';
    process.env.TKC_VOICE_TEST_HARNESS = '1';
    process.env.TKC_VOICE_TEST_WORKER = '/tmp/opencode/f6-mock-worker.cjs';
    const voice = await loadModule();
    const worker = voice.resolveVoiceChildPath();
    expect(worker).toBe(path.resolve(process.cwd(), 'server', 'voice', 'voiceChild.cjs'));
    delete process.env.TKC_VOICE_WORKER;
    delete process.env.TKC_VOICE_TEST_HARNESS;
    delete process.env.TKC_VOICE_TEST_WORKER;
  });

  it('ignores TKC_VOICE_DIR and never executes a forged trusted module from it', async () => {
    const forgedRoot = path.join(root, 'forged-authority');
    const marker = path.join(root, 'forged-executed.txt');
    fs.mkdirSync(forgedRoot, { recursive: true });
    fs.writeFileSync(path.join(forgedRoot, 'trustedAssets.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports = {};`);
    process.env.TKC_VOICE_DIR = forgedRoot;
    const voice = await loadModule();
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    delete process.env.TKC_VOICE_DIR;
  });
});

describe('voice asset trust boundary (F4)', () => {
  it('rejects a tampered model even though the mutable manifest is forged', async () => {
    const voice = await loadModule();
    const modelPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_q4.onnx');
    fs.writeFileSync(modelPath, 'tampered-model');
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(false);
  });

  it('ignores a forged authority directory even when its manifest is symlinked', async () => {
    const forgedRoot = path.join(root, 'forged-authority');
    fs.mkdirSync(forgedRoot, { recursive: true });
    fs.copyFileSync(path.resolve(process.cwd(), 'server', 'voice', 'trustedAssets.cjs'), path.join(forgedRoot, 'trustedAssets.cjs'));
    const target = path.join(root, 'forged-manifest.json');
    fs.writeFileSync(target, JSON.stringify({ model: { sha256: '0'.repeat(64) } }));
    fs.symlinkSync(target, path.join(forgedRoot, 'integrity.manifest.json'));
    process.env.TKC_VOICE_DIR = forgedRoot;
    const voice = await loadModule();
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(true);
    expect(fs.existsSync(path.join(forgedRoot, 'integrity.manifest.json'))).toBe(true);
  });

  it('ignores attacker-controlled hash environment variables', async () => {
    process.env.TKC_VOICE_MODEL_SHA256 = '0'.repeat(64);
    process.env.TKC_VOICE_VOICE_SHA256 = '0'.repeat(64);
    process.env.TKC_VOICE_METADATA_HASHES = JSON.stringify({ 'config.json': '0'.repeat(64) });
    const voice = await loadModule();
    const modelPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_q4.onnx');
    fs.writeFileSync(modelPath, 'attacker-model');
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(false);
    delete process.env.TKC_VOICE_MODEL_SHA256;
    delete process.env.TKC_VOICE_VOICE_SHA256;
    delete process.env.TKC_VOICE_METADATA_HASHES;
  });

  it('rejects corrupted metadata', async () => {
    const voice = await loadModule();
    const configPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'config.json');
    fs.writeFileSync(configPath, 'corrupted');
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(false);
  });

  it('rejects a corrupted voice asset', async () => {
    const corruptedVoice = path.join(root, 'corrupted-voice.bin');
    fs.writeFileSync(corruptedVoice, 'corrupted-voice');
    const voice = await loadModule();
    expect(voice.getNativeVoiceRuntimeStatus({ voicePath: corruptedVoice }).available).toBe(false);
  });

  it('rejects a symlinked model asset', async () => {
    const voice = await loadModule();
    const modelPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_q4.onnx');
    const target = path.join(root, 'elsewhere-model.bin');
    fs.linkSync(modelPath, target);
    fs.rmSync(modelPath);
    fs.symlinkSync(target, modelPath);
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(false);
  });

  it('rejects a trusted authority with missing required fields', async () => {
    const voice = await loadModule();
    expect(voice.validateTrustedAuthority({})).toMatchObject({ ok: false });
  });

  it('rejects trusted authority missing metadata', async () => {
    const voice = await loadModule();
    const trusted = createRequire(import.meta.url)(path.resolve(process.cwd(), 'server', 'voice', 'trustedAssets.cjs'));
    const incomplete = { ...trusted };
    delete incomplete.HEART_METADATA;
    expect(voice.validateTrustedAuthority(incomplete)).toMatchObject({ ok: false, reason: expect.stringMatching(/missing|unexpected/i) });
  });
});

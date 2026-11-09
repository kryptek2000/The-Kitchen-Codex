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

function syntheticExpected(voiceFile: string) {
  const modelPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_q4.onnx');
  const configPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'config.json');
  const tokenizerPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'tokenizer.json');
  const tokenizerConfigPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'tokenizer_config.json');
  return [
    { name: 'model', file: modelPath, sha256: sha256(fs.readFileSync(modelPath)), size: fs.readFileSync(modelPath).length },
    { name: 'voice', file: voiceFile, sha256: sha256(fs.readFileSync(voiceFile)), size: fs.readFileSync(voiceFile).length },
    { name: 'config.json', file: configPath, sha256: sha256(fs.readFileSync(configPath)), size: fs.readFileSync(configPath).length },
    { name: 'tokenizer.json', file: tokenizerPath, sha256: sha256(fs.readFileSync(tokenizerPath)), size: fs.readFileSync(tokenizerPath).length },
    { name: 'tokenizer_config.json', file: tokenizerConfigPath, sha256: sha256(fs.readFileSync(tokenizerConfigPath)), size: fs.readFileSync(tokenizerConfigPath).length },
  ];
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
  // Hermetic synthetic fixtures (tiny files). No developer model cache, no
  // HOME access. Genuine SHA-256 via node:crypto; asserted through the pure
  // verifyFilesAgainstExpected helper and through production fail-closed
  // behavior with the installed pinned authority.
  writeAsset(path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_q4.onnx'), 'synthetic-model');
  writeAsset(path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'config.json'), '{"synthetic":true}');
  writeAsset(path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'tokenizer.json'), '{"tokenizer":"synthetic"}');
  writeAsset(path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'tokenizer_config.json'), '{"config":"synthetic"}');
  writeAsset(voicePath, 'synthetic-voice');
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

  it('rejects invalid text before verification and queueing', async () => {
    const voice = await loadModule();
    await expect(voice.synthesizeNativeVoice('', 'af_heart')).rejects.toThrow(/Invalid text/);
    await expect(voice.synthesizeNativeVoice('x'.repeat(501), 'af_heart')).rejects.toThrow(/Invalid text/);
  });

  it('rejects an already-aborted request before verification and queueing', async () => {
    const voice = await loadModule();
    const controller = new AbortController();
    controller.abort();
    await expect(voice.synthesizeNativeVoice('Hello', 'af_heart', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores a configured Kokoro module path and resolves the installed worker', async () => {
    process.env.TKC_KOKORO_MODULE = '/tmp/tkc-missing-kokoro-module.cjs';
    const voice = await loadModule();
    expect(voice.resolveVoiceChildPath()).toBe(path.resolve(process.cwd(), 'server', 'voice', 'voiceChild.cjs'));
  });

  it('fails closed without installed assets and does not spawn a worker', async () => {
    const voice = await loadModule();
    const status = voice.getNativeVoiceRuntimeStatus();
    expect(status.available).toBe(false);
    await expect(voice.synthesizeNativeVoice('Hello from the local cache.', 'af_heart')).rejects.toThrow(/runtime is unavailable/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readLog()).toHaveLength(0);
  });

  it('rejects caller-selected trusted authority (installed-only)', async () => {
    const voice = await loadModule();
    const expected = syntheticExpected(voicePath);
    // The synthetic expectation genuinely verifies the fixtures via the pure
    // helper (see pure-verification suite), proving production would be
    // the only gate left. Production must still fail closed because it uses
    // the installed pinned authority, not this caller value.
    expect(voice.verifyFilesAgainstExpected(expected).ok).toBe(true);
    const callerAuthority = {
      HEART_MODEL_REPOSITORY: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      HEART_MODEL_REVISION: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
      HEART_MODEL_FILE: 'onnx/model_q4.onnx',
      HEART_MODEL_SHA256: expected[0].sha256,
      HEART_MODEL_SIZE: expected[0].size,
      HEART_METADATA: {
        'config.json': { sha256: expected[2].sha256, size: expected[2].size },
        'tokenizer.json': { sha256: expected[3].sha256, size: expected[3].size },
        'tokenizer_config.json': { sha256: expected[4].sha256, size: expected[4].size },
      },
      HEART_VOICE_FILE: 'voices/af_heart.bin',
      HEART_VOICE_SHA256: expected[1].sha256,
      HEART_VOICE_SIZE: expected[1].size,
    };
    expect(voice.getNativeVoiceRuntimeStatus({} as any).available).toBe(false);
    expect(voice.verifyNativeVoiceAssets(false, { trustedAuthority: callerAuthority } as any).ok).toBe(false);
    expect(voice.isNativeVoiceRuntimeAvailable({ trustedAuthority: callerAuthority } as any)).toBe(false);
    await expect(voice.synthesizeNativeVoice('Hello', 'af_heart', { trustedAuthority: callerAuthority } as any)).rejects.toThrow(/runtime is unavailable/i);
  });

  it('caches the integrity failure and revalidates after a change', async () => {
    const voice = await loadModule();
    voice.resetVoiceIntegrityCacheForTests();
    const first = voice.getNativeVoiceRuntimeStatus();
    expect(first.available).toBe(false);
    const afterFirst = voice.getVoiceIntegrityDiagnostics();
    expect(afterFirst.hashCount).toBeGreaterThanOrEqual(1);
    const second = voice.getNativeVoiceRuntimeStatus();
    expect(second.available).toBe(false);
    expect(second.cached).toBe(true);
    expect(voice.getVoiceIntegrityDiagnostics().hashCount).toBe(afterFirst.hashCount);
    const modelPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_q4.onnx');
    const original = fs.readFileSync(modelPath);
    fs.writeFileSync(modelPath, 'corrupt-model');
    const third = voice.getNativeVoiceRuntimeStatus();
    expect(third.available).toBe(false);
    expect(third.cached).toBe(false);
    expect(voice.getVoiceIntegrityDiagnostics().hashCount).toBeGreaterThan(afterFirst.hashCount);
    fs.writeFileSync(modelPath, original);
  });
});

describe('pure asset verification (genuine crypto)', () => {
  it('verifies tiny fixtures with correct synthetic expected values', async () => {
    const voice = await loadModule();
    const result = voice.verifyFilesAgainstExpected(syntheticExpected(voicePath));
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(5);
  });

  it('rejects a tampered file with genuine hashing', async () => {
    const voice = await loadModule();
    const expected = syntheticExpected(voicePath);
    fs.writeFileSync(expected[0].file, 'tampered-model');
    const result = voice.verifyFilesAgainstExpected(expected);
    expect(result.ok).toBe(false);
    expect(result.failedAsset).toBe('model');
  });

  it('rejects a size mismatch even with the correct digest', async () => {
    const voice = await loadModule();
    const expected = syntheticExpected(voicePath).map((a) => (a.name === 'model' ? { ...a, size: a.size! + 1 } : a));
    const result = voice.verifyFilesAgainstExpected(expected);
    expect(result.ok).toBe(false);
    expect(result.failedAsset).toBe('model');
    expect(result.reason).toMatch(/size mismatch/i);
  });

  it('rejects a missing file as unreadable', async () => {
    const voice = await loadModule();
    const expected = syntheticExpected(voicePath);
    fs.rmSync(expected[2].file);
    const result = voice.verifyFilesAgainstExpected(expected);
    expect(result.ok).toBe(false);
    expect(result.failedAsset).toBe('config.json');
  });

  it('rejects a symlinked file', async () => {
    const voice = await loadModule();
    const expected = syntheticExpected(voicePath);
    const modelPath = expected[0].file;
    const original = fs.readFileSync(modelPath);
    const target = path.join(root, 'elsewhere-model.bin');
    fs.writeFileSync(target, original);
    fs.rmSync(modelPath);
    fs.symlinkSync(target, modelPath);
    const result = voice.verifyFilesAgainstExpected(expected);
    expect(result.ok).toBe(false);
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
    const kokoroEntry = require.resolve('kokoro-js');
    const realVoicePath = path.resolve(path.dirname(kokoroEntry), '..', 'voices', 'af_heart.bin');
    fs.copyFileSync(realVoicePath, childVoice);
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
    fs.appendFileSync(process.env.FAKE_CHILD_LOG, JSON.stringify({ call: 'model', id, options, env: { ...env } }) + '\\\\n');
    return {};
  }
}
class AutoTokenizer {
  static async from_pretrained(id, options) {
    fs.appendFileSync(process.env.FAKE_CHILD_LOG, JSON.stringify({ call: 'tokenizer', id, options, env: { ...env } }) + '\\\\n');
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

  it('fails closed with the authentic authority when assets do not match', async () => {
    const trusted = fs.readFileSync(path.resolve(process.cwd(), 'server', 'voice', 'trustedAssets.cjs'), 'utf8');
    const { stdout, calls } = await spawnChildFixture(trusted);
    expect(stdout).toContain('"ok":false');
    expect(calls).toHaveLength(0);
  });

  it('pins the local-only configuration and revision in source', async () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'server', 'voice', 'voiceChild.cjs'), 'utf8');
    expect(source).toContain('env.allowRemoteModels = false');
    expect(source).toContain('local_files_only: true');
    expect(source).toContain("'onnx-community/Kokoro-82M-v1.0-ONNX'");
    expect(source).toContain("'1939ad2a8e416c0acfeecc08a694d14ef25f2231'");
    expect(source).toContain("TKC_VOICE_ASSET_FINGERPRINT");
    const parentSource = fs.readFileSync(path.resolve(process.cwd(), 'server', 'voiceNative.ts'), 'utf8');
    expect(parentSource).toContain("TKC_VOICE_LOCAL_ONLY: '1'");
    expect(parentSource).not.toContain('trustedAuthority');
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
    expect(fs.existsSync(marker)).toBe(false);
    expect(voice.resolveVoiceChildPath()).toBe(path.resolve(process.cwd(), 'server', 'voice', 'voiceChild.cjs'));
    expect(voice.getNativeVoiceRuntimeStatus().available).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    delete process.env.TKC_VOICE_DIR;
  });
});

describe('voice asset trust boundary (F4)', () => {
  it('rejects a tampered model via the pure helper and production', async () => {
    const voice = await loadModule();
    const expected = syntheticExpected(voicePath);
    fs.writeFileSync(expected[0].file, 'tampered-model');
    expect(voice.verifyFilesAgainstExpected(expected).ok).toBe(false);
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
    expect(voice.resolveVoiceChildPath()).toBe(path.resolve(process.cwd(), 'server', 'voice', 'voiceChild.cjs'));
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

  it('rejects corrupted metadata via the pure helper', async () => {
    const voice = await loadModule();
    const expected = syntheticExpected(voicePath);
    const configPath = path.join(cacheDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'config.json');
    fs.writeFileSync(configPath, 'corrupted');
    expect(voice.verifyFilesAgainstExpected(expected).ok).toBe(false);
  });

  it('rejects a corrupted voice asset via helper and production voicePath', async () => {
    const voice = await loadModule();
    const corruptedVoice = path.join(root, 'corrupted-voice.bin');
    fs.writeFileSync(corruptedVoice, 'corrupted-voice');
    const expected = syntheticExpected(voicePath);
    expect(voice.verifyFilesAgainstExpected([{ name: 'voice', file: corruptedVoice, sha256: expected[1].sha256, size: expected[1].size }]).ok).toBe(false);
    expect(voice.getNativeVoiceRuntimeStatus({ voicePath: corruptedVoice }).available).toBe(false);
  });

  it('rejects a symlinked model asset via the pure helper', async () => {
    const voice = await loadModule();
    const expected = syntheticExpected(voicePath);
    const modelPath = expected[0].file;
    const original = fs.readFileSync(modelPath);
    const target = path.join(root, 'elsewhere-model.bin');
    fs.writeFileSync(target, original);
    fs.rmSync(modelPath);
    fs.symlinkSync(target, modelPath);
    expect(voice.verifyFilesAgainstExpected(expected).ok).toBe(false);
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

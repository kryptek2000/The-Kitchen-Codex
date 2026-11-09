import { spawn } from 'node:child_process';
import path from 'path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Pinned upstream provenance for the Heart model and voice assets.
// Revision and hashes were independently corroborated against Hugging Face
// x-linked-etag metadata for onnx-community/Kokoro-82M-v1.0-ONNX.
export const HEART_MODEL_REPOSITORY = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const HEART_MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const HEART_MODEL_FILE = 'onnx/model_q4.onnx';
export const HEART_MODEL_SHA256 = '04cf570cf9c4153694f76347ed4b9a48c1b59ff1de0999e6605d123966b197c7';
export const HEART_MODEL_SIZE = 305215966;
export const HEART_VOICE_FILE = 'voices/af_heart.bin';
export const HEART_VOICE_SHA256 = 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b';
export const HEART_VOICE_SIZE = 522240;
export const HEART_MAX_QUEUED_REQUESTS = 8;
export const HEART_DEFAULT_SYNTHESIS_TIMEOUT_MS = 60000;

// Metadata is required by transformers.js to load the ONNX model and
// tokenizer from the application-owned cache. It is verified alongside the
// model so a half-provisioned cache cannot report available.
const HEART_METADATA_SHA256: Record<string, string> = {
  'config.json': 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  'tokenizer.json': '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  'tokenizer_config.json': 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
};
const HEART_METADATA_SIZES: Record<string, number> = {
  'config.json': 44,
  'tokenizer.json': 3497,
  'tokenizer_config.json': 113,
};

type ExpectedAsset = { name: string; file: string; sha256: string; size?: number };

function getModuleDir(): string | null {
  try {
    if (typeof __dirname === 'string') return __dirname;
  } catch {
    // Fall through to import.meta in ESM development mode.
  }
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const TRUSTED_METADATA_NAMES = Object.keys(HEART_METADATA_SHA256);
const TRUSTED_AUTHORITY_KEYS = [
  'HEART_MODEL_REPOSITORY',
  'HEART_MODEL_REVISION',
  'HEART_MODEL_FILE',
  'HEART_MODEL_SHA256',
  'HEART_MODEL_SIZE',
  'HEART_METADATA',
  'HEART_VOICE_FILE',
  'HEART_VOICE_SHA256',
  'HEART_VOICE_SIZE',
];

function isSha256(value: any): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isPositiveInteger(value: any): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function validateTrustedAuthority(value: any): { ok: boolean; reason?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'Trusted authority must be an object.' };
  }
  const authorityKeys = Object.keys(value);
  if (authorityKeys.length !== TRUSTED_AUTHORITY_KEYS.length || authorityKeys.some((key) => !TRUSTED_AUTHORITY_KEYS.includes(key))) {
    return { ok: false, reason: 'Trusted authority has missing or unexpected fields.' };
  }
  if (value.HEART_MODEL_REPOSITORY !== HEART_MODEL_REPOSITORY) {
    return { ok: false, reason: 'Trusted model repository is missing or incorrect.' };
  }
  if (value.HEART_MODEL_REVISION !== HEART_MODEL_REVISION) {
    return { ok: false, reason: 'Trusted model revision is missing or incorrect.' };
  }
  if (value.HEART_MODEL_FILE !== HEART_MODEL_FILE) {
    return { ok: false, reason: 'Trusted model file is missing or incorrect.' };
  }
  if (value.HEART_MODEL_SIZE !== HEART_MODEL_SIZE) {
    return { ok: false, reason: 'Trusted model size is missing or incorrect.' };
  }
  if (!isSha256(value.HEART_MODEL_SHA256) || value.HEART_MODEL_SHA256.toLowerCase() !== HEART_MODEL_SHA256) {
    return { ok: false, reason: 'Trusted model digest is malformed or incorrect.' };
  }
  if (!value.HEART_METADATA || typeof value.HEART_METADATA !== 'object' || Array.isArray(value.HEART_METADATA)) {
    return { ok: false, reason: 'Trusted metadata authority is missing.' };
  }
  const metadataKeys = Object.keys(value.HEART_METADATA);
  if (metadataKeys.length !== TRUSTED_METADATA_NAMES.length || metadataKeys.some((key) => !TRUSTED_METADATA_NAMES.includes(key))) {
    return { ok: false, reason: 'Trusted metadata authority has missing or unexpected entries.' };
  }
  for (const name of TRUSTED_METADATA_NAMES) {
    const entry = value.HEART_METADATA[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: `Trusted metadata entry is malformed: ${name}.` };
    }
    const entryKeys = Object.keys(entry);
    if (entryKeys.length !== 2 || !entryKeys.includes('sha256') || !entryKeys.includes('size')) {
      return { ok: false, reason: `Trusted metadata entry has unexpected fields: ${name}.` };
    }
    if (!isSha256(entry.sha256) || entry.sha256.toLowerCase() !== HEART_METADATA_SHA256[name]) {
      return { ok: false, reason: `Trusted metadata digest is malformed or incorrect: ${name}.` };
    }
    if (!isPositiveInteger(entry.size) || entry.size !== HEART_METADATA_SIZES[name]) {
      return { ok: false, reason: `Trusted metadata size is malformed or incorrect: ${name}.` };
    }
  }
  if (value.HEART_VOICE_FILE !== HEART_VOICE_FILE) {
    return { ok: false, reason: 'Trusted voice file is missing or incorrect.' };
  }
  if (value.HEART_VOICE_SIZE !== HEART_VOICE_SIZE) {
    return { ok: false, reason: 'Trusted voice size is missing or incorrect.' };
  }
  if (!isSha256(value.HEART_VOICE_SHA256) || value.HEART_VOICE_SHA256.toLowerCase() !== HEART_VOICE_SHA256) {
    return { ok: false, reason: 'Trusted voice digest is malformed or incorrect.' };
  }
  return { ok: true };
}

function getVoiceAssetRoot(): string {
  const moduleDir = getModuleDir();
  if (!moduleDir) throw new Error('Application installation directory is unavailable.');
  return path.join(moduleDir, 'voice');
}

function getManifestPath(): string {
  return path.join(getVoiceAssetRoot(), 'integrity.manifest.json');
}

function getChildScriptPath(): string {
  return path.join(getVoiceAssetRoot(), 'voiceChild.cjs');
}

export function resolveVoiceChildPath(): string {
  return getChildScriptPath();
}

export function getVoiceCacheDir(): string {
  const configured = process.env.TKC_VOICE_CACHE_DIR?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), '.cache', 'tkc', 'voice');
}

function getVoiceBinPath(voicePath?: string): string {
  if (voicePath) return path.resolve(voicePath);
  try {
    if (typeof require === 'function') {
      const moduleEntry = require.resolve('kokoro-js');
      return path.resolve(path.dirname(moduleEntry), '..', 'voices', 'af_heart.bin');
    }
  } catch {
    // Fall through to createRequire (ESM development).
  }
  try {
    const moduleDir = getModuleDir();
    if (!moduleDir) throw new Error('Application installation directory is unavailable.');
    const req = createRequire(path.join(moduleDir, 'package.json'));
    const moduleEntry = req.resolve('kokoro-js');
    return path.resolve(path.dirname(moduleEntry), '..', 'voices', 'af_heart.bin');
  } catch {
    return '';
  }
}

let cachedTrustedAssets: any = null;
function getTrustedAssetsPath(): string {
  return path.join(getVoiceAssetRoot(), 'trustedAssets.cjs');
}

function loadTrustedAssets(): any {
  const root = getVoiceAssetRoot();
  if (cachedTrustedAssets) return cachedTrustedAssets;
  const trustedPath = getTrustedAssetsPath();
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(trustedPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  try {
    const req = createRequire(path.join(root, 'package.json'));
    const loaded = req(trustedPath);
    if (!validateTrustedAuthority(loaded).ok) return null;
    cachedTrustedAssets = loaded;
    return cachedTrustedAssets;
  } catch {
    return null;
  }
}

function getExpectedHash(kind: 'model' | 'voice', trusted: any) {
  return kind === 'model' ? trusted.HEART_MODEL_SHA256 : trusted.HEART_VOICE_SHA256;
}

function getExpectedMetadata(trusted: any): Record<string, ExpectedAsset> {
  const result: Record<string, ExpectedAsset> = {};
  for (const name of TRUSTED_METADATA_NAMES) {
    const entry = trusted.HEART_METADATA[name];
    result[name] = {
      name,
      file: name,
      sha256: entry.sha256,
      size: entry.size,
    };
  }
  return result;
}

function getAssetPaths(voicePath?: string) {
  const modelRoot = path.join(getVoiceCacheDir(), ...HEART_MODEL_REPOSITORY.split('/'));
  return {
    modelRoot,
    cacheDir: getVoiceCacheDir(),
    model: path.join(modelRoot, HEART_MODEL_FILE),
    config: path.join(modelRoot, 'config.json'),
    tokenizer: path.join(modelRoot, 'tokenizer.json'),
    tokenizerConfig: path.join(modelRoot, 'tokenizer_config.json'),
    voice: getVoiceBinPath(voicePath),
  };
}

function sha256File(filePath: string): string {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to hash a non-regular or symlinked asset: ${filePath}`);
  }
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function assetIdentity(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    // A symlink could redirect verification away from the actual runtime
    // asset. The supported installation uses regular files only.
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Pure verification primitive. Hashes each listed file with genuine
 * SHA-256 and compares against the supplied expected digest/size.
 * Production `verifyNativeVoiceAssets` calls this only with the installed,
 * validated trusted authority. Tests call it directly with synthetic
 * expected values computed from small fixtures via `node:crypto`.
 * It never selects authority and is not a runtime authority entrypoint.
 */
export function verifyFilesAgainstExpected(
  assets: Array<{ name: string; file: string; sha256: string; size?: number }>,
  onHash?: () => void,
): { ok: boolean; reason?: string; failedAsset?: string; checked: number } {
  let checked = 0;
  for (const asset of assets) {
    let actual: string;
    try {
      checked += 1;
      if (onHash) onHash();
      actual = sha256File(asset.file);
    } catch {
      return { ok: false, reason: `Voice asset is unreadable: ${asset.name}.`, failedAsset: asset.name, checked };
    }
    if (actual !== asset.sha256) {
      return { ok: false, reason: `Voice asset failed integrity verification: ${asset.name}.`, failedAsset: asset.name, checked };
    }
    if (typeof asset.size === 'number') {
      try {
        if (fs.statSync(asset.file).size !== asset.size) {
          return { ok: false, reason: `Voice asset size mismatch: ${asset.name}.`, failedAsset: asset.name, checked };
        }
      } catch {
        return { ok: false, reason: `Voice asset is unreadable: ${asset.name}.`, failedAsset: asset.name, checked };
      }
    }
  }
  return { ok: true, checked };
}

function computeAssetFingerprint(paths: ReturnType<typeof getAssetPaths>): string | null {
  const identities = [
    ['model', paths.model],
    ['config', paths.config],
    ['tokenizer', paths.tokenizer],
    ['tokenizer_config', paths.tokenizerConfig],
    ['voice', paths.voice],
  ].map(([name, filePath]) => {
    const identity = assetIdentity(filePath);
    return identity ? `${name}=${identity}` : null;
  });
  if (identities.some((identity) => identity === null)) return null;
  return identities.join('|');
}

type IntegrityResult = {
  ok: boolean;
  reason?: string;
  fingerprint: string | null;
  cached: boolean;
  checkedAt: number;
};

let cachedIntegrity: IntegrityResult | null = null;
let integrityHashCount = 0;

function rememberIntegrity(result: Omit<IntegrityResult, 'cached'>): IntegrityResult {
  cachedIntegrity = { ...result, cached: false };
  return cachedIntegrity;
}

export function verifyNativeVoiceAssets(force = false, options: { voicePath?: string } = {}): IntegrityResult {
  // Production trust root is installed-only. Caller-supplied authority is
  // not accepted here or in any runtime-status/synthesis entrypoint.
  const trusted = loadTrustedAssets();
  if (!trusted) {
    return rememberIntegrity({
      ok: false,
      reason: 'Trusted voice asset definitions are unavailable.',
      fingerprint: null,
      checkedAt: Date.now(),
    });
  }
  const paths = getAssetPaths(options.voicePath);
  const manifestPath = getManifestPath();
  const manifestExists = fs.existsSync(manifestPath);
  const manifestIdentity = assetIdentity(manifestPath);
  if (manifestExists && !manifestIdentity) {
    return rememberIntegrity({
      ok: false,
      reason: 'Integrity manifest is symlinked or not a regular file.',
      fingerprint: null,
      checkedAt: Date.now(),
    });
  }
  const assetFingerprint = computeAssetFingerprint(paths);
  const fingerprint = assetFingerprint
    ? `${assetFingerprint}|manifest=${manifestIdentity || 'embedded'}`
    : null;

  if (!assetFingerprint || !fingerprint) {
    return rememberIntegrity({
      ok: false,
      reason: 'Voice model, metadata, or voice asset is missing or unreadable.',
      fingerprint: null,
      checkedAt: Date.now(),
    });
  }

  if (!force && cachedIntegrity && cachedIntegrity.fingerprint === fingerprint && cachedIntegrity.ok) {
    const cachedSuccess = { ...cachedIntegrity, cached: true };
    cachedIntegrity = cachedSuccess;
    return cachedSuccess;
  }
  if (!force && cachedIntegrity && cachedIntegrity.fingerprint === fingerprint && !cachedIntegrity.ok) {
    const cachedFailure = { ...cachedIntegrity, cached: true };
    cachedIntegrity = cachedFailure;
    return cachedFailure;
  }

  const expected: ExpectedAsset[] = [
    { name: 'model', file: paths.model, sha256: getExpectedHash('model', trusted), size: trusted.HEART_MODEL_SIZE },
    { name: 'voice', file: paths.voice, sha256: getExpectedHash('voice', trusted), size: trusted.HEART_VOICE_SIZE },
    ...Object.entries(getExpectedMetadata(trusted)).map(([name, asset]) => ({
      ...asset,
      file: path.join(paths.modelRoot, name),
    })),
  ];

  const verification = verifyFilesAgainstExpected(expected, () => { integrityHashCount += 1; });
  if (!verification.ok) {
    return rememberIntegrity({
      ok: false,
      reason: verification.reason || `Voice asset failed integrity verification: ${verification.failedAsset || 'unknown'}.`,
      fingerprint,
      checkedAt: Date.now(),
    });
  }

  return rememberIntegrity({
    ok: true,
    fingerprint,
    checkedAt: Date.now(),
  });
}

export function getNativeVoiceRuntimeStatus(options: { voicePath?: string } = {}) {
  const integrity = verifyNativeVoiceAssets(false, options);
  return {
    available: integrity.ok,
    reason: integrity.ok ? undefined : integrity.reason,
    cacheDir: getVoiceCacheDir(),
    cached: integrity.cached,
  };
}

export function isNativeVoiceRuntimeAvailable(options: { voicePath?: string } = {}) {
  return verifyNativeVoiceAssets(false, options).ok;
}

export function getVoiceIntegrityDiagnostics() {
  return {
    hashCount: integrityHashCount,
    cached: Boolean(cachedIntegrity?.cached),
    fingerprint: cachedIntegrity?.fingerprint || null,
    reason: cachedIntegrity?.reason,
  };
}

export function resetVoiceIntegrityCacheForTests() {
  cachedIntegrity = null;
  cachedTrustedAssets = null;
  integrityHashCount = 0;
}

let child: any = null;
let pending = new Map<string, any>();
let buffer = '';
let lastNativeVoiceTiming: any = null;
let requestQueue: any[] = [];
let activeRequest: any = null;
let requestSequence = 0;
const pendingPromotions = new Set<string>();

function makeAbortError() {
  const error = new Error('Voice synthesis aborted');
  error.name = 'AbortError';
  return error;
}

function getSynthesisTimeoutMs() {
  const configured = Number(process.env.TKC_VOICE_SYNTHESIS_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= 50 && configured <= 600000) return configured;
  return HEART_DEFAULT_SYNTHESIS_TIMEOUT_MS;
}

function removeQueuedRequest(request: any) {
  const index = requestQueue.indexOf(request);
  if (index >= 0) requestQueue.splice(index, 1);
}

function settleQueuedRequest(request: any, error: Error) {
  if (!request || request.settled) return;
  request.settled = true;
  clearTimeout(request.timer);
  request.signal?.removeEventListener('abort', request.onAbort);
  request.reject(error);
}

function rejectAllRequests(error: Error) {
  const requests = new Set<any>([...pending.values(), ...requestQueue]);
  pending.clear();
  requestQueue = [];
  activeRequest = null;
  for (const request of requests) {
    if (!request) continue;
    if (request.settled) continue;
    request.settled = true;
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.onAbort);
    request.reject(error);
  }
}

/**
 * A timeout can only be recovered by discarding the child process: ONNX
 * Runtime is not safely cancellable in-process. The child is terminated at
 * the process boundary, every request that was waiting is failed immediately,
 * and the next request starts a fresh worker with verified assets.
 */
function detachAndKillChild() {
  const oldChild = child;
  child = null;
  buffer = '';
  if (oldChild) {
    try { oldChild.removeAllListeners(); } catch {}
    try { oldChild.stdout?.removeAllListeners(); } catch {}
    try { oldChild.stderr?.removeAllListeners(); } catch {}
    try { oldChild.stdin?.removeAllListeners(); } catch {}
    try { oldChild.kill('SIGKILL'); } catch {}
  }
}

function resetTimedOutWorker(error: Error) {
  const affectedRequests = new Set<any>([...pending.values(), ...requestQueue]);
  pending.clear();
  requestQueue = [];
  activeRequest = null;
  detachAndKillChild();

  for (const request of affectedRequests) {
    if (!request || request.settled) continue;
    request.settled = true;
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.onAbort);
    request.reject(error);
  }
}

/**
 * Cancelling an active request must free the single native worker; ONNX
 * Runtime has no safe in-process abort. The child is terminated at the
 * process boundary and queued work is restarted against a fresh worker.
 */
function cancelActiveVoiceRequest(request: any) {
  if (activeRequest?.id !== request.id) {
    if (!request.settled) {
      request.settled = true;
      clearTimeout(request.timer);
      request.signal?.removeEventListener('abort', request.onAbort);
      request.reject(makeAbortError());
    }
    return;
  }
  pending.delete(request.id);
  activeRequest = null;
  detachAndKillChild();
  if (!request.settled) {
    request.settled = true;
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.onAbort);
    request.reject(makeAbortError());
  }
  pumpVoiceQueue();
}

function rejectQueued(error: Error) {
  const queued = requestQueue.splice(0);
  for (const request of queued) settleQueuedRequest(request, error);
}

function pumpVoiceQueue() {
  if (activeRequest || requestQueue.length === 0) return;
  requestQueue.sort((a, b) => (a.priority - b.priority) || (a.sequence - b.sequence));
  const request = requestQueue.shift();
  if (!child) {
    try {
      startChild();
    } catch (error) {
      settleQueuedRequest(request, error instanceof Error ? error : new Error(String(error)));
      rejectQueued(error instanceof Error ? error : new Error(String(error)));
      return;
    }
  }
  if (request.signal?.aborted) {
    settleQueuedRequest(request, makeAbortError());
    pumpVoiceQueue();
    return;
  }
  activeRequest = request;
  request.sent = true;
  request.sentAt = performance.now();
  pending.set(request.id, request);
  try {
    child.stdin.write(JSON.stringify({
      id: request.id,
      text: request.text,
      voice: request.voice,
      requestId: request.meta.requestId,
      kind: request.meta.kind,
    }) + '\n');
  } catch (error) {
    pending.delete(request.id);
    activeRequest = null;
    settleQueuedRequest(request, error instanceof Error ? error : new Error(String(error)));
    pumpVoiceQueue();
  }
}

function buildChildEnv(fingerprint: string) {
  return {
    ...process.env,
    TKC_VOICE_CACHE_DIR: getVoiceCacheDir(),
    TKC_VOICE_MODEL_ID: HEART_MODEL_REPOSITORY,
    TKC_VOICE_MODEL_REVISION: HEART_MODEL_REVISION,
    TKC_VOICE_ASSET_FINGERPRINT: fingerprint,
    TKC_VOICE_LOCAL_ONLY: '1',
    // Historical compatibility only; the child explicitly sets
    // transformers.js env.cacheDir/localModelPath to the same directory.
    TRANSFORMERS_CACHE: getVoiceCacheDir(),
  };
}

function startChild() {
  if (child) return child;
  const scriptPath = getChildScriptPath();
  if (!fs.existsSync(scriptPath)) throw new Error('Native voice worker is not available in this runtime.');
  const integrity = verifyNativeVoiceAssets();
  if (!integrity.ok) {
    throw new Error(integrity.reason || 'Native voice runtime is unavailable.');
  }
  const assetFingerprint = computeAssetFingerprint(getAssetPaths());
  if (!assetFingerprint) {
    throw new Error('Voice asset identity could not be established.');
  }
  const spawned = spawn(process.execPath, [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildChildEnv(assetFingerprint),
  });
  child = spawned;
  spawned.stdout.setEncoding('utf8');
  spawned.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (activeRequest?.id === msg.id) activeRequest = null;
      lastNativeVoiceTiming = msg.timing ? {
        ...msg.timing,
        bridgeSequence: p.sequence,
        bridgeQueueWaitMs: p.sentAt - p.enqueuedAt,
      } : null;
      clearTimeout(p.timer);
      p.signal?.removeEventListener('abort', p.onAbort);
      if (!p.settled) {
        p.settled = true;
        if (p.aborted) p.reject(makeAbortError());
        else if (msg.ok) p.resolve(Buffer.from(msg.audio, 'base64'));
        else p.reject(new Error(msg.error || 'Voice synthesis failed'));
      }
      pumpVoiceQueue();
    }
  });
  spawned.on('error', (error: Error) => {
    if (child !== spawned) return;
    child = null;
    buffer = '';
    rejectAllRequests(new Error(`Voice worker failed to start: ${error.message}`));
  });
  spawned.on('exit', (code: number | null, signal: string | null) => {
    if (child !== spawned) return;
    child = null;
    buffer = '';
    rejectAllRequests(new Error(`Voice worker exited${code === null ? ` (${signal || 'unknown signal'})` : ` with code ${code}`}`));
  });
  spawned.stderr.on('data', (d: Buffer) => console.warn('voice worker stderr:', String(d).slice(0, 200)));
  return spawned;
}

export function isNativeVoiceEnabled() {
  return process.env.TKC_NATIVE_VOICE_ENABLED === '1';
}

export function getLastNativeVoiceTiming() {
  return lastNativeVoiceTiming;
}

export function promoteNativeVoiceRequest(requestId?: string) {
  if (!requestId) return { found: false, promoted: false, active: false, pending: false };
  if (activeRequest?.meta?.requestId === requestId) {
    return { found: true, promoted: false, active: true, pending: false };
  }
  const request = requestQueue.find((candidate) => candidate.meta?.requestId === requestId);
  if (request) {
    request.priority = 0;
    request.meta.kind = 'foreground';
    requestQueue.sort((a, b) => (a.priority - b.priority) || (a.sequence - b.sequence));
    return { found: true, promoted: true, active: false, pending: false };
  }
  // The promotion can race the speak request. Remember a bounded set of
  // request IDs so the next matching enqueue starts at foreground priority.
  if (pendingPromotions.size < 128) pendingPromotions.add(requestId);
  return { found: false, promoted: false, active: false, pending: true };
}

export async function synthesizeNativeVoice(text: string, voice: string, meta: { requestId?: string; kind?: string; signal?: AbortSignal } = {}): Promise<Buffer> {
  if (!isNativeVoiceEnabled()) throw new Error('Native voice is disabled.');
  if (!['af_bella', 'af_heart'].includes(voice)) throw new Error('Invalid voice');
  if (typeof text !== 'string' || text.length === 0 || text.length > 500) throw new Error('Invalid text');
  if (meta.signal?.aborted) throw makeAbortError();
  const integrity = verifyNativeVoiceAssets();
  if (!integrity.ok) throw new Error(`Native voice runtime is unavailable: ${integrity.reason || 'unverified assets'}`);

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return await new Promise<Buffer>((resolve, reject) => {
    if (meta.signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const requestId = meta.requestId;
    const promoted = Boolean(requestId && pendingPromotions.delete(requestId));
    const kind = meta.kind === 'foreground' || promoted ? 'foreground' : 'prepare';
    const request = {
      id,
      text,
      voice,
      meta: { kind, requestId },
      priority: kind === 'foreground' ? 0 : 1,
      sequence: ++requestSequence,
      signal: meta.signal,
      enqueuedAt: performance.now(),
      sentAt: 0,
      sent: false,
      aborted: false,
      settled: false,
      timer: null as any,
      onAbort: undefined as (() => void) | undefined,
      resolve,
      reject,
    };
    const timeoutMs = getSynthesisTimeoutMs();
    const timer = setTimeout(() => {
      if (request.settled) return;
      const wasActive = activeRequest?.id === id;
      if (wasActive) {
        // The active ONNX operation cannot be cancelled in-process. Terminate
        // the child at the process boundary and fail everything it was
        // serving immediately so the queue cannot remain wedged.
        const error = new Error('Voice synthesis timed out');
        resetTimedOutWorker(error);
        return;
      }
      removeQueuedRequest(request);
      settleQueuedRequest(request, new Error('Voice synthesis timed out'));
      pumpVoiceQueue();
    }, timeoutMs);
    request.timer = timer;
    const onAbort = () => {
      request.aborted = true;
      if (!request.sent) {
        removeQueuedRequest(request);
        settleQueuedRequest(request, makeAbortError());
        pumpVoiceQueue();
        return;
      }
      if (!request.settled) {
        // The single worker cannot abort ONNX in-process. If this request is
        // active, terminate the child at the process boundary and start a
        // fresh worker for any queued demand.
        if (activeRequest?.id === request.id) {
          cancelActiveVoiceRequest(request);
        } else {
          request.settled = true;
          clearTimeout(request.timer);
          request.signal?.removeEventListener('abort', request.onAbort);
          request.reject(makeAbortError());
        }
      }
    };
    request.onAbort = onAbort;
    meta.signal?.addEventListener('abort', onAbort, { once: true });
    if (requestQueue.length >= HEART_MAX_QUEUED_REQUESTS) {
      clearTimeout(request.timer);
      request.signal?.removeEventListener('abort', request.onAbort);
      request.settled = true;
      pendingPromotions.delete(requestId || '');
      reject(new Error('Native voice queue is full'));
      return;
    }
    requestQueue.push(request);
    pumpVoiceQueue();
  });
}

export function shutdownNativeVoice() {
  const oldChild = child;
  child = null;
  if (oldChild) {
    try { oldChild.removeAllListeners(); } catch {}
    try { oldChild.kill('SIGKILL'); } catch {}
  }
  rejectAllRequests(new Error('Native voice worker shut down.'));
  pendingPromotions.clear();
}

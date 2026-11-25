const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createRequire } = require('module');

const PINNED_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const PINNED_MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
if (process.env.TKC_VOICE_MODEL_ID && process.env.TKC_VOICE_MODEL_ID !== PINNED_MODEL_ID) {
  throw new Error('Unexpected Heart model repository.');
}
if (process.env.TKC_VOICE_MODEL_REVISION && process.env.TKC_VOICE_MODEL_REVISION !== PINNED_MODEL_REVISION) {
  throw new Error('Unexpected Heart model revision.');
}
const MODEL_ID = PINNED_MODEL_ID;
const MODEL_REVISION = PINNED_MODEL_REVISION;
const CACHE_DIR = process.env.TKC_VOICE_CACHE_DIR
  ? path.resolve(process.env.TKC_VOICE_CACHE_DIR)
  : path.join(os.homedir(), '.cache', 'tkc', 'voice');
const MODEL_ROOT = path.join(CACHE_DIR, ...MODEL_ID.split('/'));
const MODEL_PATH = path.join(MODEL_ROOT, 'onnx', 'model_q4.onnx');
const CONFIG_PATH = path.join(MODEL_ROOT, 'config.json');
const TOKENIZER_PATH = path.join(MODEL_ROOT, 'tokenizer.json');
const TOKENIZER_CONFIG_PATH = path.join(MODEL_ROOT, 'tokenizer_config.json');

function resolveKokoroVoicePath() {
  const entry = require.resolve('kokoro-js');
  return path.resolve(path.dirname(entry), '..', 'voices', 'af_heart.bin');
}

const VOICE_PATH = resolveKokoroVoicePath();

// Resolve transformers.js through kokoro-js's own require so the env object we
// configure is the exact instance used by KokoroTTS.
const kokoroRequire = createRequire(require.resolve('kokoro-js'));
const { StyleTextToSpeech2Model, AutoTokenizer, env } = kokoroRequire('@huggingface/transformers');
const { KokoroTTS } = kokoroRequire('kokoro-js');

// Local-only: never fetch a missing or changed asset from Hugging Face. The
// parent process verifies the same cache and passes its identity to us.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = CACHE_DIR;
env.cacheDir = CACHE_DIR;
env.useFSCache = true;
env.useBrowserCache = false;

function assetIdentity(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

function computeAssetFingerprint() {
  const identities = [
    ['model', MODEL_PATH],
    ['config', CONFIG_PATH],
    ['tokenizer', TOKENIZER_PATH],
    ['tokenizer_config', TOKENIZER_CONFIG_PATH],
    ['voice', VOICE_PATH],
  ].map(([name, filePath]) => {
    const identity = assetIdentity(filePath);
    return identity ? `${name}=${identity}` : null;
  });
  if (identities.some((identity) => identity === null)) return null;
  return identities.join('|');
}

function assertRegularFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Voice asset is not a regular file: ${filePath}`);
  }
}

function sha256File(filePath) {
  assertRegularFile(filePath);
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

const TRUSTED_ASSETS_MODULE = path.join(__dirname, 'trustedAssets.cjs');

const TRUSTED_CONSTANTS = Object.freeze({
  HEART_MODEL_REPOSITORY: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  HEART_MODEL_REVISION: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  HEART_MODEL_FILE: 'onnx/model_q4.onnx',
  HEART_MODEL_SHA256: '04cf570cf9c4153694f76347ed4b9a48c1b59ff1de0999e6605d123966b197c7',
  HEART_MODEL_SIZE: 305215966,
  HEART_VOICE_FILE: 'voices/af_heart.bin',
  HEART_VOICE_SHA256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  HEART_VOICE_SIZE: 522240,
  HEART_METADATA: Object.freeze({
    'config.json': Object.freeze({ sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f', size: 44 }),
    'tokenizer.json': Object.freeze({ sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34', size: 3497 }),
    'tokenizer_config.json': Object.freeze({ sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20', size: 113 }),
  }),
});

const SHA256_HEX = /^[0-9a-f]{64}$/i;

function validateTrustedAssets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trusted voice asset definitions are malformed.');
  const expectedKeys = Object.keys(TRUSTED_CONSTANTS);
  const providedKeys = Object.keys(value);
  if (providedKeys.length !== expectedKeys.length || providedKeys.some((key) => !expectedKeys.includes(key))) {
    throw new Error('Trusted voice asset definitions have missing or unexpected fields.');
  }
  for (const key of ['HEART_MODEL_REPOSITORY', 'HEART_MODEL_REVISION', 'HEART_MODEL_FILE', 'HEART_MODEL_SHA256', 'HEART_MODEL_SIZE', 'HEART_VOICE_FILE', 'HEART_VOICE_SHA256', 'HEART_VOICE_SIZE']) {
    if (value[key] !== TRUSTED_CONSTANTS[key]) throw new Error(`Trusted voice asset definition is missing or incorrect: ${key}.`);
  }
  if (typeof value.HEART_MODEL_SHA256 !== 'string' || !SHA256_HEX.test(value.HEART_MODEL_SHA256)) throw new Error('Trusted model digest is malformed.');
  if (typeof value.HEART_VOICE_SHA256 !== 'string' || !SHA256_HEX.test(value.HEART_VOICE_SHA256)) throw new Error('Trusted voice digest is malformed.');
  if (!value.HEART_METADATA || typeof value.HEART_METADATA !== 'object' || Array.isArray(value.HEART_METADATA)) throw new Error('Trusted metadata authority is missing.');
  const names = Object.keys(TRUSTED_CONSTANTS.HEART_METADATA);
  const provided = Object.keys(value.HEART_METADATA);
  if (provided.length !== names.length || provided.some((name) => !names.includes(name))) throw new Error('Trusted metadata authority has missing or unexpected entries.');
  for (const name of names) {
    const entry = value.HEART_METADATA[name];
    const expected = TRUSTED_CONSTANTS.HEART_METADATA[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Trusted metadata entry is malformed: ${name}.`);
    const entryKeys = Object.keys(entry);
    if (entryKeys.length !== 2 || !entryKeys.includes('sha256') || !entryKeys.includes('size')) throw new Error(`Trusted metadata entry has unexpected fields: ${name}.`);
    if (entry.sha256 !== expected.sha256 || typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) throw new Error(`Trusted metadata digest is missing or incorrect: ${name}.`);
    if (entry.size !== expected.size || !Number.isInteger(entry.size) || entry.size <= 0) throw new Error(`Trusted metadata size is missing or incorrect: ${name}.`);
  }
  return value;
}

function loadTrustedAssets() {
  let stat;
  try {
    stat = fs.lstatSync(TRUSTED_ASSETS_MODULE);
  } catch {
    throw new Error('Trusted voice asset definitions are unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Trusted voice asset definitions are invalid.');
  }
  let loaded;
  try {
    loaded = require(TRUSTED_ASSETS_MODULE);
  } catch {
    throw new Error('Trusted voice asset definitions are malformed.');
  }
  return validateTrustedAssets(loaded);
}

function verifyFileSize(filePath, expectedSize) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Voice asset is not a regular file: ${filePath}`);
  if (stat.size !== expectedSize) throw new Error(`Voice asset size mismatch: ${filePath}`);
}

function verifyAssetsBeforeLoad() {
  const trusted = loadTrustedAssets();
  const expectedFingerprint = process.env.TKC_VOICE_ASSET_FINGERPRINT;
  if (expectedFingerprint) {
    const actual = computeAssetFingerprint();
    if (!actual) throw new Error('Voice assets are missing or incomplete.');
    if (actual !== expectedFingerprint) throw new Error('Voice assets changed after verification.');
  }

  if (sha256File(MODEL_PATH) !== trusted.HEART_MODEL_SHA256) {
    throw new Error('Heart model asset failed integrity verification.');
  }
  verifyFileSize(MODEL_PATH, trusted.HEART_MODEL_SIZE);

  const files = {
    'config.json': CONFIG_PATH,
    'tokenizer.json': TOKENIZER_PATH,
    'tokenizer_config.json': TOKENIZER_CONFIG_PATH,
  };
  for (const name of Object.keys(trusted.HEART_METADATA)) {
    const expected = trusted.HEART_METADATA[name];
    const filePath = files[name];
    if (!filePath) throw new Error(`Unknown voice metadata asset: ${name}.`);
    if (sha256File(filePath) !== expected.sha256) {
      throw new Error(`Voice metadata failed integrity verification: ${name}.`);
    }
    verifyFileSize(filePath, expected.size);
  }

  if (sha256File(VOICE_PATH) !== trusted.HEART_VOICE_SHA256) {
    throw new Error('Heart voice asset failed integrity verification.');
  }
  verifyFileSize(VOICE_PATH, trusted.HEART_VOICE_SIZE);
}

let tts = null;
async function getModel() {
  if (tts) return tts;
  verifyAssetsBeforeLoad();
  const model = await StyleTextToSpeech2Model.from_pretrained(MODEL_ID, {
    dtype: 'q4',
    device: 'cpu',
    revision: MODEL_REVISION,
    local_files_only: true,
    cache_dir: CACHE_DIR,
  });
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
    revision: MODEL_REVISION,
    local_files_only: true,
    cache_dir: CACHE_DIR,
  });
  tts = new KokoroTTS(model, tokenizer);
  return tts;
}

let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    queue = queue.then(async () => {
      const { id, text, voice } = msg;
      try {
        const model = await getModel();
        const audio = await model.generate(text, { voice });
        const wav = audio.toWav();
        const ab = typeof wav?.arrayBuffer === 'function' ? await wav.arrayBuffer() : wav;
        const b64 = Buffer.from(ab).toString('base64');
        process.stdout.write(JSON.stringify({ id, ok: true, audio: b64, ms: 0 }) + '\n');
      } catch (err) {
        process.stdout.write(JSON.stringify({ id, ok: false, error: String(err?.message || err) }) + '\n');
      }
    });
  }
});

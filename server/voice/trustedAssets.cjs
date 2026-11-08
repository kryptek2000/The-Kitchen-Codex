'use strict';

// Trusted application-distributed asset authority for Heart.
// This module is part of the packaged application. It is not a cache file,
// manifest, or environment configuration, and must not be replaced by
// model-cache tampering.
const HEART_MODEL_REPOSITORY = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const HEART_MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const HEART_MODEL_FILE = 'onnx/model_q4.onnx';
const HEART_MODEL_SHA256 = '04cf570cf9c4153694f76347ed4b9a48c1b59ff1de0999e6605d123966b197c7';
const HEART_MODEL_SIZE = 305215966;

const HEART_METADATA = {
  'config.json': {
    sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
    size: 44,
  },
  'tokenizer.json': {
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
    size: 3497,
  },
  'tokenizer_config.json': {
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
    size: 113,
  },
};

const HEART_VOICE_FILE = 'voices/af_heart.bin';
const HEART_VOICE_SHA256 = 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b';
const HEART_VOICE_SIZE = 522240;

module.exports = {
  HEART_MODEL_REPOSITORY,
  HEART_MODEL_REVISION,
  HEART_MODEL_FILE,
  HEART_MODEL_SHA256,
  HEART_MODEL_SIZE,
  HEART_METADATA,
  HEART_VOICE_FILE,
  HEART_VOICE_SHA256,
  HEART_VOICE_SIZE,
};
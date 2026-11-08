# Heart Voice Provenance

## Runtime

- Engine: `kokoro-js` 1.2.1 (npm package), Apache-2.0.
- Model repository: `onnx-community/Kokoro-82M-v1.0-ONNX`
- Pinned revision: `1939ad2a8e416c0acfeecc08a694d14ef25f2231`
- Model file: `onnx/model_q4.onnx`
- Model SHA-256: `04cf570cf9c4153694f76347ed4b9a48c1b59ff1de0999e6605d123966b197c7`
- Voice file: `voices/af_heart.bin` (distributed via `kokoro-js` 1.2.1)
- Voice SHA-256: `d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b`
- License: Apache-2.0 (model, voice, and kokoro-js).

## Authoritative cache

The native child loads only the application-owned cache:

```
~/.cache/tkc/voice/onnx-community/Kokoro-82M-v1.0-ONNX/
  onnx/model_q4.onnx
  config.json
  tokenizer.json
  tokenizer_config.json
```

It sets `transformers.js` `env.cacheDir` and `env.localModelPath` to this
directory, pins the model revision, enables `local_files_only`, and disables
`allowRemoteModels`. A missing, incomplete, or corrupt cache fails closed and
never falls back to a package-local cache or a network download. The voice
asset is loaded by `kokoro-js` from its package `voices/af_heart.bin` and is
verified by the same integrity lifecycle.

## Integrity

The runtime verifies the SHA-256 of the model, the three required metadata
files, and the Heart voice asset against the application-installed trusted
definition in `server/voice/trustedAssets.cjs`. The JSON file is retained as a
non-authoritative audit record, and the mutable `integrity.manifest.json` is
never authoritative. The verified asset identity
(device, inode, size, mtime, ctime) is cached in-process; later status and
synthesis requests only re-stat the files. If the identity changes, the full
hashes are recomputed before the assets are used again. Missing or corrupt
assets cause native voice to report unavailable and synthesis requests to fail
safely. The native child independently reads the same trusted definition and
validates assets before loading, and runs with remote model loading disabled.

Runtime environment variables cannot redefine expected hashes. An attacker
controlling only the writable model cache cannot authorize an arbitrary asset
by modifying a manifest or supplying environment variables. An attacker who
can modify the installed application code or trusted definition is outside the
ordinary model-cache tampering boundary.

The hashes were corroborated against Hugging Face `x-linked-etag` metadata for
the pinned revision. They match the locally observed hashes reported by the
independent audit.

## Limitations

- The pinned revision and hashes are corroborated against upstream Hugging Face
  metadata at audit time. This is not an independently published, signed
  upstream reference digest; redistribution rights are governed by the
  repository's Apache-2.0 license and upstream terms.
- No additional downloads are performed during startup or synthesis. Native
  voice remains disabled by default (`TKC_NATIVE_VOICE_ENABLED=1` required).
- A duplicate model cache remains under `node_modules/@huggingface/transformers/.cache`
  from the previous implementation. It is no longer read by the runtime; safe
  cleanup is reported separately and deferred until after acceptance.
- Third-party notices: kokoro-js, `@huggingface/transformers`, and the
  Kokoro-82M model are Apache-2.0; `onnxruntime-node` is MIT. See their
  respective LICENSE files in `node_modules` and the model repository.

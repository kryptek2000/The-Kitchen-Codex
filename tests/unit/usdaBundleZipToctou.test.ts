/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: ZIP same-open-descriptor binding.
 *
 * These tests exercise the test-only Python function boundary
 * (`zip_extract.stage_verified_archive` / `extract_member`) directly. That
 * boundary cannot affect production invocation: production only ever calls the
 * CLI `main()`. The tests prove that the bytes hashed are the bytes extracted,
 * that a replacement/rename/mutation/symlink cannot substitute extraction bytes,
 * and that the ZIP reader only ever receives the private verified copy.
 *
 * No production environment-variable hook or hidden CLI bypass exists.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTRACTOR_DIR = resolve(__dirname, '..', '..', 'scripts', 'usda_bundle');

const HARNESS = String.raw`
import os, sys, json, tempfile, hashlib, zipfile, shutil
sys.path.insert(0, os.environ["EXTRACTOR_DIR"])
import zip_extract

def build_zip(path, content):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("payload.json", content)

def sha_file(p):
    with open(p, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()

results = {}
work = tempfile.mkdtemp()
try:
    # 1. replace the original pathname AFTER staging -> extracted content is A
    a = os.path.join(work, "a.zip"); build_zip(a, '{"which":"A"}')
    root = tempfile.mkdtemp()
    priv = zip_extract.stage_verified_archive(a, sha_file(a), root, 1 << 30)
    results["private_mode"] = oct(os.stat(priv).st_mode & 0o777)
    results["private_inside_root"] = os.path.dirname(priv) == root
    b = os.path.join(work, "b.zip"); build_zip(b, '{"which":"B"}')
    os.replace(b, a)
    out = os.path.join(work, "out1")
    zip_extract.extract_member(priv, "payload.json", out, 1 << 20, 1 << 20, 400)
    with open(os.path.join(out, "payload.json")) as fh:
        results["replace_after_stage_content"] = fh.read()
    shutil.rmtree(root, ignore_errors=True)

    # 2. replace BEFORE staging -> digest mismatch
    c = os.path.join(work, "c.zip"); build_zip(c, '{"which":"C"}')
    expected = sha_file(c)
    d = os.path.join(work, "d.zip"); build_zip(d, '{"which":"D"}')
    os.replace(d, c)
    root = tempfile.mkdtemp()
    try:
        zip_extract.stage_verified_archive(c, expected, root, 1 << 30)
        results["replace_before_stage"] = "NO_ERROR"
    except zip_extract.ExtractError as error:
        results["replace_before_stage"] = error.code
    finally:
        shutil.rmtree(root, ignore_errors=True)

    # 3. in-place content mutation -> digest mismatch
    e = os.path.join(work, "e.zip"); build_zip(e, '{"which":"E"}')
    expected_e = sha_file(e)
    with open(e, "r+b") as fh:
        fh.seek(0); fh.write(b"\x00")
    root = tempfile.mkdtemp()
    try:
        zip_extract.stage_verified_archive(e, expected_e, root, 1 << 30)
        results["in_place_mutation"] = "NO_ERROR"
    except zip_extract.ExtractError as error:
        results["in_place_mutation"] = error.code
    finally:
        shutil.rmtree(root, ignore_errors=True)

    # 4. symlink substitution -> rejected
    real = os.path.join(work, "real.zip"); build_zip(real, '{"which":"REAL"}')
    link = os.path.join(work, "link.zip"); os.symlink(real, link)
    root = tempfile.mkdtemp()
    try:
        zip_extract.stage_verified_archive(link, sha_file(real), root, 1 << 30)
        results["symlink"] = "NO_ERROR"
    except zip_extract.ExtractError as error:
        results["symlink"] = error.code
    finally:
        shutil.rmtree(root, ignore_errors=True)

    # 5. reader only uses the private copy (original deleted before extraction)
    g = os.path.join(work, "g.zip"); build_zip(g, '{"which":"G"}')
    root = tempfile.mkdtemp()
    priv = zip_extract.stage_verified_archive(g, sha_file(g), root, 1 << 30)
    os.remove(g)
    out = os.path.join(work, "out5")
    zip_extract.extract_member(priv, "payload.json", out, 1 << 20, 1 << 20, 400)
    with open(os.path.join(out, "payload.json")) as fh:
        results["private_copy_after_original_deleted"] = fh.read()
    shutil.rmtree(root, ignore_errors=True)
finally:
    shutil.rmtree(work, ignore_errors=True)

print(json.dumps(results))
`;

function runHarness(): Record<string, unknown> {
  const result = spawnSync('python3', ['-c', HARNESS], {
    env: { ...process.env, EXTRACTOR_DIR, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`harness failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('phase 4.5A ZIP same-open-descriptor binding', () => {
  const results = runHarness();

  it('stages a private copy with mode 0600 inside the private directory', () => {
    expect(results.private_mode).toBe('0o600');
    expect(results.private_inside_root).toBe(true);
  });

  it('extracts the verified bytes even after the original pathname is replaced', () => {
    expect(results.replace_after_stage_content).toBe('{"which":"A"}');
  });

  it('rejects a replacement before staging via the pinned digest', () => {
    expect(results.replace_before_stage).toBe('archive_digest_mismatch');
  });

  it('rejects in-place content mutation via the pinned digest', () => {
    expect(results.in_place_mutation).toBe('archive_digest_mismatch');
  });

  it('rejects symlink substitution', () => {
    expect(results.symlink).toBe('archive_is_symlink');
  });

  it('lets the ZIP reader use only the private verified copy', () => {
    expect(results.private_copy_after_original_deleted).toBe('{"which":"G"}');
  });
});

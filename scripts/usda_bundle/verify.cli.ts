/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: executable verifier entry.
 *
 * ENTRY-ONLY. This module unconditionally invokes the verifier CLI runner. It is
 * never imported by production code, the generator, the verifier implementation,
 * or test helpers (tests exercise it as a real subprocess). All failures are
 * contained by `runVerifyCli`, which returns a nonzero exit code and emits only a
 * fixed, bounded diagnostic.
 */

import { runVerifyCli } from './verify';

process.exitCode = runVerifyCli(process.argv.slice(2));

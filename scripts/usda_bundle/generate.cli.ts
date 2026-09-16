/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: executable generator entry.
 *
 * ENTRY-ONLY. This module unconditionally invokes the generator CLI runner. It is
 * never imported by production code, the generator implementation, the verifier,
 * or test helpers (tests exercise it as a real subprocess). All failures are
 * contained by `runGenerateCli`, which returns a nonzero exit code and emits only
 * a fixed, bounded diagnostic.
 */

import { runGenerateCli } from './generate';

process.exitCode = runGenerateCli(process.argv.slice(2));

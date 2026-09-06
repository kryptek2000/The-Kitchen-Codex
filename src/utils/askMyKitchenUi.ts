/**
 * The Kitchen Codex — Ask My Kitchen UI helper layer (compatibility re-export shim).
 *
 * Phase 4C1 reclassified this module as APPLICATION / UI-WIRING (it is pure, but
 * it wires the Ask My Kitchen deterministic core into the UI and validates
 * untrusted server responses) and moved the implementation into the application
 * layer (`src/application/askMyKitchenUi.ts`). This file is a LOGIC-FREE re-export
 * shim so existing UI/tests importing `src/utils/askMyKitchenUi` keep resolving
 * the same implementation without a rewrite.
 */
export * from '../application/askMyKitchenUi';

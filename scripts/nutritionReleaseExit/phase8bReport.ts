/**
 * The Kitchen Codex — Phase 8B production-browser proof gate derivation.
 *
 * Consumes browser-observed facts and DERIVES per-gate proof status. Nothing
 * about CI outcomes is hardcoded and no gate is asserted by hand: each status
 * falls out of whether the specific observation the gate requires was actually
 * made. That is what makes the contract test's mutation proofs meaningful — a
 * mutated observation must flip the derived status.
 *
 * TEST/PLANNING ONLY: this module is not imported by any production module, is
 * not part of the application build graph, and never enters `plugin/main.js`.
 */

export const PHASE8B_SCHEMA = 'nutrition_phase8b_production_browser_proof_v1';

export type ProofTier = 'basic' | 'ai_advanced';

/** Closed evidence vocabulary. `browser_automation` is the Phase 8A requirement. */
export type EvidenceLevel =
  | 'none'
  | 'dom'
  | 'integration'
  | 'server'
  | 'production_build'
  | 'browser_automation';

export type GateStatus = 'PROVEN' | 'REFUTED' | 'NOT_PROVEN';

export interface BundleObservation {
  readonly artifactsRequested: ReadonlyArray<string>;
  readonly allSameOrigin: boolean;
  readonly allSucceeded: boolean;
  readonly authenticated: boolean;
  readonly genuineSession: boolean;
  readonly liveUsdaRequests: number;
}

export interface RecipeObservation {
  readonly title: string;
  readonly servings: number;
  readonly ingredientCount: number;
}

export interface ReviewObservation {
  readonly total: number;
  readonly matched: number;
  readonly needsAmount: number;
  readonly needsMatch: number;
  readonly reviewSuggested: number;
  readonly qualitative: number;
}

export interface CalculationObservation {
  readonly previewRendered: boolean;
  readonly nutrientTotalsPresent: boolean;
  readonly partialReportedTruthfully: boolean;
  readonly previewDigest: string;
  readonly applyEligible: boolean;
}

export interface EntitlementObservation {
  readonly productAccessTier: string | null;
  readonly aiPanelRendered: boolean;
  readonly expectedReason: 'product_not_enabled' | 'provider_unavailable' | null;
  readonly observedMessage: string;
  readonly aiActionsDisabled: boolean;
}

export interface PersistedBlockObservation {
  readonly hasBlock: boolean;
  readonly schema: number;
  readonly basis: string;
  readonly status: string;
  readonly digest: string;
  readonly hasUsdaRelease: boolean;
  readonly sourceRelease: string;
}

export interface ApplyObservation {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly successMessage: string;
  readonly downloadObserved: boolean;
  readonly persistedDigestMatchesPreview: boolean;
  readonly persistedBlock: PersistedBlockObservation | null;
}

export interface AccessibilityObservation {
  readonly performed: boolean;
  readonly keyboardContained: boolean;
  readonly escapeClosed: boolean;
  readonly focusRestored: boolean;
  readonly allControlsNamed: boolean;
  readonly dialogNamed: boolean;
}

export interface RuntimeObservation {
  readonly consoleErrors: number;
  readonly exceptions: number;
  readonly unexpectedExternalRequests: number;
  readonly providerRequests: number;
  readonly liveUsdaRequests: number;
}

export interface Phase8bObservation {
  readonly tier: ProofTier;
  readonly productionServer: boolean;
  readonly builtApp: boolean;
  readonly recipe: RecipeObservation | null;
  readonly bundle: BundleObservation;
  readonly review: ReviewObservation | null;
  readonly calculation: CalculationObservation | null;
  readonly entitlement: EntitlementObservation;
  readonly apply: ApplyObservation;
  readonly accessibility: AccessibilityObservation | null;
  readonly runtime: RuntimeObservation;
}

export interface Phase8bGate {
  readonly gate: string;
  readonly status: GateStatus;
  readonly evidence_level: EvidenceLevel;
  readonly required_evidence_level: EvidenceLevel;
  readonly detail: string;
}

export interface Phase8bProof {
  readonly schema: typeof PHASE8B_SCHEMA;
  readonly base_commit: string;
  readonly browser: {
    readonly real_browser: boolean;
    readonly dependency_free_cdp: boolean;
    readonly new_browser_dependency_added: false;
    readonly chrome_resolution: string;
  };
  readonly hermetic: {
    readonly live_usda_required: false;
    readonly provider_key_required: false;
    readonly provider_call_in_deterministic_path: number;
    readonly ai_action_invoked: false;
    readonly secrets_required: false;
  };
  readonly observations: ReadonlyArray<Phase8bObservation>;
  readonly gates: ReadonlyArray<Phase8bGate>;
  readonly totals: { readonly proven: number; readonly refuted: number; readonly not_proven: number };
  /**
   * Always `pending` here. A local run is NOT durable CI evidence; the gate
   * upgrade becomes eligible only after the pushed commit's GitHub Actions run
   * succeeds. Encoding that as a literal is deliberate so no local run can
   * self-promote a CI-dependent gate.
   */
  readonly durable_ci_required: true;
  readonly local_browser_proof: 'pass' | 'fail';
  readonly post_push_ci_proof: 'pending';
}

const REQUIRED_BROWSER_AUTOMATION: EvidenceLevel = 'browser_automation';
const REQUIRED_PRODUCTION_BUILD: EvidenceLevel = 'production_build';

function entitledObservation(observations: ReadonlyArray<Phase8bObservation>): Phase8bObservation | undefined {
  return observations.find((o) => o.tier === 'ai_advanced');
}
function basicObservation(observations: ReadonlyArray<Phase8bObservation>): Phase8bObservation | undefined {
  return observations.find((o) => o.tier === 'basic');
}

/**
 * Derive the Phase 8B gate set from browser observations.
 *
 * A gate is `PROVEN` only when the exact observation it names is present.
 * A required observation that was made and came back WRONG is `REFUTED`
 * (a hard failure, not merely unproven). A gate with nothing to judge is
 * `NOT_PROVEN`.
 */
export function derivePhase8bGates(observations: ReadonlyArray<Phase8bObservation>): Phase8bGate[] {
  const entitled = entitledObservation(observations);
  const basic = basicObservation(observations);
  const gates: Phase8bGate[] = [];

  const push = (
    gate: string,
    status: GateStatus,
    evidence_level: EvidenceLevel,
    required_evidence_level: EvidenceLevel,
    detail: string
  ): void => {
    gates.push({ gate, status, evidence_level, required_evidence_level, detail });
  };

  // --- production_build_clean ---------------------------------------------
  const builtAndProduction =
    entitled !== undefined && entitled.productionServer && entitled.builtApp;
  push(
    'production_build_clean',
    builtAndProduction ? 'PROVEN' : entitled ? 'REFUTED' : 'NOT_PROVEN',
    builtAndProduction ? REQUIRED_PRODUCTION_BUILD : 'none',
    REQUIRED_PRODUCTION_BUILD,
    builtAndProduction
      ? 'the browser proof consumed dist/server.cjs with the production CSP and content-hashed built assets'
      : 'no built-production observation was recorded'
  );

  // --- production_browser_reachable ---------------------------------------
  // Reachable requires: real built app + USDA artifacts fetched same-origin +
  // authentication completed + a genuine session became available + review
  // rows projected.
  const bundleOk =
    entitled !== undefined &&
    entitled.bundle.authenticated &&
    entitled.bundle.genuineSession &&
    entitled.bundle.allSameOrigin &&
    entitled.bundle.allSucceeded &&
    entitled.bundle.artifactsRequested.length > 0;
  const reviewOk = entitled !== undefined && entitled.review !== null && entitled.review.total > 0;
  const reachable = bundleOk && reviewOk;
  const bundleRefuted =
    entitled !== undefined &&
    (entitled.bundle.liveUsdaRequests > 0 ||
      entitled.runtime.liveUsdaRequests > 0 ||
      entitled.runtime.providerRequests > 0 ||
      (entitled.bundle.artifactsRequested.length > 0 && !entitled.bundle.allSameOrigin) ||
      (entitled.bundle.authenticated && !entitled.bundle.genuineSession));
  push(
    'production_browser_reachable',
    bundleRefuted ? 'REFUTED' : reachable ? 'PROVEN' : 'NOT_PROVEN',
    reachable ? REQUIRED_BROWSER_AUTOMATION : 'none',
    REQUIRED_BROWSER_AUTOMATION,
    bundleRefuted
      ? 'a required USDA production-browser observation was made and failed'
      : reachable
        ? `real browser reached a genuine authenticated session with ${entitled?.bundle.artifactsRequested.length} same-origin USDA artifacts and ${entitled?.review?.total} live review rows`
        : 'no authenticated USDA session was observed in a real browser'
  );

  // --- recipe_level_smoke_sufficient --------------------------------------
  // Requires a full recipe (not lines) measured end to end with calculation,
  // nutrient totals, truthful partial reporting, and Apply eligibility.
  const calcOk =
    entitled !== undefined &&
    entitled.calculation !== null &&
    entitled.calculation.previewRendered &&
    entitled.calculation.nutrientTotalsPresent &&
    entitled.calculation.partialReportedTruthfully &&
    entitled.calculation.applyEligible;
  const recipeOk = entitled !== undefined && entitled.recipe !== null && entitled.recipe.ingredientCount > 0 && reviewOk;
  const recipeLevel = recipeOk && calcOk;
  push(
    'recipe_level_smoke_sufficient',
    recipeLevel ? 'PROVEN' : entitled?.calculation ? 'REFUTED' : 'NOT_PROVEN',
    recipeLevel ? REQUIRED_BROWSER_AUTOMATION : 'none',
    REQUIRED_BROWSER_AUTOMATION,
    recipeLevel
      ? `full-recipe browser smoke: ${entitled?.recipe?.ingredientCount} ingredients, ${entitled?.review?.matched} matched, ${entitled?.review?.needsAmount} needing amount, calculation with nutrient totals and truthful partial coverage`
      : 'no full-recipe calculation was measured in a real browser'
  );

  // --- accessibility_smoke_sufficient -------------------------------------
  const a11y = entitled?.accessibility ?? null;
  const a11yOk =
    a11y !== null &&
    a11y.performed &&
    a11y.keyboardContained &&
    a11y.escapeClosed &&
    a11y.focusRestored &&
    a11y.allControlsNamed &&
    a11y.dialogNamed;
  push(
    'accessibility_smoke_sufficient',
    a11yOk ? 'PROVEN' : a11y ? 'REFUTED' : 'NOT_PROVEN',
    a11yOk ? REQUIRED_BROWSER_AUTOMATION : 'none',
    REQUIRED_BROWSER_AUTOMATION,
    a11yOk
      ? 'dialog semantics, initial focus, keyboard containment, Escape close, focus restoration and accessible names all observed in a real browser'
      : 'no accessibility smoke was observed in a real browser'
  );

  // --- entitlement_enforced (AND, never OR) -------------------------------
  // Both arms must be observed: entitled-but-not-ready must NOT be usable, and
  // basic must NOT be usable. Readiness alone must never unlock AI.
  const entitledArm =
    entitled !== undefined && entitled.entitlement.expectedReason === 'provider_unavailable' && entitled.entitlement.aiActionsDisabled;
  const basicArm =
    basic !== undefined && basic.entitlement.expectedReason === 'product_not_enabled' && basic.entitlement.aiActionsDisabled;
  // A BREACH is distinct from a gap: if an arm was observed and the gate was
  // open anyway, entitlement was bypassed, which refutes rather than leaves open.
  const entitlementBreached =
    (entitled !== undefined && entitled.entitlement.aiPanelRendered && entitled.entitlement.aiActionsDisabled === false) ||
    (basic !== undefined && basic.entitlement.aiPanelRendered && basic.entitlement.aiActionsDisabled === false);
  const andOk = entitledArm && basicArm;
  push(
    'entitlement_enforced',
    entitlementBreached ? 'REFUTED' : andOk ? 'PROVEN' : 'NOT_PROVEN',
    andOk ? REQUIRED_BROWSER_AUTOMATION : 'none',
    REQUIRED_BROWSER_AUTOMATION,
    entitlementBreached
      ? 'an AI Advanced action was reachable while the tier did not entitle it (entitlement bypass observed)'
      : andOk
        ? 'PRODUCT ENTITLED AND OPERATIONALLY READY proven in a real browser: entitled-but-unready and basic both unusable'
        : 'both entitlement arms were not observed'
  );

  // --- no_external_usda_dependency ----------------------------------------
  const live = observations.reduce((sum, o) => sum + o.runtime.liveUsdaRequests, 0);
  push(
    'no_external_usda_dependency',
    observations.length === 0 ? 'NOT_PROVEN' : live === 0 ? 'PROVEN' : 'REFUTED',
    observations.length > 0 ? REQUIRED_BROWSER_AUTOMATION : 'none',
    REQUIRED_BROWSER_AUTOMATION,
    live === 0 ? 'zero live USDA requests across every browser run' : `observed ${live} live USDA requests`
  );

  // --- provider isolation on the deterministic path -----------------------
  const provider = observations.reduce((sum, o) => sum + o.runtime.providerRequests, 0);
  push(
    'no_provider_call_in_deterministic_path',
    observations.length === 0 ? 'NOT_PROVEN' : provider === 0 ? 'PROVEN' : 'REFUTED',
    observations.length > 0 ? REQUIRED_BROWSER_AUTOMATION : 'none',
    REQUIRED_BROWSER_AUTOMATION,
    provider === 0 ? 'zero provider requests; no AI action was invoked' : `observed ${provider} provider requests`
  );

  // --- runtime cleanliness ------------------------------------------------
  const consoleErrors = observations.reduce((s, o) => s + o.runtime.consoleErrors, 0);
  const exceptions = observations.reduce((s, o) => s + o.runtime.exceptions, 0);
  const external = observations.reduce((s, o) => s + o.runtime.unexpectedExternalRequests, 0);
  push(
    'production_runtime_clean',
    observations.length === 0 ? 'NOT_PROVEN' : consoleErrors + exceptions + external === 0 ? 'PROVEN' : 'REFUTED',
    observations.length > 0 ? REQUIRED_BROWSER_AUTOMATION : 'none',
    REQUIRED_BROWSER_AUTOMATION,
    consoleErrors + exceptions + external === 0
      ? 'zero console errors, zero uncaught exceptions, zero off-origin requests'
      : `console=${consoleErrors} exceptions=${exceptions} external=${external}`
  );

  // --- apply_authority_revalidated ----------------------------------------
  // Persistence must re-prove authority: the persisted digest must equal the
  // reviewed preview digest. Requires a real write through production.
  const applyOk =
    entitled !== undefined &&
    entitled.apply.attempted &&
    entitled.apply.succeeded &&
    entitled.apply.downloadObserved &&
    entitled.apply.persistedBlock !== null &&
    entitled.apply.persistedBlock.hasBlock &&
    entitled.apply.persistedDigestMatchesPreview;
  push(
    'apply_authority_revalidated',
    applyOk ? 'PROVEN' : entitled?.apply.attempted ? 'REFUTED' : 'NOT_PROVEN',
    applyOk ? REQUIRED_BROWSER_AUTOMATION : 'none',
    REQUIRED_BROWSER_AUTOMATION,
    applyOk
      ? 'Apply re-proved current authority in a real browser; persisted ingredient digest equals the reviewed preview digest'
      : entitled?.apply.attempted
        ? 'Apply was attempted but the persisted authority binding was not proven'
        : 'Apply was not reached in the browser proof'
  );

  // --- manual_smoke_required ----------------------------------------------
  // Automation reduces but never becomes a human action.
  push(
    'manual_smoke_required',
    'NOT_PROVEN',
    REQUIRED_BROWSER_AUTOMATION,
    REQUIRED_BROWSER_AUTOMATION,
    'a human manual smoke is still required; automation reduces scope but is not a human action'
  );

  return gates;
}

export function buildPhase8bProof(input: {
  readonly baseCommit: string;
  readonly observations: ReadonlyArray<Phase8bObservation>;
}): Phase8bProof {
  const gates = derivePhase8bGates(input.observations);
  const proven = gates.filter((g) => g.status === 'PROVEN').length;
  const refuted = gates.filter((g) => g.status === 'REFUTED').length;
  const providerCalls = input.observations.reduce((s, o) => s + o.runtime.providerRequests, 0);
  return {
    schema: PHASE8B_SCHEMA,
    base_commit: input.baseCommit,
    browser: {
      real_browser: true,
      dependency_free_cdp: true,
      new_browser_dependency_added: false,
      chrome_resolution: 'CHROME_BIN when set, else runtime-probed well-known Chrome/Chromium paths; hard failure when unresolved',
    },
    hermetic: {
      live_usda_required: false,
      provider_key_required: false,
      provider_call_in_deterministic_path: providerCalls,
      ai_action_invoked: false,
      secrets_required: false,
    },
    observations: input.observations,
    gates,
    totals: { proven, refuted, not_proven: gates.length - proven - refuted },
    durable_ci_required: true,
    local_browser_proof: refuted === 0 && proven > 0 ? 'pass' : 'fail',
    post_push_ci_proof: 'pending',
  };
}

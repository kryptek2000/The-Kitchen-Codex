/** Fixed public messages only: never echo provider text or recipe payloads. */
export function shisoNutritionFailureMessage(code?: string, reason?: string): string {
  if (code === 'unavailable') return 'The selected text AI connection is unavailable. Check its model and credential in AI Settings.';
  const messages: Record<string, string> = {
    output_truncated: 'The selected model stopped before finishing the nutrition response. No incomplete JSON was accepted.',
    empty_response: 'The selected model returned no nutrition content.',
    response_shape: 'The selected model did not return the required ingredient contributions.',
    invalid_nutrients: 'The nutrition response contained malformed or duplicate nutrient entries.',
    known_and_unknown_overlap: 'The response marked the same nutrient both known and unknown.',
    malformed_json: 'The selected model returned malformed nutrition JSON.',
    schema_mismatch: 'The selected model returned nutrition data outside the supported response schema.',
    INVALID_RESPONSE: 'The selected model returned an invalid structured nutrition response.',
    invalid_nutrient_value: 'The nutrition response contained an invalid amount or nutrient unit.',
    stale_or_duplicate_line: 'The nutrition response contained an invalid ingredient reference.',
    missing_line_ref: 'A nutrition contribution was missing its recipe-line reference. No estimate was accepted.',
    unknown_line_ref: 'A nutrition contribution referred to a line outside the current recipe. No estimate was accepted.',
    duplicate_line_ref: 'The nutrition response repeated an ingredient line. No duplicate contribution was accepted.',
    line_text_mismatch: 'A nutrition contribution did not match the exact ingredient text in the current recipe. No estimate was accepted.',
    provider_error: 'The selected AI provider could not complete nutrition interpretation. Check the connection and try again when ready.',
    UNAVAILABLE: 'The selected AI provider is temporarily unavailable.',
    PROVIDER_ERROR: 'The selected AI provider returned an unexpected error.',
    invalid_weight: 'The nutrition response contained an invalid edible weight.',
    invalid_disposition: 'The selected model omitted whether an ingredient is eaten or explicitly excluded. No nutrition was accepted.',
    invalid_exclusion_role: 'The nutrition response used an unsupported non-edible role. The ingredient remains unresolved.',
    invalid_exclusion_assumption: 'The nutrition response did not provide a valid exclusion assumption. The ingredient remains unresolved.',
    invalid_zero_weight: 'A zero edible weight needs an explicit exclusion assumption and zero nutrient contribution.',
    unsupported_exclusion: 'The recipe does not support treating that line as an unconsumed cooking wrapper. It remains unresolved.',
    unsupported_source_claim: 'The model claimed source evidence that this analysis did not retrieve.',
    AUTH: 'The AI provider rejected its credential. Check AI Settings.',
    QUOTA: 'The AI provider quota is exhausted.',
    RATE_LIMIT: 'The AI provider rate limit was reached.',
    TIMEOUT: 'The AI nutrition request timed out.',
    NETWORK: 'The AI provider could not be reached.',
    UNSUPPORTED_CAPABILITY: 'The selected model does not support the required structured nutrition response.',
  };
  return `${messages[reason ?? ''] ?? 'SHISO could not validate the nutrition response.'} Existing review results are unchanged. No automatic retry was made.`;
}

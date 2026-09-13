/** Non-secret transport choice. Client metadata never grants verification. */
export const STRICT_JSON_SCHEMA_PROFILE = 'strict_json_schema_v1';
export const APPLICATION_VALIDATED_JSON_PROFILE = 'application_validated_json_v1';
export type OpenRouterProfile = typeof STRICT_JSON_SCHEMA_PROFILE | typeof APPLICATION_VALIDATED_JSON_PROFILE;
export function isOpenRouterProfile(value: unknown): value is OpenRouterProfile {
  return value === STRICT_JSON_SCHEMA_PROFILE || value === APPLICATION_VALIDATED_JSON_PROFILE;
}
export function openRouterProfileLabel(profile: OpenRouterProfile): string {
  return profile === APPLICATION_VALIDATED_JSON_PROFILE
    ? 'Application-validated JSON'
    : 'Strict schema request · application checked';
}

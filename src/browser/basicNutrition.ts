import { loadProductionAdvancedNutritionSession } from './advancedNutritionBundle';
import { calculateBasicNutrition, type BasicNutritionInput } from '../application/basicNutrition';
import type { RuntimeBundleResult } from './advancedNutritionBundle';
let pending: Promise<RuntimeBundleResult> | undefined;
/** Explicit button-only load of bundled assets; no AI, external API, or write. */
export async function calculateProductionBasicNutrition(input: BasicNutritionInput) {
  pending ??= loadProductionAdvancedNutritionSession();
  const result = await pending;
  if (!result.ok) {
    pending = undefined;
    throw new Error('Basic Nutrition could not authenticate its local USDA data. Try again.');
  }
  return calculateBasicNutrition(input, result.session);
}

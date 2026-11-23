/**
 * SINC-2 TEST FIXTURES — SYNTHETIC, NOT REAL USDA PRODUCTS.
 *
 * These shapes intentionally mirror the documented FoodData Central Branded API
 * fields, but every brand, product, UPC, nutrient value and FDC id here is
 * invented for deterministic regression testing. They must never be presented
 * as real manufacturer data or as live USDA verification.
 */

export const MOCK_BRANDED_GOCHUJANG_FDC_ID = 990001;
export const MOCK_BRANDED_GOCHUJANG_SAUCE_FDC_ID = 990002;
export const MOCK_BRANDED_RICE_VINEGAR_FDC_ID = 990003;
export const MOCK_FOUNDATION_DECOY_FDC_ID = 990099;

export function mockBrandedSearchResponse(): Record<string, unknown> {
  return {
    foodSearchCriteria: {
      query: 'gochujang',
      dataType: ['Branded'],
      pageSize: 10,
      pageNumber: 1,
    },
    totalHits: 3,
    currentPage: 1,
    totalPages: 1,
    foods: [
      {
        fdcId: MOCK_BRANDED_GOCHUJANG_FDC_ID,
        description: 'SINC2 MOCK GOCHUJANG SAUCE',
        dataType: 'Branded',
        brandOwner: 'Mock Foods',
        gtinUpc: '012345678901',
        publicationDate: '1/1/2026',
        score: 100,
      },
      {
        fdcId: MOCK_BRANDED_GOCHUJANG_SAUCE_FDC_ID,
        description: 'SINC2 MOCK GOCHUJANG CHIPS',
        dataType: 'Branded',
        brandOwner: 'Mock Snacks',
        gtinUpc: '012345678902',
        publicationDate: '1/1/2026',
        score: 90,
      },
      {
        // A non-branded result must be ignored even if the API search filter
        // were ever misconfigured.
        fdcId: MOCK_FOUNDATION_DECOY_FDC_ID,
        description: 'SINC2 MOCK GOCHUJANG FOUNDATION DECOY',
        dataType: 'Foundation',
        publicationDate: '1/1/2026',
        score: 80,
      },
    ],
  };
}

export function mockBrandedDetail(fdcId: number): Record<string, unknown> {
  const common = {
    dataType: 'Branded',
    brandOwner: 'Mock Foods',
    publicationDate: '1/1/2026',
    modifiedDate: '1/2/2026',
    householdServingFullText: '2 tbsp',
  };
  if (fdcId === MOCK_BRANDED_GOCHUJANG_FDC_ID) {
    return {
      ...common,
      fdcId,
      description: 'SINC2 MOCK GOCHUJANG SAUCE',
      gtinUpc: '012345678901',
      servingSize: 30,
      servingSizeUnit: 'g',
      labelNutrients: {
        calories: { value: 60 },
        protein: { value: 1 },
        fat: { value: 0.5 },
        carbohydrates: { value: 13 },
        fiber: { value: 1 },
        sugars: { value: 9 },
        sodium: { value: 480 },
        potassium: { value: 120 },
        calcium: { value: 20 },
        iron: { value: 0.6 },
      },
      foodNutrients: [
        { nutrient: { id: 1008, unitName: 'kcal' }, amount: 200 },
        { nutrient: { id: 1003, unitName: 'g' }, amount: 3.33 },
        { nutrient: { id: 1004, unitName: 'g' }, amount: 1.67 },
        { nutrient: { id: 1005, unitName: 'g' }, amount: 43.33 },
        { nutrient: { id: 1079, unitName: 'g' }, amount: 3.33 },
        { nutrient: { id: 1093, unitName: 'mg' }, amount: 1600 },
      ],
    };
  }
  if (fdcId === MOCK_BRANDED_GOCHUJANG_SAUCE_FDC_ID) {
    return {
      ...common,
      fdcId,
      description: 'SINC2 MOCK GOCHUJANG CHIPS',
      gtinUpc: '012345678902',
      servingSize: 28,
      servingSizeUnit: 'g',
      labelNutrients: {
        calories: { value: 150 },
        protein: { value: 2 },
        fat: { value: 8 },
        carbohydrates: { value: 17 },
        sodium: { value: 210 },
      },
    };
  }
  if (fdcId === MOCK_BRANDED_RICE_VINEGAR_FDC_ID) {
    return {
      ...common,
      fdcId,
      description: 'SINC2 MOCK RICE VINEGAR',
      brandOwner: 'Mock Pantry',
      gtinUpc: '012345678903',
      servingSize: 15,
      servingSizeUnit: 'ml',
      labelNutrients: {
        calories: { value: 0 },
        carbohydrates: { value: 1 },
        sodium: { value: 0 },
      },
    };
  }
  return {};
}

/** A record with no published serving weight or volume. */
export function mockBrandedNoServingDetail(fdcId = 990004): Record<string, unknown> {
  return {
    fdcId,
    dataType: 'Branded',
    description: 'SINC2 MOCK NO SERVING WEIGHT',
    brandOwner: 'Mock Foods',
    servingSizeUnit: 'serving',
    labelNutrients: { calories: { value: 100 } },
  };
}

/** A record with a conflicting duplicate non-energy nutrient. */
export function mockBrandedDuplicateNutrientDetail(fdcId = 990005): Record<string, unknown> {
  return {
    fdcId,
    dataType: 'Branded',
    description: 'SINC2 MOCK DUPLICATE NUTRIENT',
    brandOwner: 'Mock Foods',
    servingSize: 30,
    servingSizeUnit: 'g',
    labelNutrients: { calories: { value: 100 } },
    foodNutrients: [
      { nutrient: { id: 1008, unitName: 'kcal' }, amount: 300 },
      { nutrient: { id: 1003, unitName: 'g' }, amount: 1 },
      { nutrient: { id: 1003, unitName: 'g' }, amount: 2 },
    ],
  };
}

/** A record with an invalid negative nutrient value. */
export function mockBrandedInvalidNutrientDetail(fdcId = 990006): Record<string, unknown> {
  return {
    fdcId,
    dataType: 'Branded',
    description: 'SINC2 MOCK INVALID NUTRIENT',
    brandOwner: 'Mock Foods',
    servingSize: 30,
    servingSizeUnit: 'g',
    labelNutrients: { calories: { value: -1 } },
  };
}

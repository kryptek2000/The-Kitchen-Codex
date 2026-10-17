import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
// @vitest-environment jsdom
import React from 'react';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK as lock } from '../../src/core/nutritionV2/usda/releaseLock';
import { calculateBasicNutrition } from '../../src/application/basicNutrition';
import { RecipeEditorModal } from '../../src/components/RecipeEditorModal';
import { RecipeNutritionCard } from '../../src/components/RecipeNutritionCard';
import { RecipeDetailView } from '../../src/components/RecipeDetailView';
import { AdvancedNutritionSavedReport } from '../../src/components/AdvancedNutritionSavedReport';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import { isPartialMachineNutrition } from '../../src/utils/nutrition';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';

// jsdom uses a separate typed-array realm. Decode the exact locked gzip bytes
// through Node's platform adapter; authentication and all nutrition code stay real.
vi.mock('../../src/core/nutritionV2/runtime/gzip', async importOriginal => {
 const original=await importOriginal<typeof import('../../src/core/nutritionV2/runtime/gzip')>();
 const {gunzipSync}=await import('node:zlib');
 return {...original,decodeBoundedGzip:async(bytes:Uint8Array,maxBytes:number)=>{
  const decoded=gunzipSync(bytes);if(decoded.byteLength>maxBytes)throw new Error('bound exceeded');
  return new Uint8Array(decoded);
 }};
});
const bundle=vi.hoisted(()=>({session:null as unknown as AdvancedNutritionSession}));
// Replace byte acquisition only. Both buttons still run their real production
// service, USDA analyzer/calculator, and UI event handlers with AI unavailable.
vi.mock('../../src/browser/advancedNutritionBundle',()=>({loadProductionAdvancedNutritionSession:vi.fn(async()=>({ok:true,session:bundle.session}))}));
const network={request:vi.fn(async()=>{throw new Error('AI unavailable');}),post:vi.fn(),get:vi.fn()} as never;
const lines=['4 eggs, separated','6 tbsp unsalted butter','1 cup whole milk'];
const makeRecipe=()=>parseObsidianRecipeMarkdown(`---\ntitle: Ordinary eggs\nservings: 6\n---\n# Ordinary eggs\n## Ingredients\n${lines.map(l=>'- '+l).join('\n')}\n## Instructions\n1. Cook.`, 'eggs.md','Recipes/eggs.md');
beforeAll(async()=>{
 vi.spyOn(window, 'scrollTo').mockImplementation(()=>{});
 const result=await composeAdvancedNutritionSessionFromBundle({files:lock.artifact_filenames.map(name=>({name,bytes:new Uint8Array(readFileSync(join(__dirname,'../../data/advanced-nutrition/usda',lock.bundle_release,name)))}))});
 if(!result.ok)throw result;bundle.session=result.session;
},300000);
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('nutrition production UI integration',()=>{
 it('shows the estimate service failure instead of falsely claiming there are no eligible lines',async()=>{
  const estimate=vi.fn(async()=>({ok:true as const,offers:[],refused:[],message:'AI quantity estimation is not currently available.'}));
  const r=makeRecipe();r.ingredients.push({original:'1 cup Oaxaca cheese',name:'Oaxaca cheese',amount:1,unit:'cup'});
  render(<AdvancedNutritionCard recipe={r} session={bundle.session} onEstimateMassesWithAi={estimate} onResolveWithAi={vi.fn()} advancedNutritionAiAvailability={{available:true,reason:null}} />);
  fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
  fireEvent.click(await screen.findByText('Estimate remaining amounts with AI'));
  expect(await screen.findByText('AI quantity estimation is not currently available.')).toBeTruthy();
  expect(screen.queryByText('No lines are eligible for an AI estimate.')).toBeNull();
  expect(estimate).toHaveBeenCalledTimes(1);
 },30000);

 it('editor shows and persists partial subtotals only after explicit informed replacement',async()=>{
  const r=makeRecipe();r.ingredients=[{original:'3 mystery fruits',name:'mystery fruits'}, {original:'1 tsp salt',name:'salt'}];
  r.nutrition={calories:762,protein:21,servings:6};r.calories=127;
  const save=vi.fn();
  render(<RecipeEditorModal initialRecipe={r} network={network} onSave={save} onClose={()=>{}} />);
  expect((screen.getByPlaceholderText('e.g. 520') as HTMLInputElement).value).toBe('127');
  fireEvent.click(screen.getByText('Calculate Basic Nutrition'));
  await screen.findByTestId('editor-basic-partial',{}, {timeout:15000});
  expect(screen.getByTestId('editor-basic-partial').textContent).toMatch(/not full recipe totals/i);
  expect(screen.getByText('Calories (kcal) · subtotal')).toBeTruthy();
  expect(screen.getByText('Protein (g) · subtotal')).toBeTruthy();
  expect((screen.getByPlaceholderText('e.g. 520') as HTMLInputElement).value).not.toBe('127');
  expect(save).not.toHaveBeenCalled();
  expect(r.nutrition.calories).toBe(762);
  fireEvent.click(screen.getByText('Save Obsidian Note'));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(/I understand this will replace the existing complete nutrition/));
  fireEvent.click(screen.getByText('Save Obsidian Note'));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  const saved=save.mock.calls[0][0];
  expect(saved.nutrition.confidenceNote).toMatch(/PARTIAL/);
  expect(isPartialMachineNutrition(saved.nutrition)).toBe(true);
  const reopened=parseObsidianRecipeMarkdown(serializeRecipeToObsidianMarkdown(saved),saved.fileName,saved.filePath);
  expect(isPartialMachineNutrition(reopened.nutrition)).toBe(true);
 },30000);
 it('opens each recipe at the top without jumping during serving changes',()=>{
  const noop=()=>{};
  const props={network,onBack:noop,onStartCooking:noop,onEditRecipe:noop,onAddToMealPlan:noop,onAddToShoppingList:noop,onStartTimer:noop};
  const r=makeRecipe();const view=render(<RecipeDetailView {...props} recipe={r} />);
  expect(window.scrollTo).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTitle('Increase servings'));
  expect(window.scrollTo).toHaveBeenCalledTimes(1);
  view.rerender(<RecipeDetailView {...props} recipe={{...r,id:'another-recipe',servings:2}} />);
  expect(window.scrollTo).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Scaled from/)).toBeNull();
  expect(window.scrollTo).toHaveBeenLastCalledWith({top:0,left:0,behavior:'instant'});
 });

 it('6 → 8 → 6, explicit Save, real Markdown, reopen, ingredient scaling and Reset retain precise totals',async()=>{
  const initial=makeRecipe();
  const estimate=calculateBasicNutrition({ingredients:initial.ingredients,servings:6},bundle.session);
  expect(estimate.coverage.complete).toBe(true);
  const onSave=vi.fn();
  const editor=(r:ObsidianRecipe)=><RecipeEditorModal initialRecipe={r} network={network} onSave={onSave} onClose={()=>{}} />;
  let view=render(editor(initial));
  fireEvent.click(screen.getByText('Calculate Basic Nutrition'));
  const cal=screen.getByPlaceholderText('e.g. 520') as HTMLInputElement;
  await waitFor(()=>expect(Number(cal.value)).toBe(estimate.perServing.calories),{timeout:15000});
  const servings=screen.getByPlaceholderText('e.g. 4');
  fireEvent.change(servings,{target:{value:'8'}});
  await waitFor(()=>expect(Number(cal.value)).toBe(Math.round(estimate.totals.calories!/8)));
  fireEvent.change(servings,{target:{value:'6'}});
  await waitFor(()=>expect(Number(cal.value)).toBe(estimate.perServing.calories));
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Save Obsidian Note'));
  await waitFor(()=>expect(onSave).toHaveBeenCalledTimes(1));
  const saved=onSave.mock.calls[0][0] as ObsidianRecipe;
  expect(saved.nutrition?.calories).toBe(estimate.totals.calories);
  expect(saved.nutrition?.protein).toBe(estimate.totals.protein);
  const markdown=serializeRecipeToObsidianMarkdown(saved);
  const reopened=parseObsidianRecipeMarkdown(markdown,saved.fileName,saved.filePath);
  expect(reopened.nutrition?.calories).toBe(estimate.totals.calories);
  view.unmount();view=render(editor(reopened));
  expect(Number((screen.getByPlaceholderText('e.g. 520') as HTMLInputElement).value)).toBe(estimate.perServing.calories);
  fireEvent.change(screen.getByPlaceholderText('e.g. 4'),{target:{value:'8'}});
  fireEvent.click(screen.getByText('Save Obsidian Note'));
  await waitFor(()=>expect(onSave).toHaveBeenCalledTimes(2));
  expect(onSave.mock.calls[1][0].nutrition.servings).toBe(8);
  expect(onSave.mock.calls[1][0].nutrition.calories).toBe(estimate.totals.calories);
  view.unmount();
  const noop=()=>{};
  render(<RecipeDetailView recipe={reopened} network={network} onBack={noop} onStartCooking={noop} onEditRecipe={noop} onAddToMealPlan={noop} onAddToShoppingList={noop} onStartTimer={noop} onUpdateNutrition={noop} />);
  fireEvent.click(screen.getByTitle('Increase servings'));
  fireEvent.click(screen.getByTitle('Increase servings'));
  expect(screen.getByText('Scaled from 6 to 8 servings')).toBeTruthy();
  expect(screen.getByText(/5 1\/3 eggs, separated/)).toBeTruthy();
  expect(screen.getAllByText(String(Math.round(estimate.totals.calories!*8/6))).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText('Reset'));
  expect(screen.queryByText('Scaled from 6 to 8 servings')).toBeNull();
  expect(screen.getByText('4 eggs, separated')).toBeTruthy();
  expect(reopened.nutrition?.calories).toBe(estimate.totals.calories);
 },30000);
 it('preserves decimal legacy calories and manual edits as precise batch totals',async()=>{
  const r=makeRecipe();r.calories='374.8 kcal';r.nutrition=undefined;
  const save=vi.fn();
  const view=render(<RecipeEditorModal initialRecipe={r} network={network} onSave={save} onClose={()=>{}} />);
  fireEvent.click(screen.getByText('Save Obsidian Note'));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].nutrition.calories).toBeCloseTo(374.8*6,8);
  view.unmount();
  render(<RecipeEditorModal initialRecipe={r} network={network} onSave={save} onClose={()=>{}} />);
  fireEvent.change(screen.getByPlaceholderText('e.g. 520'),{target:{value:'123.45'}});
  fireEvent.click(screen.getByText('Save Obsidian Note'));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][0].nutrition.calories).toBeCloseTo(123.45*6,8);
 });
 it('main Basic button uses the same totals and only saves after the explicit second click',async()=>{
  const initial=makeRecipe();const save=vi.fn(async (_nutrition: unknown)=>true);
  const expected=calculateBasicNutrition({ingredients:initial.ingredients,servings:6},bundle.session);
  render(<RecipeNutritionCard recipe={initial} network={network} onUpdateNutrition={save} />);
  fireEvent.click(screen.getByTestId('calculate-basic-nutrition-empty-btn'));
  await screen.findByTestId('basic-nutrition-review',{}, {timeout:15000});
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('save-nutrition-btn'));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0]).toMatchObject({calories:expected.totals.calories,protein:expected.totals.protein,servings:6});
  expect((network as any).request).not.toHaveBeenCalled();
 },30000);
 it('shows partial known subtotals and saves them with an explicit partial marker',async()=>{
  const r=makeRecipe();r.ingredients=[{original:'3 mystery fruits',name:'mystery fruits'},{original:'1 tsp salt',name:'salt'}];
  const save=vi.fn();
  const view=render(<RecipeNutritionCard recipe={r} network={network} onUpdateNutrition={save} />);
  fireEvent.click(screen.getByTestId('calculate-basic-nutrition-empty-btn'));
  await screen.findByTestId('basic-nutrition-partial',{}, {timeout:15000});
  expect((screen.getByTestId('save-nutrition-btn') as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByTestId('basic-nutrition-review').textContent).toMatch(/subtotal/i);
  expect(screen.getByTestId('basic-nutrition-review').textContent).toMatch(/full recipe totals are unknown/i);
  expect(save).not.toHaveBeenCalled();view.unmount();
  const retry = render(<RecipeNutritionCard recipe={r} network={network} onUpdateNutrition={save} />);
  fireEvent.click(screen.getByTestId('calculate-basic-nutrition-empty-btn'));
  await screen.findByTestId('basic-nutrition-partial',{}, {timeout:15000});
  fireEvent.click(screen.getByTestId('save-nutrition-btn'));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].confidenceNote).toMatch(/PARTIAL/);
  expect(isPartialMachineNutrition(save.mock.calls[0][0])).toBe(true);
  retry.unmount();
  const markdown=serializeRecipeToObsidianMarkdown({...r,nutrition:save.mock.calls[0][0]});
  const reopened=parseObsidianRecipeMarkdown(markdown,r.fileName,r.filePath);
  expect(isPartialMachineNutrition(reopened.nutrition)).toBe(true);
  expect(reopened.nutrition?.calories).toBe(0); // Genuine salt-record zero remains a partial subtotal.
  r.nutrition=reopened.nutrition;
  render(<RecipeNutritionCard recipe={r} network={network} onUpdateNutrition={save} />);
  expect(screen.getByTestId('saved-basic-partial')).toBeTruthy();
  expect(screen.getByText('Calories · subtotal')).toBeTruthy();
  expect(screen.getByText(/^0$/)).toBeTruthy();
 },30000);
});

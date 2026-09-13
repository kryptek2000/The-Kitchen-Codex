/**
 * The Kitchen Codex — free-first model picker (v0.8.0).
 *
 * A compact, dependency-free searchable model selector used for OpenRouter text
 * and image surfaces. It is a pure presentational component over the normalized
 * server catalog; it NEVER fetches, never spends, and never persists anything.
 *
 * UX:
 *   - Trigger shows the current model + a concise price/cost label.
 *   - Panel: local search (display name / model id), Free / Budget / All tabs,
 *     free-first grouping, compact capability badges.
 *   - Image surfaces truthfully show "No free image models currently available."
 *     when the live catalog proves no free image model.
 */

import React, { useMemo, useState } from 'react';
import { STRICT_JSON_SCHEMA_PROFILE, APPLICATION_VALIDATED_JSON_PROFILE, type OpenRouterProfile } from '../core/ai/openRouterProfile';
import {
  countFreeModels,
  formatImageModelPrice,
  formatModelPrice,
  freeVerificationLabel,
  modelBadges,
  modelCostClass,
  pickerModels,
  probeFailureMessage,
  type ModelPickerGroup,
  type ModelVerificationView,
  type SurfaceModelOption,
} from './modelPicker';

const GROUP_LABELS: { key: ModelPickerGroup; label: string }[] = [
  { key: 'free', label: 'Free' },
  { key: 'budget', label: 'Budget' },
  { key: 'all', label: 'All compatible' },
];

export interface ModelPickerProps {
  kind: 'text' | 'image';
  models: SurfaceModelOption[];
  /** Discovered but NON-selectable models (informational only; never executable). */
  discoveredModels?: SurfaceModelOption[];
  value?: string;
  onChange: (modelId: string | undefined) => void;
  /** Test/SSR affordance: render the panel expanded. */
  defaultOpen?: boolean;
  /**
   * Explicit capability-verification state per model id (text surface only).
   * Never persisted; supplied by the parent so the panel stays presentational.
   */
  verifications?: Record<string, ModelVerificationView>;
  /**
   * Explicit "Verify for Kitchen Codex" action for a discovered FREE text model.
   * NEVER invoked automatically — only from the user's click.
   */
  onVerifyModel?: (modelId: string, profile?: OpenRouterProfile) => void;
}

/** Finds a model row by id. */
function findModel(models: SurfaceModelOption[], id: string | undefined): SurfaceModelOption | undefined {
  if (!id) return undefined;
  return models.find((m) => m.id === id);
}

export function ModelPicker({ kind, models, discoveredModels = [], value, onChange, defaultOpen = false, verifications = {}, onVerifyModel }: ModelPickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<ModelPickerGroup>('free');

  const selected = findModel(models, value);
  const freeCount = useMemo(() => countFreeModels(models), [models]);
  const visible = useMemo(() => pickerModels(models, { query, group }), [models, query, group]);
  const discovered = useMemo(
    () => (kind === 'text' ? pickerModels(discoveredModels, { query, group: 'all' }).slice(0, 100) : []),
    [discoveredModels, query, kind]
  );
  const selectedLabel = selected?.displayName || selected?.id || 'Provider default';
  const priceLabel = (m: SurfaceModelOption) =>
    kind === 'image' ? formatImageModelPrice(m) : formatModelPrice(m);

  return (
    <div className="space-y-1" data-model-picker={kind}>
      <button
        type="button"
        data-surface-model-select={kind}
        data-model-picker-trigger={kind}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-gray-200 hover:bg-white/10"
      >
        <span className="truncate text-left">
          {selectedLabel}
          {selected ? <span className="text-gray-500"> · {priceLabel(selected)}</span> : null}
        </span>
        <span aria-hidden="true" className="text-gray-500">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div
          data-model-picker-panel={kind}
          className="border border-white/10 rounded-xl bg-[#141414] p-2 space-y-2"
        >
          <input
            type="text"
            data-model-picker-search={kind}
            placeholder="Search by name or model ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-gray-200"
          />

          <div className="flex flex-wrap gap-1.5">
            {GROUP_LABELS.map((g) => (
              <button
                key={g.key}
                type="button"
                data-model-picker-group={`${kind}:${g.key}`}
                aria-pressed={group === g.key}
                onClick={() => setGroup(g.key)}
                className={`px-2 py-0.5 rounded-md text-[11px] border transition-colors ${
                  group === g.key
                    ? 'bg-white/15 text-white border-white/20'
                    : 'bg-white/5 text-gray-400 border-white/10 hover:text-gray-200'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>

          {group === 'free' && freeCount === 0 && (
            <div data-model-picker-empty={kind} className="text-[11px] text-gray-400 px-1 py-2">
              {kind === 'image'
                ? 'No free image-generation models currently available.'
                : 'No free models currently available.'}
            </div>
          )}

          <button
            type="button"
            data-model-picker-default={kind}
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
            className="w-full text-left px-2 py-1.5 rounded-lg text-[12px] text-gray-300 hover:bg-white/5"
          >
            Provider default
          </button>

          <ul className="max-h-64 overflow-y-auto space-y-0.5">
            {visible.map((model) => {
              const badges = modelBadges(model);
              const isSelected = model.id === value;
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    data-model-option={model.id}
                    aria-current={isSelected}
                    onClick={() => {
                      onChange(model.id);
                      setOpen(false);
                    }}
                    className={`w-full text-left px-2 py-1.5 rounded-lg hover:bg-white/5 ${
                      isSelected ? 'bg-white/10' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] text-gray-100 truncate">
                        {model.displayName || model.id}
                      </span>
                      <span className="text-[11px] text-gray-400 shrink-0">
                        {priceLabel(model)}
                      </span>
                    </div>
                    <div className="text-[10px] text-gray-500 font-mono truncate">{model.id}</div>
                    {badges.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {badges.map((badge) => (
                          <span
                            key={badge}
                            className={`px-1.5 py-0.5 rounded text-[9px] border ${
                              badge === 'FREE'
                                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                                : 'bg-white/5 text-gray-400 border-white/10'
                            }`}
                          >
                            {badge}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
            {visible.length === 0 && group !== 'free' && (
              <li className="text-[11px] text-gray-500 px-2 py-2">No models match.</li>
            )}
          </ul>

          {discovered.length > 0 && (
            <div data-model-picker-discovered={kind} className="pt-1 border-t border-white/5">
              <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold px-1 py-1">
                Discovered — not supported by the current Kitchen Codex runtime
              </div>
              <ul className="max-h-40 overflow-y-auto space-y-0.5">
                {discovered.map((model) => {
                  // A "Verify for Kitchen Codex" control is offered ONLY for FREE
                  // discovered text models the server marks as strict-structured
                  // CANDIDATES (verified free + ordinary text output + advertises
                  // response_format + structured_outputs). It is NEVER auto-run.
                  const isFreeText = kind === 'text' && modelCostClass(model) === 'free';
                  const eligible =
                    isFreeText && model.strictStructuredCandidate === true && Boolean(onVerifyModel);
                  const jsonEligible = isFreeText && model.jsonCandidate === true && Boolean(onVerifyModel);
                  const incompatible = isFreeText && model.strictStructuredCandidate !== true;
                  const verification = verifications[model.id];
                  const state = verification?.state ?? 'idle';
                  return (
                    <li
                      key={`discovered:${model.id}`}
                      data-model-option-discovered={model.id}
                      aria-disabled={!(eligible || jsonEligible)}
                      className="px-2 py-1.5 rounded-lg opacity-80"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] text-gray-300 truncate">
                          {model.displayName || model.id}
                        </span>
                        <span className="text-[11px] text-gray-500 shrink-0">
                          {priceLabel(model)}
                        </span>
                      </div>
                      <div className="text-[10px] text-gray-500 font-mono truncate">{model.id}</div>
                      {incompatible && (
                        <div
                          data-model-incompatible={model.id}
                          className="mt-1 text-[10px] text-amber-300/90"
                        >
                          Strict structured output is unsupported by this model.
                          {jsonEligible ? ' Application-validated JSON can be tested separately.' : ''}
                        </div>
                      )}
                      {eligible && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span
                            data-model-verification-state={model.id}
                            className={`text-[10px] ${
                              state === 'verified'
                                ? 'text-emerald-300'
                                : state === 'failed'
                                ? 'text-red-300'
                                : 'text-gray-400'
                            }`}
                          >
                            {freeVerificationLabel(model, verification)}
                          </span>
                          <button
                            type="button"
                            data-model-verify={model.id}
                            onClick={() => onVerifyModel?.(model.id, STRICT_JSON_SCHEMA_PROFILE)}
                            disabled={state === 'verifying'}
                            className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-white/10 text-gray-200 hover:bg-white/15 border border-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {state === 'verifying' ? 'Verifying…' : 'Verify for Kitchen Codex'}
                          </button>
                          <span className="text-[10px] text-gray-400">Strict schema request · one free probe · application checks every answer</span>
                        </div>
                      )}
                      {jsonEligible && (
                        <div className="mt-1 space-y-1">
                          <button type="button" data-model-verify-json={model.id}
                            disabled={state === 'verifying'}
                            onClick={() => onVerifyModel?.(model.id, APPLICATION_VALIDATED_JSON_PROFILE)}
                            className="px-2 py-1 rounded border border-white/10 text-[10px] disabled:opacity-40">
                            Verify application-validated JSON
                          </button>
                          <div className="text-[10px] text-gray-400">One free probe. JSON mode; Kitchen Codex validates the schema. No provider schema-enforcement claim.</div>
                        </div>
                      )}
                      {(eligible || jsonEligible) && state === 'failed' && (
                        <div
                          data-model-verification-error={model.id}
                          className="text-[10px] text-red-300/90 mt-0.5"
                        >
                          {verification?.classification
                            ? probeFailureMessage(verification.classification)
                            : verification?.message ?? ''}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ModelPicker;

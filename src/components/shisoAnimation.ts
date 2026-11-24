import type { ShisoAvatarState, ShisoAvatarVariant } from './ShisoAvatar';

export interface ShisoAvatarLifecycle {
  readonly busy: boolean;
  readonly hasToolStep: boolean;
  readonly hasError: boolean;
  readonly completed: boolean;
}

/**
 * Maps the existing SHISO request lifecycle to the presentational avatar state.
 * This is deliberately finite and data-driven: no timer can claim that SHISO
 * is thinking or using a tool when the conversation engine is idle.
 */
export function resolveShisoAvatarState(lifecycle: ShisoAvatarLifecycle): ShisoAvatarState {
  if (lifecycle.busy) return lifecycle.hasToolStep ? 'working' : 'thinking';
  if (lifecycle.completed) return 'success';
  if (lifecycle.hasError) return 'cancelled';
  return 'idle';
}

export function resolveShisoAvatarVariant(
  state: ShisoAvatarState,
  busy: boolean,
): ShisoAvatarVariant {
  if (busy) return 'thinking';
  if (state === 'cancelled') return 'gesture';
  return 'wave';
}

/**
 * SHISO-C1.7 S7 — the owner-approved rendered SHISO companion.
 *
 * The state contract remains presentational: callers still publish the real
 * engine state through `data-state`, while the artwork itself is the supplied
 * glossy visor-and-leaf SHISO character rather than a drawn substitute.
 */
import type { CSSProperties } from 'react';

export type ShisoAvatarState = 'idle' | 'thinking' | 'working' | 'success' | 'cancelled';
export type ShisoAvatarVariant = 'portrait' | 'thinking' | 'wave' | 'gesture';

export interface ShisoAvatarProps {
  readonly form?: 'full' | 'compact';
  readonly state?: ShisoAvatarState;
  /** Selects one of the supplied official SHISO artworks for a larger presentation. */
  readonly variant?: ShisoAvatarVariant;
  readonly className?: string;
  readonly label?: string;
  readonly style?: CSSProperties;
}

export function ShisoAvatar({
  form = 'full',
  state = 'idle',
  variant,
  className = '',
  label = 'SHISO, your kitchen companion',
  style,
}: ShisoAvatarProps) {
  const assetVariant: ShisoAvatarVariant = variant
    ?? (form === 'compact'
      ? 'portrait'
      : state === 'thinking' || state === 'working'
        ? 'thinking'
        : state === 'success'
          ? 'wave'
          : state === 'cancelled'
            ? 'gesture'
            : 'wave');
  const assetSrc = `/images/shiso-official-${assetVariant}.png`;

  return (
    <span
      className={`kc-shiso-avatar kc-shiso-avatar--${form} ${className}`.trim()}
      data-shiso-avatar={form}
      data-state={state}
      style={style}
      role="img"
      aria-label={label}
    >
      {/* Compatibility hooks for the existing state/animation contract. The
          supplied rendered companion is the visible artwork; these markers do
          not draw a second character or replace the image. */}
      <span className="kc-shiso-avatar-halo" aria-hidden="true" />
      <span className="kc-shiso-avatar-steam" aria-hidden="true" />
      <svg className="kc-shiso-avatar-art-marker" width="0" height="0" aria-hidden="true" focusable="false" />
      <span className="kc-shiso-avatar-art" aria-hidden="true">
        <img src={assetSrc} alt="" draggable="false" />
      </span>
    </span>
  );
}

export default ShisoAvatar;

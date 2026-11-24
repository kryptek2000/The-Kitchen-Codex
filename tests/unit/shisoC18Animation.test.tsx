// @vitest-environment jsdom
/** SHISO-C1.8 — state mapping, raster animation contract, and reduced motion. */
import { describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ShisoAvatar } from '../../src/components/ShisoAvatar';
import { resolveShisoAvatarState, resolveShisoAvatarVariant } from '../../src/components/shisoAnimation';

afterEach(() => cleanup());

describe('SHISO C1.8 lifecycle mapping', () => {
  it('keeps idle, thinking, working, success, and cancelled states distinct', () => {
    expect(resolveShisoAvatarState({ busy: false, hasToolStep: false, hasError: false, completed: false })).toBe('idle');
    expect(resolveShisoAvatarState({ busy: true, hasToolStep: false, hasError: false, completed: false })).toBe('thinking');
    expect(resolveShisoAvatarState({ busy: true, hasToolStep: true, hasError: false, completed: false })).toBe('working');
    expect(resolveShisoAvatarState({ busy: false, hasToolStep: false, hasError: false, completed: true })).toBe('success');
    expect(resolveShisoAvatarState({ busy: false, hasToolStep: false, hasError: true, completed: false })).toBe('cancelled');
    // A request in flight always wins over a stale terminal flag.
    expect(resolveShisoAvatarState({ busy: true, hasToolStep: true, hasError: true, completed: true })).toBe('working');
  });

  it('selects artwork by lifecycle without changing compact avatar identity', () => {
    expect(resolveShisoAvatarVariant('idle', false)).toBe('wave');
    expect(resolveShisoAvatarVariant('thinking', true)).toBe('thinking');
    expect(resolveShisoAvatarVariant('working', true)).toBe('thinking');
    expect(resolveShisoAvatarVariant('success', false)).toBe('wave');
    expect(resolveShisoAvatarVariant('cancelled', false)).toBe('gesture');

    const { container } = render(<ShisoAvatar form="compact" state="working" />);
    const avatar = container.querySelector('[data-shiso-avatar="compact"]');
    expect(avatar?.getAttribute('data-state')).toBe('working');
    expect(avatar?.querySelector('img')?.getAttribute('src')).toBe('/images/shiso-official-portrait.png');
    expect(avatar?.getAttribute('aria-label')).toMatch(/SHISO/);
  });
});

describe('SHISO C1.8 CSS motion contract', () => {
  it('animates supplied raster artwork selectively and disables nonessential motion', () => {
    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    const motionStart = css.indexOf('SHISO-C1.8 — living companion motion');
    const motion = css.slice(motionStart);

    expect(motion).toContain('.kc-shiso-avatar--full[data-state=\'idle\']');
    expect(motion).toContain('.kc-shiso-avatar--full[data-state=\'thinking\']');
    expect(motion).toContain('.kc-shiso-progress-avatar[data-state=\'working\']');
    expect(motion).toContain('@keyframes kc-shiso-success-lift');
    expect(motion).toContain('@keyframes kc-shiso-cancelled-settle');
    expect(motion).toContain('prefers-reduced-motion: reduce');
    expect(motion).toContain('.kc-shiso-avatar *');
    expect(motion).toContain('animation: none !important');

    // Compact navigation avatars do not receive the full-avatar idle loop.
    expect(motion).not.toContain('.kc-shiso-avatar--compact[data-state=\'idle\']');
  });
});

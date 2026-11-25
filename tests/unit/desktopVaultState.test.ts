/**
 * F1-B4 — accepted-selection persistence ordering.
 *
 * Persistence is a post-acceptance commit, state writes throw instead of being
 * swallowed, failure retains the previous restart authority, and Open Vault
 * Folder resolves only the current accepted real root.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

interface DesktopVaultState {
  readState(): Record<string, unknown>;
  writeState(next: Record<string, unknown>): void;
  loadPersistedVaultPath(): string | null;
  persistActiveVault(realRoot: string): string;
  getPersistedVaultPath(): string | null;
}

const vaultStateModule = require('../../desktop/vaultState.cjs') as {
  commitAcceptedVault(options: {
    requestedRoot: string;
    allowedRoots: Set<string>;
    state: DesktopVaultState;
  }): string;
  createDesktopVaultState(statePath: string, fsImpl?: typeof fs): DesktopVaultState;
  resolveOpenableVault(options: {
    activeVaultRoot: string | null;
    allowedRoots: Set<string>;
    fsImpl?: typeof fs;
  }): string;
};

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('F1-B4 — Vault selection persistence ordering', () => {
  it('persists only an accepted authorized candidate and reloads it', () => {
    const stateDirectory = temporaryDirectory('tkc-f1-state-');
    const statePath = path.join(stateDirectory, 'desktop-vault.json');
    const vaultA = temporaryDirectory('tkc-f1-vault-a-');
    const state = vaultStateModule.createDesktopVaultState(statePath);
    state.loadPersistedVaultPath();

    const allowedRoots = new Set([vaultA]);
    const committed = vaultStateModule.commitAcceptedVault({
      requestedRoot: vaultA,
      allowedRoots,
      state,
    });

    expect(committed).toBe(fs.realpathSync(vaultA));
    expect(state.getPersistedVaultPath()).toBe(fs.realpathSync(vaultA));
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).lastVaultPath).toBe(
      fs.realpathSync(vaultA)
    );

    const reloaded = vaultStateModule.createDesktopVaultState(statePath);
    expect(reloaded.loadPersistedVaultPath()).toBe(fs.realpathSync(vaultA));
  });

  it('throws on a state-write failure, cleans the temp file, and retains the previous authority', () => {
    const stateDirectory = temporaryDirectory('tkc-f1-state-fail-');
    const statePath = path.join(stateDirectory, 'desktop-vault.json');
    const vaultA = temporaryDirectory('tkc-f1-vault-a-fail-');
    const vaultB = temporaryDirectory('tkc-f1-vault-b-fail-');

    const initial = vaultStateModule.createDesktopVaultState(statePath);
    initial.persistActiveVault(fs.realpathSync(vaultA));

    const failingFs = Object.create(fs) as typeof fs;
    (failingFs as any).renameSync = () => {
      const error: any = new Error('simulated state rename failure');
      error.code = 'EACCES';
      throw error;
    };
    const failingState = vaultStateModule.createDesktopVaultState(statePath, failingFs);
    expect(failingState.loadPersistedVaultPath()).toBe(fs.realpathSync(vaultA));

    let thrown: any;
    try {
      vaultStateModule.commitAcceptedVault({
        requestedRoot: vaultB,
        allowedRoots: new Set([fs.realpathSync(vaultA), fs.realpathSync(vaultB)]),
        state: failingState,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('DESKTOP_STATE_WRITE_FAILED');
    expect(thrown.desktopVaultRoot).toBe(fs.realpathSync(vaultB));
    expect(failingState.getPersistedVaultPath()).toBe(fs.realpathSync(vaultA));
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).lastVaultPath).toBe(
      fs.realpathSync(vaultA)
    );
    expect(fs.readdirSync(stateDirectory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects an unauthorized candidate before writing any state', () => {
    const stateDirectory = temporaryDirectory('tkc-f1-state-unauth-');
    const statePath = path.join(stateDirectory, 'desktop-vault.json');
    const vaultA = temporaryDirectory('tkc-f1-vault-a-unauth-');
    const vaultB = temporaryDirectory('tkc-f1-vault-b-unauth-');
    const state = vaultStateModule.createDesktopVaultState(statePath);
    state.persistActiveVault(fs.realpathSync(vaultA));

    expect(() =>
      vaultStateModule.commitAcceptedVault({
        requestedRoot: vaultB,
        allowedRoots: new Set([fs.realpathSync(vaultA)]),
        state,
      })
    ).toThrow(/not authorized/i);

    expect(state.getPersistedVaultPath()).toBe(fs.realpathSync(vaultA));
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).lastVaultPath).toBe(
      fs.realpathSync(vaultA)
    );
  });

  it('opens only the current accepted real directory, never a substituted path', () => {
    const vaultA = temporaryDirectory('tkc-f1-vault-open-a-');
    const outside = temporaryDirectory('tkc-f1-vault-open-outside-');
    const realA = fs.realpathSync(vaultA);
    const allowedRoots = new Set([realA]);

    expect(
      vaultStateModule.resolveOpenableVault({ activeVaultRoot: realA, allowedRoots })
    ).toBe(realA);

    expect(() =>
      vaultStateModule.resolveOpenableVault({ activeVaultRoot: null, allowedRoots })
    ).toThrow(/no personal recipe vault/i);

    fs.renameSync(vaultA, `${vaultA}-moved`);
    temporaryDirectories.push(`${vaultA}-moved`);
    fs.symlinkSync(outside, vaultA);
    expect(() =>
      vaultStateModule.resolveOpenableVault({ activeVaultRoot: realA, allowedRoots })
    ).toThrow(/no longer the accepted directory/i);

    expect(() =>
      vaultStateModule.resolveOpenableVault({
        activeVaultRoot: outside,
        allowedRoots: new Set([realA]),
      })
    ).toThrow(/authorized/i);
  });
});

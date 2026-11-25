/**
 * The Kitchen Codex — Vault session id security tests (CodeQL js/insecure-randomness).
 *
 * createVaultSessionId() produces a security-sensitive opaque identity. These
 * tests pin the contract: Web Crypto only (randomUUID -> getRandomValues), and
 * fail closed (empty id) when secure randomness is unavailable. There must be
 * no Math.random() or timestamp fallback.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createVaultSessionId } from "../../src/application/recipeImageRecovery.js";
import { isValidVaultSessionId } from "../../src/core/recipeImage.js";

const FIXED_UUID = "3f1a9f0e-6d2b-4c7a-9e51-8b2c4d6f8a10";

function stubCrypto(value: unknown): void {
  vi.stubGlobal("crypto", value);
}

function zeroToFifteenBytes(array: Uint8Array): Uint8Array {
  for (let index = 0; index < array.length; index += 1) array[index] = index;
  return array;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createVaultSessionId", () => {
  it("prefers crypto.randomUUID() when available", () => {
    const randomUUID = vi.fn(() => FIXED_UUID);
    const getRandomValues = vi.fn((array: Uint8Array) => array);
    stubCrypto({ randomUUID, getRandomValues });

    expect(createVaultSessionId()).toBe(FIXED_UUID);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("falls back to crypto.getRandomValues() when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn(zeroToFifteenBytes);
    stubCrypto({ getRandomValues });

    const sessionId = createVaultSessionId();

    expect(getRandomValues).toHaveBeenCalledTimes(1);
    const passed = getRandomValues.mock.calls[0][0] as Uint8Array;
    expect(passed).toBeInstanceOf(Uint8Array);
    expect(passed).toHaveLength(16);
    expect(sessionId).toBe("session-000102030405060708090a0b0c0d0e0f");
    expect(isValidVaultSessionId(sessionId)).toBe(true);
  });

  it("falls back to getRandomValues() when randomUUID throws", () => {
    const randomUUID = vi.fn(() => {
      throw new Error("randomUUID unavailable in this context");
    });
    const getRandomValues = vi.fn(zeroToFifteenBytes);
    stubCrypto({ randomUUID, getRandomValues });

    const sessionId = createVaultSessionId();

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(sessionId).toBe("session-000102030405060708090a0b0c0d0e0f");
  });

  it("falls back to getRandomValues() when randomUUID returns an unusable value", () => {
    const getRandomValues = vi.fn(zeroToFifteenBytes);
    stubCrypto({ randomUUID: () => "", getRandomValues });

    expect(createVaultSessionId()).toBe(
      "session-000102030405060708090a0b0c0d0e0f",
    );
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it("fails closed when secure randomness is unavailable", () => {
    stubCrypto(undefined);

    expect(createVaultSessionId()).toBe("");
  });

  it("fails closed when the crypto API exposes no secure source", () => {
    stubCrypto({});

    expect(createVaultSessionId()).toBe("");
  });

  it("fails closed when both secure sources throw", () => {
    stubCrypto({
      randomUUID: () => {
        throw new Error("no randomUUID");
      },
      getRandomValues: () => {
        throw new Error("no getRandomValues");
      },
    });

    expect(createVaultSessionId()).toBe("");
  });

  it("never falls back to Math.random() or Date.now()", () => {
    const mathRandom = vi.spyOn(Math, "random");
    const dateNow = vi.spyOn(Date, "now");

    stubCrypto({ randomUUID: () => FIXED_UUID });
    expect(createVaultSessionId()).toBe(FIXED_UUID);
    expect(mathRandom).not.toHaveBeenCalled();
    expect(dateNow).not.toHaveBeenCalled();

    stubCrypto({ getRandomValues: zeroToFifteenBytes });
    expect(createVaultSessionId()).toBe(
      "session-000102030405060708090a0b0c0d0e0f",
    );
    expect(mathRandom).not.toHaveBeenCalled();
    expect(dateNow).not.toHaveBeenCalled();
  });

  it("generates valid, distinct ids with the real Web Crypto API", () => {
    const first = createVaultSessionId();
    const second = createVaultSessionId();

    expect(first).not.toBe("");
    expect(second).not.toBe("");
    expect(first).not.toBe(second);
    expect(isValidVaultSessionId(first)).toBe(true);
    expect(isValidVaultSessionId(second)).toBe(true);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).not.toContain("/");
  });
});

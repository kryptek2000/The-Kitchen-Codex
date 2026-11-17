import { describe, it, expect, beforeEach } from "vitest";
import {
  RecipeImageRecoveryController,
  type RecipeImageRecoveryState,
  type RecipeImageRecoverySupport,
} from "../../src/application/recipeImageRecovery.js";
import { hydrateAiSelections } from "../../src/application/aiSelection.js";
import type { NetworkAdapter, NetworkResponse } from "../../src/application/adapters/NetworkAdapter.js";
import type { ObsidianRecipe } from "../../src/types.js";

/**
 * P2 — in-flight image-generation cancellation.
 *
 * Proves the UI controller's Cancel/Close aborts the EXACT generate request
 * signal (so the server can stop the upstream provider call) and never
 * repopulates preview state from the aborted result. No network.
 */

const RECIPE = {
  title: "Cancellation Soup",
  ingredients: [{ name: "water" }],
  cuisine: "Test",
  category: "Dinner",
  description: "test",
} as unknown as ObsidianRecipe;

function support(): RecipeImageRecoverySupport {
  return {
    vaultSessionId: "vault-session-cancel",
    asset: {
      read: async () => undefined,
      write: async () => ({ path: "Assets/x.png" }),
      exists: async () => false,
      list: async () => [],
      remove: async () => undefined,
    } as unknown as RecipeImageRecoverySupport["asset"],
    computeContentHash: async () => "a".repeat(64),
    saveImage: async () => ({ ok: true }) as never,
  };
}

function networkWithControlledGenerate(): {
  network: NetworkAdapter;
  generateSignal: () => AbortSignal | undefined;
  generateStarted: Promise<void>;
} {
  let signal: AbortSignal | undefined;
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const network: NetworkAdapter = {
    request: async () => ({ status: 200, ok: true, data: { ok: true } }),
    get: async () => ({ status: 200, ok: true }),
    post: async (path: string, _body: unknown, options?: { signal?: AbortSignal }) => {
      if (path === "/api/recipes/image/quote") {
        return {
          status: 200,
          ok: true,
          data: {
            ok: true,
            provider: { id: "openai-image", name: "OpenAI Image" },
            model: "gpt-image-2.6-flare",
            credentialSource: "server_environment",
            costClass: "variable",
            costLabel: "Variable pricing — determined by your OpenAI account",
            requiresConfirmation: true,
            confirmationToken: "token-1",
          },
        } as NetworkResponse<unknown>;
      }
      signal = options?.signal;
      markStarted();
      return new Promise<NetworkResponse<unknown>>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted by test")));
      });
    },
  } as unknown as NetworkAdapter;
  return { network, generateSignal: () => signal, generateStarted: started };
}

beforeEach(async () => {
  // The controller's request options await hydrated (non-secret) AI selection.
  await hydrateAiSelections({ get: async () => undefined });
});

describe("P2 — image generation cancellation", () => {
  it("cancel() aborts the in-flight generate signal and drops the result", async () => {
    const controlled = networkWithControlledGenerate();
    const states: RecipeImageRecoveryState[] = [];
    const controller = new RecipeImageRecoveryController({
      network: controlled.network,
      support: support(),
      onState: (state) => states.push(state),
    });

    await controller.generate(RECIPE);
    expect(controller.getState().phase).toBe("confirming");

    const confirming = controller.confirm(RECIPE);
    await controlled.generateStarted;
    expect(controlled.generateSignal()).toBeInstanceOf(AbortSignal);
    expect(controlled.generateSignal()?.aborted).toBe(false);

    await controller.cancel();
    expect(controlled.generateSignal()?.aborted).toBe(true);
    await confirming;

    // Cancellation wins: state is idle, no preview was repopulated.
    expect(controller.getState().phase).toBe("idle");
    expect(controller.getState().preview).toBeUndefined();
    expect(controller.isBusy()).toBe(false);
  });

  it("close() aborts the in-flight generate signal and drops the result", async () => {
    const controlled = networkWithControlledGenerate();
    const controller = new RecipeImageRecoveryController({
      network: controlled.network,
      support: support(),
      onState: () => {},
    });

    await controller.generate(RECIPE);
    const confirming = controller.confirm(RECIPE);
    await controlled.generateStarted;
    controller.close();
    expect(controlled.generateSignal()?.aborted).toBe(true);
    await confirming;
    expect(controller.getState().phase).toBe("idle");
    expect(controller.getState().preview).toBeUndefined();
  });
});

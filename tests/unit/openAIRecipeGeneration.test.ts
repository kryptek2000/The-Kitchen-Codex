import { describe, it, expect } from "vitest";
import {
  OpenAIProvider,
  OPENAI_DEFAULT_MODEL,
  OPENAI_MODEL_CAPABILITIES,
  OPENAI_RESPONSES_ENDPOINT,
} from "../../server/ai/openAIProvider.js";
import type { RegisteredProvider } from "../../server/ai/providerRegistry.js";
import { generateRecipeDraftOnServer } from "../../server/createRecipe.js";
import { ProviderOperationError } from "../../server/ai/providerErrors.js";

const SECRET = "sk-recipe-test-session";

function completed(text: string): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function openAI(fetchFn: (url: string, init: RequestInit) => Promise<Response>) {
  const provider = new OpenAIProvider({ credential: SECRET, fetchFn });
  const registry: RegisteredProvider[] = [
    {
      provider,
      defaultCapabilities: { ...provider.capabilities },
      modelCapabilities: OPENAI_MODEL_CAPABILITIES,
      enabled: true,
      defaultFallback: false,
    },
  ];
  const candidates = [{ provider, model: OPENAI_DEFAULT_MODEL, credentialSource: "session_only" as const }];
  return { provider, registry, candidates };
}

const MINIMAL_DRAFT = {
  title: "Lemon Garlic Pasta",
  ingredients: [
    { name: "spaghetti", amount: 400, unit: "g" },
    { name: "lemon", amount: 2 },
  ],
  steps: [{ text: "Boil the pasta." }, { text: "Toss with lemon and garlic." }],
};

describe("OpenAI structured recipe generation (P1)", () => {
  it("produces a normalized draft through the existing Create for Me engine", async () => {
    let seenBody: Record<string, any> = {};
    let seenUrl = "";
    const { registry, candidates } = openAI(async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return completed(JSON.stringify(MINIMAL_DRAFT));
    });

    const result = await generateRecipeDraftOnServer(
      {
        prompt: "A simple weeknight lemon garlic pasta for four",
        constraints: { servings: 4, maxTotalMinutes: 45 },
      },
      { candidates, registry }
    );

    expect(seenUrl).toBe(OPENAI_RESPONSES_ENDPOINT);
    expect(seenBody.store).toBe(false);
    expect(seenBody.service_tier).toBe("default");
    expect(seenBody.text.format.type).toBe("json_schema");
    expect(seenBody.text.format.strict).toBe(true);
    expect(seenBody.text.format.schema.type).toBe("object");
    expect(seenBody.text.format.schema.additionalProperties).toBe(false);
    expect(result.provenance).toEqual({
      generated: true,
      providerId: "openai",
      model: OPENAI_DEFAULT_MODEL,
    });
    expect(result.draft.title).toBe("Lemon Garlic Pasta");
    expect(result.draft.ingredients.length).toBeGreaterThan(0);
    expect(result.draft.steps.length).toBeGreaterThan(0);
    // The transient prompt is not part of the returned draft/provenance.
    expect(JSON.stringify(result)).not.toContain("weeknight lemon garlic pasta");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("rejects an invalid draft instead of silently accepting malformed model output", async () => {
    const { registry, candidates } = openAI(async () =>
      completed(JSON.stringify({ title: "No ingredients or steps" }))
    );

    await expect(
      generateRecipeDraftOnServer(
        { prompt: "A recipe with missing fields" },
        { candidates, registry }
      )
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("does not fall back to a different provider or accept a refusal", async () => {
    let calls = 0;
    const { registry, candidates } = openAI(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "No recipe." }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    await expect(
      generateRecipeDraftOnServer({ prompt: "refuse this" }, { candidates, registry })
    ).rejects.toBeInstanceOf(ProviderOperationError);
    expect(calls).toBe(1); // exactly one provider call; no retry/fallback
  });

  it("does not retry an authentication failure", async () => {
    let calls = 0;
    const { registry, candidates } = openAI(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(
      generateRecipeDraftOnServer({ prompt: "auth fail" }, { candidates, registry })
    ).rejects.toMatchObject({ code: "AUTH" });
    expect(calls).toBe(1);
  });

  it("preserves explicit candidate selection and never silently switches models", async () => {
    const { provider, registry } = openAI(async () =>
      completed(JSON.stringify(MINIMAL_DRAFT))
    );
    const candidates = [
      { provider, model: "gpt-6.1-terra", credentialSource: "session_only" as const },
    ];
    const result = await generateRecipeDraftOnServer(
      { prompt: "Use the selected model" },
      { candidates, registry }
    );
    expect(result.provenance.model).toBe("gpt-6.1-terra");
  });

  it("a provider-only selection uses Terra only and does not substitute Luna after failure", async () => {
    let calls = 0;
    const { provider, registry } = openAI(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: "server_is_overloaded" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { resolveTextCandidateContext } = await import(
      "../../server/ai/effectiveSelection.js"
    );
    const context = resolveTextCandidateContext("createRecipe", registry, {
      mode: "user_selected",
      providerId: "openai",
    });
    expect(context.candidates.map((c) => c.model)).toEqual(["gpt-6.1-terra"]);

    await expect(
      generateRecipeDraftOnServer(
        { prompt: "provider-only selection" },
        {
          candidates: context.candidates,
          registry,
          userSelection: { mode: "user_selected", providerId: "openai" },
        }
      )
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(calls).toBe(1);
  });
});

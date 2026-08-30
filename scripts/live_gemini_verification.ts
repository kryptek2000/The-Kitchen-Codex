import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

console.log("================================================================");
console.log("🤖 LIVE GEMINI API VERIFICATION USING APPLICATION SDK INTEGRATION");
console.log("================================================================");

if (!apiKey) {
  console.error("❌ ERROR: GEMINI_API_KEY environment variable is missing.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const modelsToTest = [
  "gemini-3.7-flash",
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
];

export interface ModelTestResult {
  model: string;
  success: boolean;
  status: string;
  responseSnippet?: string;
  errorCategory?: string;
  errorMessage?: string;
}

async function testModel(modelId: string): Promise<ModelTestResult> {
  try {
    const response = await ai.models.generateContent({
      model: modelId,
      contents: 'Respond with the exact single word "ONLINE".',
      config: {
        maxOutputTokens: 10,
        temperature: 0.1,
      },
    });

    const text = (response.text || "").trim();
    return {
      model: modelId,
      success: true,
      status: "Available (200 OK)",
      responseSnippet: text,
    };
  } catch (err: any) {
    let errorCategory = "Unknown Error";
    const status = err.status || err.statusCode || (err.message?.match(/\b(400|401|403|404|429|500|502|503)\b/)?.[0]);
    if (status) {
      errorCategory = `HTTP ${status}`;
    }
    if (err.message?.includes("NOT_FOUND") || err.message?.includes("not found")) {
      errorCategory = "404 Not Found (Model ID not available in API)";
    } else if (err.message?.includes("RESOURCE_EXHAUSTED") || err.message?.includes("quota")) {
      errorCategory = "429 Resource Exhausted / Rate Limit";
    } else if (err.message?.includes("PERMISSION_DENIED")) {
      errorCategory = "403 Permission Denied";
    }

    return {
      model: modelId,
      success: false,
      status: "Unavailable",
      errorCategory,
      errorMessage: err.message,
    };
  }
}

async function run() {
  const results: ModelTestResult[] = [];
  for (const model of modelsToTest) {
    console.log(`Testing model: ${model}...`);
    const res = await testModel(model);
    results.push(res);
    if (res.success) {
      console.log(`  ✅ ${res.model}: ${res.status} (Output: "${res.responseSnippet}")`);
    } else {
      console.log(`  ❌ ${res.model}: ${res.status} [${res.errorCategory}] - ${res.errorMessage}`);
    }
  }

  console.log("\nSummary of Live Model Verification:");
  console.table(results.map(r => ({
    "Model ID": r.model,
    "Status": r.status,
    "Error Category": r.errorCategory || "None",
    "Output Snippet": r.responseSnippet || "N/A"
  })));
}

run();

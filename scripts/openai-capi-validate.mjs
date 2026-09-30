import nextEnv from "@next/env";
import { randomUUID } from "node:crypto";
import { validateOpenAIConversion } from "../src/lib/outbound/openai.mjs";

nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

// Always synthetic, always validation-only, regardless of production env settings.
try {
  const result = await validateOpenAIConversion(randomUUID());
  console.log(JSON.stringify(result, null, 2));
  if (result.skipped || !result.ok) process.exitCode = 1;
} catch {
  console.error("OpenAI CAPI validation failed; no credentials or upstream details were logged.");
  process.exitCode = 1;
}

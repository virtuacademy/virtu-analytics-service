import nextEnv from "@next/env";
import { randomUUID } from "node:crypto";
import { sendOpenAIConversion } from "../src/lib/outbound/openai.mjs";

nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

// Always synthetic, always validation-only, regardless of production env settings.
try {
  const result = await sendOpenAIConversion(
    {
      eventId: `validation_${randomUUID()}`,
      eventName: "TRIAL_BOOKED",
      eventTime: new Date(),
      eventSourceUrl: "https://virtu.academy",
      email: "openai-capi-validation@example.com",
    },
    {
      env: {
        ...process.env,
        OPENAI_CAPI_ENABLED: "true",
        OPENAI_CAPI_VALIDATE_ONLY: "true",
        OPENAI_CAPI_EVENTS: "TRIAL_BOOKED",
        OUTBOUND_MODE: "",
      },
    },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.skipped || !result.ok) process.exitCode = 1;
} catch {
  console.error("OpenAI CAPI validation failed; no credentials or upstream details were logged.");
  process.exitCode = 1;
}

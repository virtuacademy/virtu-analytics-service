import nextEnv from "@next/env";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@upstash/qstash";

nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

// The destination and message shape are fixed: no booking ID or customer data is accepted.
const url = "https://attrib.virtu.academy/api/qstash/deliver";
const validationId = randomUUID();
try {
  if (!process.env.QSTASH_TOKEN?.trim()) throw new Error("Missing QStash credential");
  const client = new Client({ token: process.env.QSTASH_TOKEN, retry: false });
  const { messageId } = await client.publishJSON({
    url,
    body: { kind: "openai_validation", validationId },
    retries: 0,
    timeout: 20,
    deduplicationId: `openai_validation_${validationId}`,
  });
  console.log(JSON.stringify({ messageId, validationId, mode: "validation_only", queued: true }));
  const deadline = Date.now() + 60000;
  let finished = false;
  while (Date.now() < deadline) {
    const { logs } = await client.logs({ filter: { messageId } });
    const terminal = logs.find(
      (log) =>
        log.messageId === messageId &&
        log.url === url &&
        ["DELIVERED", "FAILED", "CANCELED"].includes(log.state),
    );
    if (terminal) {
      const passed = terminal.state === "DELIVERED";
      // The validation handler returns 2xx only after the DB probe and OpenAI validation pass.
      // Never print raw QStash bodies, headers, or upstream errors.
      console.log(
        JSON.stringify({
          messageId,
          validationId,
          qstashState: terminal.state,
          backendValidationPassed: passed,
          conversionRecorded: false,
        }),
      );
      if (!passed) process.exitCode = 1;
      finished = true;
      break;
    }
    await delay(2000);
  }
  if (!finished) {
    console.error(
      "Validation result is still pending; inspect this message ID in QStash logs before rerunning.",
    );
    process.exitCode = 1;
  }
} catch {
  console.error("Backend validation failed; no credentials or raw upstream details were logged.");
  process.exitCode = 1;
}

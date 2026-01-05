import crypto from "crypto";

export function sha256Base64(input: string, secret: string): string {
  const h = crypto.createHmac("sha256", secret);
  h.update(input);
  return h.digest("base64");
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomId(): string {
  return crypto.randomUUID();
}

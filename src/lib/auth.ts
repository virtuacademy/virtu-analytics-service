type AuthPayload = {
  sid: string;
  exp: number;
};

const textEncoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let base64: string;
  if (typeof Buffer !== "undefined") {
    base64 = Buffer.from(bytes).toString("base64");
  } else {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array | null {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  try {
    if (typeof Buffer !== "undefined") {
      return Uint8Array.from(Buffer.from(padded, "base64"));
    }
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let result = 0;
  for (let i = 0; i < len; i += 1) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0 && a.length === b.length;
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(data));
  return new Uint8Array(sig);
}

export async function createAuthCookieValue(
  secret: string,
  maxAgeSeconds: number,
): Promise<string> {
  const payload: AuthPayload = {
    sid: crypto.randomUUID(),
    exp: Date.now() + maxAgeSeconds * 1000,
  };
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  const payloadB64 = base64UrlEncode(payloadBytes);
  const sig = await hmacSha256(secret, payloadB64);
  const sigB64 = base64UrlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

export async function verifyAuthCookieValue(
  value: string | undefined,
  secret: string,
): Promise<AuthPayload | null> {
  if (!value) return null;
  const [payloadB64, sigB64] = value.split(".");
  if (!payloadB64 || !sigB64) return null;

  const expectedSig = await hmacSha256(secret, payloadB64);
  const expectedSigB64 = base64UrlEncode(expectedSig);
  if (!timingSafeEqual(sigB64, expectedSigB64)) return null;

  const payloadBytes = base64UrlDecode(payloadB64);
  if (!payloadBytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as AuthPayload;
    if (!payload?.sid || typeof payload.sid !== "string") return null;
    if (!payload?.exp || typeof payload.exp !== "number") return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

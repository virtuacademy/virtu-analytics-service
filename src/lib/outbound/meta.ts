import { toUnixSeconds } from "../normalize";
import { sha256Hex } from "../crypto";

type MetaUserData = {
  em?: string[];
  ph?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
};

export async function sendMetaCapi(args: {
  eventName: string;
  eventId: string;
  eventTime: Date;
  eventSourceUrl: string;
  ip?: string | null;
  userAgent?: string | null;
  email?: string | null;
  phoneDigits?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  customData?: Record<string, unknown>;
}) {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !accessToken) return { skipped: true, reason: "Missing META_PIXEL_ID or token" };

  const user_data: MetaUserData = {};

  if (args.email) user_data.em = [sha256Hex(args.email.trim().toLowerCase())];
  if (args.phoneDigits) user_data.ph = [sha256Hex(args.phoneDigits)];
  if (args.ip && args.userAgent) {
    user_data.client_ip_address = args.ip;
    user_data.client_user_agent = args.userAgent;
  }
  if (args.fbc) user_data.fbc = args.fbc;
  if (args.fbp) user_data.fbp = args.fbp;

  const payload = {
    data: [
      {
        event_name: args.eventName,
        event_time: toUnixSeconds(args.eventTime),
        event_id: args.eventId,
        action_source: "website",
        event_source_url: args.eventSourceUrl,
        user_data,
        custom_data: args.customData ?? {}
      }
    ]
  };
  const requestBody = JSON.stringify(payload);

  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
    cache: "no-store"
  });

  const text = await res.text();
  return { skipped: false, ok: res.ok, status: res.status, body: text, requestBody };
}

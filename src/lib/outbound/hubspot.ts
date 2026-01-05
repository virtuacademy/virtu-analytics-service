export async function submitHubSpotForm(args: {
  portalId: string;
  formGuid: string;
  accessToken: string;
  email?: string | null;
  fields: Record<string, string | number | null | undefined>;
  hutk?: string | null;
  pageUri?: string | null;
  pageName?: string | null;
  ipAddress?: string | null;
}) {
  const url = `https://api.hubapi.com/submissions/v3/integration/secure/submit/${encodeURIComponent(args.portalId)}/${encodeURIComponent(args.formGuid)}`;

  const body = {
    submittedAt: Date.now(),
    fields: Object.entries(args.fields)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([name, value]) => ({ name, value: String(value) })),
    context: {
      hutk: args.hutk ?? undefined,
      pageUri: args.pageUri ?? undefined,
      pageName: args.pageName ?? undefined,
      ipAddress: args.ipAddress ?? undefined
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    cache: "no-store"
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

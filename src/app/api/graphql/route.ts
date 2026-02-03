import { ApolloServer } from "@apollo/server";
import { startServerAndCreateNextHandler } from "@as-integrations/next";
import type { NextRequest } from "next/server";
import { typeDefs, resolvers } from "@/graphql/schema";
import { verifyAuthCookieValue } from "@/lib/auth";

export const runtime = "nodejs";

const server = new ApolloServer({ typeDefs, resolvers });

const handler = startServerAndCreateNextHandler<NextRequest>(server, {
  context: async () => ({}),
});

async function requireAuth(req: NextRequest) {
  const authPassword = process.env.AUTH_PASSWORD;
  if (!authPassword) return null;
  const token = req.cookies.get("va_auth")?.value;
  const valid = token ? await verifyAuthCookieValue(token, authPassword) : null;
  if (!valid) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const authResponse = await requireAuth(req);
  if (authResponse) return authResponse;
  return handler(req);
}

export async function POST(req: NextRequest) {
  const authResponse = await requireAuth(req);
  if (authResponse) return authResponse;
  return handler(req);
}

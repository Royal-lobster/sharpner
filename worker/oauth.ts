import { Hono, type Context } from "hono";
import { authErrorStatus, clerkIssuer, type AppEnv } from "./auth";

/** Identity scopes understood by Clerk, rather than Sharpner's internal tool permissions. */
export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"];
export const resourceMetadataUrl = (request: Request) => new URL("/.well-known/oauth-protected-resource/mcp", request.url).href;

export function oauthChallenge(request: Request, message = "Sign in through Clerk to connect this agent") {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl(request)}", scope="${OAUTH_SCOPES.join(" ")}"`,
    },
  });
}

export const oauth = new Hono<AppEnv>();
oauth.onError((error, c) => c.json({ error: error.message }, authErrorStatus(error) ?? 503));

const metadata = (c: Context<AppEnv>) => {
  const origin = new URL(c.req.url).origin;
  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "public, max-age=300");
  return c.json({
    resource: `${origin}/mcp`,
    resource_name: "Sharpner",
    authorization_servers: [clerkIssuer(c.env.CLERK_PUBLISHABLE_KEY)],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/`,
  });
};

oauth.get("/oauth-protected-resource", metadata);
oauth.get("/oauth-protected-resource/mcp", metadata);

// Older MCP clients discover the authorization server at the resource origin.
oauth.get("/oauth-authorization-server", async (c) => {
  const issuer = clerkIssuer(c.env.CLERK_PUBLISHABLE_KEY);
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return c.json({ error: "Clerk OAuth discovery is unavailable" }, 503);
  const document = await response.json() as { issuer?: string; [key: string]: unknown };
  if (document.issuer !== issuer) return c.json({ error: "Clerk OAuth issuer does not match this application" }, 503);
  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "public, max-age=300");
  return c.json(document);
});

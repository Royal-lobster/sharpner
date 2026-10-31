import { createClerkClient } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { Hono } from "hono";
import { AccountError, handleAccountWebhook, syncAccount, type AccountUser, type AccountWorkspace } from "./accounts";
import type { SessionPrincipal } from "../shared/session-principal";

export type User = AccountUser;
export type Scope = "sharpner:read" | "sharpner:write";
export type Identity = {
  user: User;
  clerkUserId: string;
  workspaces: AccountWorkspace[];
  method: "session" | "oauth" | "api_key";
  scopes: string[];
  organizationId: string | null;
  /** Verified session JWT expiry in epoch milliseconds; machines have no browser session. */
  sessionExpiresAt: number | null;
  sessionId: string | null;
};
type AuthBindings = Env & {
  CLERK_MCP_CLIENT_ID?: string;
  CLERK_MCP_CALLBACK_PORT?: string;
  CLERK_API_KEYS_ENABLED?: string;
};
export type AppEnv = { Bindings: AuthBindings; Variables: { user: User; identity: Identity } };

/** Publish only immutable claims from the verified browser credential, never the local author ID. */
export function sessionPrincipal(identity: Identity): SessionPrincipal | null {
  return identity.method === "session" && identity.clerkUserId && identity.sessionId
    ? { clerkUserId: identity.clerkUserId, sessionId: identity.sessionId, organizationId: identity.organizationId }
    : null;
}

/** OAuth agents can use the design tools, within their member's current workspaces. */
export const AGENT_SCOPES: Scope[] = ["sharpner:read", "sharpner:write"];

export class AuthError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 503) {
    super(message);
  }
}

/** The instance's own Frontend API host is also Clerk's OAuth issuer. */
export function clerkIssuer(publishableKey: string): string {
  if (!/^pk_(test|live)_/.test(publishableKey)) throw new AuthError("Clerk is not configured", 503);
  try {
    const host = atob(publishableKey.replace(/^pk_(test|live)_/, "")).replace(/\$$/, "");
    if (!/^[a-z0-9.-]+$/i.test(host) || !host.includes(".")) throw new Error("Invalid host");
    return `https://${host}`;
  } catch {
    throw new AuthError("Invalid Clerk publishable key", 503);
  }
}

export function clerkClient(env: Env) {
  if (!env.CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) throw new AuthError("Clerk is not configured", 503);
  return createClerkClient({ publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY });
}

/** Browser sessions and machine credentials have separate entry points and permission checks. */
export async function authenticate(env: Env, request: Request, mode: "session" | "machine"): Promise<Identity | null> {
  if (mode === "machine" && !/^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "")) return null;
  const client = clerkClient(env);
  const state = await client.authenticateRequest(request, {
    acceptsToken: mode === "session" ? ["session_token"] : ["oauth_token", "api_key"],
    authorizedParties: [new URL(request.url).origin],
    issuer: clerkIssuer(env.CLERK_PUBLISHABLE_KEY),
  });
  const auth = state.toAuth();
  if (!auth?.isAuthenticated) return null;
  if (!auth.userId) throw new AuthError("Agents must act as a member; organization-scoped keys are not supported", 403);

  const method = auth.tokenType === "session_token" ? "session" : auth.tokenType === "oauth_token" ? "oauth" : "api_key";
  // Clerk's OAuth scopes describe identity. Keep the app permission ceiling here, as in Recalio.
  const scopes = auth.tokenType === "api_key" ? auth.scopes : [...AGENT_SCOPES];
  if (method !== "session" && !scopes.some((s) => AGENT_SCOPES.includes(s as Scope))) {
    throw new AuthError("Credential has no Sharpner permissions", 403);
  }
  const account = await syncAccount(env, client, auth.userId);
  const expiry = auth.tokenType === "session_token" ? auth.sessionClaims?.exp : null;
  const sessionExpiresAt = typeof expiry === "number" && expiry > 0 && Number.isFinite(expiry * 1000) ? expiry * 1000 : null;
  const sessionId = auth.tokenType === "session_token" ? auth.sessionId ?? null : null;
  return { ...account, clerkUserId: auth.userId, method, scopes, organizationId: auth.tokenType === "session_token" ? auth.orgId ?? null : null, sessionExpiresAt, sessionId };
}

export function requireScope(identity: Identity, scope: Scope) {
  if (!identity.scopes.includes(scope)) throw new AuthError(`Credential requires ${scope}`, 403);
}

export const auth = new Hono<AppEnv>();

/** A configured production origin lets browser file links survive a hostname change. */
function configuredAppOrigin(value?: string): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
      ? url.origin : null;
  } catch {
    return null;
  }
}

auth.get("/config", (c) => {
  const appOrigin = configuredAppOrigin(c.env.APP_ORIGIN);
  const clientId = c.env.CLERK_MCP_CLIENT_ID?.trim() ?? "";
  const callbackPort = c.env.CLERK_MCP_CALLBACK_PORT?.trim() ?? "";
  const port = Number(callbackPort);
  // These values become a copyable command. Publish only a complete, command-safe pair.
  const publicClient = /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(clientId) && !/^(sk_(test|live)_|whsec_)/.test(clientId)
    && /^\d{1,5}$/.test(callbackPort) && port > 0 && port <= 65535;
  c.header("cache-control", "no-store");
  return c.json({
    publishableKey: c.env.CLERK_PUBLISHABLE_KEY || "",
    configured: Boolean(c.env.CLERK_PUBLISHABLE_KEY && c.env.CLERK_SECRET_KEY),
    ...(appOrigin ? { appOrigin } : {}),
    mcpClientId: publicClient ? clientId : null,
    mcpCallbackPort: publicClient ? port : null,
    agentKeysEnabled: c.env.CLERK_API_KEYS_ENABLED === "1",
  });
});

auth.post("/webhook", async (c) => {
  if (!c.env.CLERK_WEBHOOK_SIGNING_SECRET) return c.json({ error: "Clerk webhook is not configured" }, 503);
  let event;
  try {
    event = await verifyWebhook(c.req.raw, { signingSecret: c.env.CLERK_WEBHOOK_SIGNING_SECRET });
  } catch {
    return c.json({ error: "Invalid Clerk webhook signature" }, 400);
  }
  await handleAccountWebhook(c.env, clerkClient(c.env), event);
  return c.body(null, 204);
});

export function authErrorStatus(error: unknown): 401 | 403 | 503 | null {
  return error instanceof AuthError || error instanceof AccountError ? error.status : null;
}

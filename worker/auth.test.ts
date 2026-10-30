import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClerkClient: vi.fn(),
  authenticateRequest: vi.fn(),
  syncAccount: vi.fn(),
  handleAccountWebhook: vi.fn(),
  verifyWebhook: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({ createClerkClient: mocks.createClerkClient }));
vi.mock("@clerk/backend/webhooks", () => ({ verifyWebhook: mocks.verifyWebhook }));
vi.mock("./accounts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./accounts")>(),
  syncAccount: mocks.syncAccount,
  handleAccountWebhook: mocks.handleAccountWebhook,
}));

import { AccountError } from "./accounts";
import { AGENT_SCOPES, authenticate, auth, AuthError, authErrorStatus, requireScope, type AppEnv, type Identity } from "./auth";

const issuer = "https://sharpner-test.clerk.accounts.dev";
const sessionExpiry = 2_000_000_000;
const publishableKey = `pk_test_${btoa("sharpner-test.clerk.accounts.dev$")}`;
const env = {
  CLERK_PUBLISHABLE_KEY: publishableKey,
  CLERK_SECRET_KEY: "sk_test_fixture_only",
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec_fixture_only",
} as Env;
const account = {
  user: { id: "local-author", login: "alice", name: "Alice", avatar_url: null },
  workspaces: [{ id: "local-workspace", name: "Design", role: "owner", clerkOrganizationId: "org_design" }],
};
const client = { authenticateRequest: mocks.authenticateRequest };
const request = (authorization?: string, cookie?: string) => new Request("https://sharpner.example/api/me", {
  headers: { ...(authorization ? { authorization } : {}), ...(cookie ? { cookie } : {}) },
});
const verified = (value: Record<string, unknown> | null) => mocks.authenticateRequest.mockResolvedValue({ toAuth: () => value });
const app = () => new Hono<AppEnv>().route("/auth", auth);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createClerkClient.mockReturnValue(client);
  mocks.syncAccount.mockResolvedValue(account);
  verified({ isAuthenticated: true, tokenType: "session_token", userId: "user_clerk_alice", orgId: "org_design", sessionClaims: { exp: sessionExpiry } });
});

describe("Clerk request authentication", () => {
  it("verifies browser sessions with this request's origin and the configured Clerk issuer", async () => {
    const req = request("Bearer session_fixture");
    const identity = await authenticate(env, req, "session");

    expect(mocks.createClerkClient).toHaveBeenCalledWith({ publishableKey, secretKey: env.CLERK_SECRET_KEY });
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(req, {
      acceptsToken: ["session_token"], authorizedParties: ["https://sharpner.example"], issuer,
    });
    expect(mocks.syncAccount).toHaveBeenCalledWith(env, client, "user_clerk_alice");
    expect(identity).toEqual({
      ...account, clerkUserId: "user_clerk_alice", method: "session", scopes: ["sharpner:read", "sharpner:write"], organizationId: "org_design", sessionExpiresAt: sessionExpiry * 1000,
    });
  });

  it("retains stable local IDs and the original Clerk subject as distinct identities", async () => {
    const identity = await authenticate(env, request(), "session");
    expect(identity).toMatchObject({ user: { id: "local-author" }, clerkUserId: "user_clerk_alice" });
    expect(identity?.workspaces).toEqual(account.workspaces);
    expect(identity?.user.id).not.toBe(identity?.clerkUserId);
  });

  it("returns no active organization for a session in personal account context", async () => {
    verified({ isAuthenticated: true, tokenType: "session_token", userId: "user_clerk_alice" });
    expect(await authenticate(env, request(), "session")).toMatchObject({ organizationId: null });
  });

  it.each([undefined, null, "2000000000", 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE].map((expiry) => ({ expiry })))("does not turn malformed session expiry $expiry into a socket lease", async ({ expiry }) => {
    verified({ isAuthenticated: true, tokenType: "session_token", userId: "user_clerk_alice", sessionClaims: { exp: expiry } });
    expect(await authenticate(env, request(), "session")).toMatchObject({ sessionExpiresAt: null });
  });

  it("preserves the verified expiry rather than extending a past session into a new lease", async () => {
    verified({ isAuthenticated: true, tokenType: "session_token", userId: "user_clerk_alice", sessionClaims: { exp: 1 } });
    expect(await authenticate(env, request(), "session")).toMatchObject({ sessionExpiresAt: 1000 });
  });

  it.each(["oauth_token", "api_key"])("does not use %s claims to issue a browser socket lease", async (tokenType) => {
    verified({ isAuthenticated: true, tokenType, userId: "user_clerk_alice", scopes: ["sharpner:read"], sessionClaims: { exp: sessionExpiry } });
    expect(await authenticate(env, request("Bearer machine_fixture"), "machine")).toMatchObject({ sessionExpiresAt: null });
  });

  it.each([
    { authorization: undefined, cookie: undefined },
    { authorization: undefined, cookie: "__session=ambient_cookie_fixture" },
    { authorization: "Basic credentials_fixture", cookie: "__session=ambient_cookie_fixture" },
    { authorization: "Bearer ", cookie: undefined },
  ])("does not authenticate a machine without a bearer credential: $authorization", async ({ authorization, cookie }) => {
    expect(await authenticate(env, request(authorization, cookie), "machine")).toBeNull();
    expect(mocks.createClerkClient).not.toHaveBeenCalled();
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.syncAccount).not.toHaveBeenCalled();
  });

  it("restricts the machine verifier to OAuth and API key tokens even when cookies are present", async () => {
    verified({ isAuthenticated: true, tokenType: "oauth_token", userId: "user_clerk_alice", scopes: ["openid"] });
    const req = request("Bearer oauth_fixture", "__session=ambient_cookie_fixture");
    expect(await authenticate(env, req, "machine")).toMatchObject({ method: "oauth", organizationId: null });
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(req, {
      acceptsToken: ["oauth_token", "api_key"], authorizedParties: ["https://sharpner.example"], issuer,
    });
  });

  it.each([null, { isAuthenticated: false }])("rejects unauthenticated Clerk results", async (value) => {
    verified(value);
    expect(await authenticate(env, request("Bearer invalid_fixture"), "machine")).toBeNull();
    expect(mocks.syncAccount).not.toHaveBeenCalled();
  });

  it("rejects an organization-scoped API key before projecting any account", async () => {
    verified({ isAuthenticated: true, tokenType: "api_key", userId: null, orgId: "org_design", subject: "org_design", scopes: ["sharpner:write"] });
    await expect(authenticate(env, request("Bearer org_key_fixture"), "machine")).rejects.toMatchObject({ status: 403 });
    expect(mocks.syncAccount).not.toHaveBeenCalled();
  });

  it.each([[], ["openid", "profile", "email"], ["sharpner:admin", "unrelated:write"]].map((scopes) => ({ scopes })))("gives OAuth agents the fixed Sharpner ceiling independently of identity scopes $scopes", async ({ scopes }) => {
    verified({ isAuthenticated: true, tokenType: "oauth_token", userId: "user_clerk_alice", scopes });
    const identity = await authenticate(env, request("Bearer oauth_fixture"), "machine");
    expect(identity).toMatchObject({ method: "oauth", scopes: ["sharpner:read", "sharpner:write"], organizationId: null });
    expect(identity?.scopes).not.toBe(AGENT_SCOPES);
  });

  it("preserves API key scopes and refuses write access to a read-only key", async () => {
    verified({ isAuthenticated: true, tokenType: "api_key", userId: "user_clerk_alice", scopes: ["sharpner:read"] });
    const identity = await authenticate(env, request("Bearer user_key_fixture"), "machine");
    expect(identity).toMatchObject({ method: "api_key", scopes: ["sharpner:read"], organizationId: null });
    expect(() => requireScope(identity as Identity, "sharpner:read")).not.toThrow();
    expect(() => requireScope(identity as Identity, "sharpner:write")).toThrowError(AuthError);
    try { requireScope(identity as Identity, "sharpner:write"); } catch (error) { expect(error).toMatchObject({ status: 403 }); }
  });

  it("does not grant a Clerk API key Sharpner access merely for having identity scopes", async () => {
    verified({ isAuthenticated: true, tokenType: "api_key", userId: "user_clerk_alice", scopes: ["openid", "profile"] });
    await expect(authenticate(env, request("Bearer unscoped_fixture"), "machine")).rejects.toMatchObject({ status: 403 });
    expect(mocks.syncAccount).not.toHaveBeenCalled();
  });

  it("fails closed when verified identity reconciliation fails", async () => {
    mocks.syncAccount.mockRejectedValue(new AccountError(503, "Clerk unavailable"));
    await expect(authenticate(env, request(), "session")).rejects.toMatchObject({ status: 503 });
  });

  it.each(["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] as const)("rejects missing %s before calling the SDK", async (field) => {
    await expect(authenticate({ ...env, [field]: "" }, request(), "session")).rejects.toMatchObject({ status: 503 });
    expect(mocks.createClerkClient).not.toHaveBeenCalled();
  });
});

describe("Clerk public configuration and webhook boundary", () => {
  it("publishes public configuration with optional agent features disabled by default", async () => {
    const response = await app().request("https://sharpner.example/auth/config", {}, env);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ publishableKey, configured: true, mcpClientId: null, mcpCallbackPort: null, agentKeysEnabled: false });
    expect(text).not.toContain(env.CLERK_SECRET_KEY);
    expect(text).not.toContain(env.CLERK_WEBHOOK_SIGNING_SECRET);
    expect(mocks.createClerkClient).not.toHaveBeenCalled();
  });

  it("reports missing server configuration without disclosing server values", async () => {
    const response = await app().request("https://sharpner.example/auth/config", {}, { ...env, CLERK_SECRET_KEY: "" });
    expect(await response.json()).toEqual({ publishableKey, configured: false, mcpClientId: null, mcpCallbackPort: null, agentKeysEnabled: false });
  });

  it("exposes a registered public MCP client and feature flag without leaking any server secret", async () => {
    const response = await app().request("https://sharpner.example/auth/config", {}, {
      ...env,
      CLERK_MCP_CLIENT_ID: "public_client_fixture",
      CLERK_MCP_CALLBACK_PORT: "54765",
      CLERK_API_KEYS_ENABLED: "1",
      CLERK_MCP_CLIENT_SECRET: "private_oauth_fixture_only",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      publishableKey, configured: true, mcpClientId: "public_client_fixture", mcpCallbackPort: 54765, agentKeysEnabled: true,
    });
    expect(text).not.toContain(env.CLERK_SECRET_KEY);
    expect(text).not.toContain(env.CLERK_WEBHOOK_SIGNING_SECRET);
    expect(text).not.toContain("private_oauth_fixture_only");
    expect(mocks.createClerkClient).not.toHaveBeenCalled();
  });

  it.each([
    { clientId: "public_client_fixture", port: "" },
    { clientId: "public_client_fixture", port: "0" },
    { clientId: "public_client_fixture", port: "65536" },
    { clientId: "public_client_fixture", port: "54765;echo" },
    { clientId: "client;echo", port: "54765" },
    { clientId: "sk_test_misplaced_secret", port: "54765" },
  ])("omits incomplete or unsafe copyable MCP settings $clientId/$port", async ({ clientId, port }) => {
    const response = await app().request("https://sharpner.example/auth/config", {}, {
      ...env, CLERK_MCP_CLIENT_ID: clientId, CLERK_MCP_CALLBACK_PORT: port,
    });
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ mcpClientId: null, mcpCallbackPort: null, agentKeysEnabled: false });
    expect(text).not.toContain(clientId);
    expect(text).not.toContain(env.CLERK_SECRET_KEY);
  });

  it("rejects an invalid webhook signature before any account reconciliation", async () => {
    mocks.verifyWebhook.mockRejectedValue(new Error("Invalid signature"));
    const response = await app().request("https://sharpner.example/auth/webhook", { method: "POST", body: "{}" }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Clerk webhook signature" });
    expect(mocks.handleAccountWebhook).not.toHaveBeenCalled();
    expect(mocks.createClerkClient).not.toHaveBeenCalled();
  });

  it("does not accept webhooks until a signing secret is configured", async () => {
    const response = await app().request("https://sharpner.example/auth/webhook", { method: "POST", body: "{}" }, { ...env, CLERK_WEBHOOK_SIGNING_SECRET: "" });
    expect(response.status).toBe(503);
    expect(mocks.verifyWebhook).not.toHaveBeenCalled();
    expect(mocks.handleAccountWebhook).not.toHaveBeenCalled();
  });

  it("passes only verified webhook events to account reconciliation", async () => {
    const event = { type: "organizationMembership.deleted", data: { public_user_data: { user_id: "user_clerk_alice" } } };
    mocks.verifyWebhook.mockResolvedValue(event);
    const response = await app().request("https://sharpner.example/auth/webhook", { method: "POST", body: "{}" }, env);
    expect(response.status).toBe(204);
    expect(mocks.verifyWebhook).toHaveBeenCalledWith(expect.any(Request), { signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET });
    expect(mocks.handleAccountWebhook).toHaveBeenCalledWith(env, client, event);
  });

  it("preserves authentication and account failure statuses without classifying arbitrary errors as authorization failures", () => {
    expect(authErrorStatus(new AuthError("Unauthenticated", 401))).toBe(401);
    expect(authErrorStatus(new AccountError(403, "Removed member"))).toBe(403);
    expect(authErrorStatus(new Error("Unrelated"))).toBeNull();
  });
});

describe("canonical app origin", () => {
  it("publishes the configured HTTPS origin for browser file-link redirects", async () => {
    const response = await app().request("/auth/config", {}, { ...env, APP_ORIGIN: "https://sharpner.app/" });
    expect(await response.json()).toMatchObject({ appOrigin: "https://sharpner.app", configured: true });
  });

  it.each([undefined, "", "http://sharpner.app", "https://user:password@sharpner.app", "https://sharpner.app/path", "https://sharpner.app?next=elsewhere", "not a URL"])(
    "omits an absent or invalid canonical origin %s without breaking sign-in configuration",
    async (APP_ORIGIN) => {
      const response = await app().request("/auth/config", {}, { ...env, APP_ORIGIN });
      const config = await response.json() as { configured: boolean };
      expect(config).not.toHaveProperty("appOrigin");
      expect(config.configured).toBe(true);
    },
  );
});

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./auth";
import { oauth, oauthChallenge } from "./oauth";

const issuer = "https://sharpner-test.clerk.accounts.dev";
const env = { CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("sharpner-test.clerk.accounts.dev$")}` } as Env;
const identityScopes = ["openid", "profile", "email", "offline_access"];
const clerkMetadata = {
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  client_id_metadata_document_supported: true,
};
const upstream = vi.fn<typeof fetch>();
const app = () => new Hono<AppEnv>()
  .route("/.well-known", oauth)
  .all("/mcp", (c) => oauthChallenge(c.req.raw));

beforeEach(() => {
  upstream.mockReset();
  upstream.mockResolvedValue(Response.json(clerkMetadata));
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe("MCP OAuth protected resource discovery", () => {
  it.each(["/oauth-protected-resource", "/oauth-protected-resource/mcp"])("publishes canonical MCP resource metadata at %s without calling Clerk", async (path) => {
    const response = await app().request(`https://sharpner.example/.well-known${path}`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: "https://sharpner.example/mcp",
      resource_name: "Sharpner",
      authorization_servers: [issuer],
      scopes_supported: identityScopes,
      bearer_methods_supported: ["header"],
      resource_documentation: "https://sharpner.example/",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses the deployment origin instead of accepting a resource override in the query", async () => {
    const response = await app().request("http://localhost:5199/.well-known/oauth-protected-resource/mcp?resource=https://other.example/mcp", {}, env);
    expect(await response.json()).toMatchObject({
      resource: "http://localhost:5199/mcp", resource_documentation: "http://localhost:5199/", authorization_servers: [issuer],
    });
  });

  it("returns an actionable 401 challenge that points the client at resource metadata", async () => {
    const response = await app().request("https://sharpner.example/mcp", { method: "POST", body: "{}" }, env);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://sharpner.example/.well-known/oauth-protected-resource/mcp", scope="openid profile email offline_access"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32001 } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-key", `pk_test_${btoa("other.example/path$")}`, `pk_live_${btoa("other.example:443$")}`])("fails unavailable discovery for invalid Clerk configuration %j", async (key) => {
    const response = await app().request("https://sharpner.example/.well-known/oauth-protected-resource/mcp", {}, { ...env, CLERK_PUBLISHABLE_KEY: key });
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty("error");
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("legacy authorization server metadata mirror", () => {
  it("fetches only the configured Clerk issuer and preserves its PKCE/client metadata capabilities", async () => {
    const response = await app().request("https://sharpner.example/.well-known/oauth-authorization-server", {}, env);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith(`${issuer}/.well-known/oauth-authorization-server`, { signal: expect.any(AbortSignal) });
    expect(await response.json()).toEqual(clerkMetadata);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("rejects metadata naming a different authorization server", async () => {
    upstream.mockResolvedValue(Response.json({ ...clerkMetadata, issuer: "https://different.example" }));
    const response = await app().request("https://sharpner.example/.well-known/oauth-authorization-server", {}, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Clerk OAuth issuer does not match this application" });
  });

  it("does not publish incomplete metadata when Clerk discovery is unavailable", async () => {
    upstream.mockResolvedValue(new Response("Unavailable", { status: 502 }));
    const response = await app().request("https://sharpner.example/.well-known/oauth-authorization-server", {}, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Clerk OAuth discovery is unavailable" });
  });

  it("reports failed upstream discovery without crashing the router", async () => {
    upstream.mockRejectedValue(new Error("Discovery request failed"));
    const response = await app().request("https://sharpner.example/.well-known/oauth-authorization-server", {}, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Discovery request failed" });
  });

  it("requires Clerk configuration before fetching authorization metadata", async () => {
    const response = await app().request("https://sharpner.example/.well-known/oauth-authorization-server", {}, { ...env, CLERK_PUBLISHABLE_KEY: "" });
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
});

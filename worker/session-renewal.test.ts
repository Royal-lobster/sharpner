import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), renewSession: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({
  ...await original<typeof import("./data")>(), fileFor: mocks.fileFor, room: () => ({ renewSession: mocks.renewSession }),
}));
vi.mock("./room", () => ({ FileRoom: class {} }));
vi.mock("./mcp", async () => ({ mcp: new (await import("hono")).Hono() }));
import app from "./index";

const user = { id: "member", name: "Member", login: "member", avatar_url: null };
const expiresAt = Date.now() + 60_000;
const identity = { user, sessionId: "session-member", sessionExpiresAt: expiresAt, method: "session" };
const env = {} as Env;
const request = (json: unknown = { cid: "connection" }, origin = "https://sharpner.example") => app.request("https://sharpner.example/api/files/file/session", {
  method: "POST", headers: { origin, "content-type": "application/json", authorization: "Bearer verified_fixture" }, body: JSON.stringify(json),
}, env);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue(identity);
  mocks.fileFor.mockResolvedValue({ id: "file" });
  mocks.renewSession.mockResolvedValue({ expiresAt });
});

describe("authenticated socket renewal", () => {
  it("uses only the freshly verified author, session and expiry, and never caches the result", async () => {
    const response = await request({ cid: "connection", sessionId: "forged", expiresAt: Date.now() + 1e10, user: "other" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ expiresAt });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.fileFor).toHaveBeenCalledWith(env, user.id, "file");
    expect(mocks.renewSession).toHaveBeenCalledWith("file", "connection", user.id, identity.sessionId, expiresAt);
  });

  it("does not renew after workspace access is removed", async () => {
    mocks.fileFor.mockResolvedValue(null);
    expect((await request()).status).toBe(404);
    expect(mocks.renewSession).not.toHaveBeenCalled();
  });

  it.each([null, { ...identity, sessionId: null }, { ...identity, sessionExpiresAt: 1 }])("rejects an absent or expired session: %j", async (value) => {
    mocks.authenticate.mockResolvedValue(value);
    expect((await request()).status).toBe(401);
    expect(mocks.renewSession).not.toHaveBeenCalled();
  });

  it("rejects cross-origin renewal before verifying credentials", async () => {
    expect((await request({}, "https://other.example")).status).toBe(403);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it.each([{ cid: "" }, { cid: 1 }, { cid: "x".repeat(129) }, {}])("rejects malformed connection identifiers: %j", async (json) => {
    expect((await request(json)).status).toBe(400);
    expect(mocks.renewSession).not.toHaveBeenCalled();
  });

  it("reports a socket that was already closed or belongs to a different session", async () => {
    mocks.renewSession.mockResolvedValue(null);
    expect((await request()).status).toBe(409);
  });
});

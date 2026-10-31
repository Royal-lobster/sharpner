import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), fileFor: vi.fn(), sharedFile: vi.fn(), roomFetch: vi.fn(), revokeViewers: vi.fn(), run: vi.fn(), first: vi.fn(),
}));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({
  ...await original<typeof import("./data")>(),
  fileFor: mocks.fileFor, sharedFile: mocks.sharedFile,
  room: () => ({ fetch: mocks.roomFetch, revokeViewers: mocks.revokeViewers }),
}));
vi.mock("./room", () => ({ FileRoom: class {} }));
vi.mock("./mcp", async () => ({ mcp: new (await import("hono")).Hono() }));

import app from "./index";
import { newShareToken } from "./data";

const token = "A".repeat(43);
const user = { id: "local_author", login: "alice", name: "Alice", avatar_url: null };
const file = { id: "file_design", workspace_id: "ws", name: "Screens", library_id: null, created_at: 1, updated_at: 1 };
const env = { DB: { prepare: () => ({ bind: () => ({ run: mocks.run, first: mocks.first }) }) } } as unknown as Env;
const upgrade = { headers: { upgrade: "websocket", origin: "https://sharpner.example" } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ user, workspaces: [], organizationId: null, method: "session", scopes: [], clerkUserId: "user_clerk", sessionExpiresAt: Date.now() + 60_000 });
  mocks.fileFor.mockResolvedValue(file);
  mocks.sharedFile.mockResolvedValue({ id: file.id, name: file.name, workspace: "Design" });
  mocks.roomFetch.mockResolvedValue(new Response(null, { status: 204 }));
});

describe("view links", () => {
  it("mints unguessable url-safe tokens", () => {
    const a = newShareToken(), b = newShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("opens a shared file without a session and reveals only names", async () => {
    const response = await app.request(`https://sharpner.example/api/shared/${token}`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ file: { id: file.id, name: file.name }, workspace: { name: "Design" } });
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("rejects malformed and unshared tokens", async () => {
    expect((await app.request("https://sharpner.example/api/shared/short", {}, env)).status).toBe(404);
    expect(mocks.sharedFile).not.toHaveBeenCalled();
    mocks.sharedFile.mockResolvedValue(null);
    expect((await app.request(`https://sharpner.example/api/shared/${token}`, {}, env)).status).toBe(404);
  });

  it("connects viewers as anonymous link viewers, ignoring a forged actor", async () => {
    await app.request(`https://sharpner.example/api/shared/${token}/ws`, { headers: { ...upgrade.headers, "x-actor": JSON.stringify({ id: "local_author" }), "x-session-id": "forged", "x-session-principal": "forged" } }, env);
    const forwarded = mocks.roomFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get("x-share-token")).toBe(token);
    expect(forwarded.headers.get("x-actor")).toBeNull();
    expect(forwarded.headers.get("x-session-id")).toBeNull();
    expect(forwarded.headers.get("x-session-principal")).toBeNull();
    expect(forwarded.headers.get("x-file")).toBe(file.id);
    expect(Number(forwarded.headers.get("x-session-expiry"))).toBeGreaterThan(Date.now());
  });

  it("refuses viewer sockets from other sites", async () => {
    const response = await app.request(`https://sharpner.example/api/shared/${token}/ws`, { headers: { upgrade: "websocket", origin: "https://evil.example" } }, env);
    expect(response.status).toBe(403);
    expect(mocks.roomFetch).not.toHaveBeenCalled();
  });

  it("never lets a member socket downgrade into a forged viewer token", async () => {
    await app.request(`https://sharpner.example/api/files/${file.id}/ws`, { headers: { ...upgrade.headers, authorization: "Bearer s", "x-share-token": token } }, env);
    const forwarded = mocks.roomFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get("x-share-token")).toBeNull();
    expect(JSON.parse(forwarded.headers.get("x-actor")!).id).toBe(user.id);
  });

  it("only members can share or unshare, and unsharing disconnects viewers", async () => {
    mocks.fileFor.mockResolvedValue(null);
    const denied = await app.request(`https://sharpner.example/api/files/${file.id}/share`, { method: "PUT", headers: { origin: "https://sharpner.example" } }, env);
    expect(denied.status).toBe(404);
    expect(mocks.run).not.toHaveBeenCalled();

    mocks.fileFor.mockResolvedValue(file);
    mocks.first.mockResolvedValue({ share_token: token });
    const shared = await app.request(`https://sharpner.example/api/files/${file.id}/share`, { method: "PUT", headers: { origin: "https://sharpner.example" } }, env);
    expect(await shared.json()).toEqual({ shareToken: token });

    const off = await app.request(`https://sharpner.example/api/files/${file.id}/share`, { method: "DELETE", headers: { origin: "https://sharpner.example" } }, env);
    expect(off.status).toBe(204);
    expect(mocks.revokeViewers).toHaveBeenCalledTimes(1);
  });
});

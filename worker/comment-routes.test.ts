import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), comment: vi.fn(), create: vi.fn(), reply: vi.fn(), resolve: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor,
  room: () => ({ comment: mocks.comment, createComment: mocks.create, replyComment: mocks.reply, resolveComment: mocks.resolve }),
}));
vi.mock("./room", () => ({ FileRoom: class {} }));
vi.mock("./thumbnail-queue", () => ({ ThumbnailQueue: class {} }));
vi.mock("./mcp", async () => ({ mcp: new (await import("hono")).Hono() }));
import app from "./index";

const user = { id: "alice", login: "alice", name: "Alice", avatar_url: null };
const actor = { id: user.id, name: user.name, avatar: user.avatar_url };
const anchor = { pageId: "page", nodeId: "screen", x: 12, y: 20 };
const env = {} as Env;
const request = (path: string, method = "GET", body?: unknown) => app.request(`https://sharpner.example/api/files/file/comments${path}`, {
  method, headers: { authorization: "Bearer session", "content-type": "application/json" },
  ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }),
}, env);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ user });
  mocks.fileFor.mockResolvedValue({ id: "file" });
  for (const fn of [mocks.comment, mocks.create, mocks.reply, mocks.resolve]) fn.mockResolvedValue({ id: "thread" });
});

describe("member comment routes", () => {
  it("attributes creation and replies to the verified member, ignoring forged author fields", async () => {
    expect((await request("", "POST", { anchor, body: "  Improve spacing  ", author: { id: "forged" } })).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("file", anchor, "Improve spacing", actor);
    expect((await request("/thread/replies", "POST", { body: "Thanks", author: { agent: true } })).status).toBe(200);
    expect(mocks.reply).toHaveBeenCalledWith("file", "thread", "Thanks", actor);
    expect((await request("/thread", "PATCH", { resolved: true })).status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith("file", "thread", true, actor);
    expect((await request("/thread")).status).toBe(200);
    expect(mocks.comment).toHaveBeenCalledWith("thread");
  });

  it.each([["", "POST"], ["/thread/replies", "POST"], ["/thread", "PATCH"], ["/thread", "GET"]])("requires file membership for %s %s", async (path, method) => {
    mocks.fileFor.mockResolvedValue(null);
    expect((await request(path!, method!, { anchor, body: "Feedback", resolved: true })).status).toBe(404);
    for (const fn of [mocks.comment, mocks.create, mocks.reply, mocks.resolve]) expect(fn).not.toHaveBeenCalled();
    expect(mocks.fileFor).toHaveBeenCalledWith(env, user.id, "file");
  });

  it("refuses unauthenticated reads and writes", async () => {
    mocks.authenticate.mockResolvedValue(null);
    expect((await request("/thread")).status).toBe(401);
    expect((await request("", "POST", { anchor, body: "Feedback" })).status).toBe(401);
    expect(mocks.fileFor).not.toHaveBeenCalled();
  });

  it.each([{ body: "" }, { body: "a".repeat(5001) }, { body: "Feedback", anchor: { ...anchor, x: "12" } }])("validates feedback before writing", async (patch) => {
    expect((await request("", "POST", { anchor, ...patch })).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("requires an explicit resolution boolean", async () => {
    expect((await request("/thread", "PATCH", { resolved: "false" })).status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});

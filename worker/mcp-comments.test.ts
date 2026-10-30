import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, CommentDetail, CommentThread } from "../shared/types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), comments: vi.fn(), comment: vi.fn(), create: vi.fn(), reply: vi.fn(), resolve: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor,
  room: () => ({ comments: mocks.comments, comment: mocks.comment, createComment: mocks.create, replyComment: mocks.reply, resolveComment: mocks.resolve,
    pages: async () => [{ id: "page", name: "Screens", sort: 0 }], nodes: async () => [] }),
}));
import { mcp } from "./mcp";

const user = { id: "alice", login: "alice", name: "Alice", avatar_url: null };
const actor: Actor = { id: "alice", name: "Alice's agent", avatar: null, agent: true };
const anchor = { pageId: "page", nodeId: null, x: 12, y: 20 };
const thread: CommentThread = { id: "thread", number: 1, anchor, firstMessage: { id: "message", author: { ...actor, agent: false, name: "Alice" }, body: "Please fix this", createdAt: 10 }, messageCount: 1, createdAt: 10, updatedAt: 10, resolvedAt: null, resolvedBy: null, revision: 1 };
const detail: CommentDetail = { ...thread, messages: [thread.firstMessage] };
let scopes: string[];

async function rpc(method: string, params: unknown) {
  const response = await mcp.request("https://sharpner.example/", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }, {} as Env);
  return await response.json() as { result?: { content: { type: string; text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: unknown };
}
const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

beforeEach(() => {
  vi.resetAllMocks(); scopes = ["sharpner:read", "sharpner:write"];
  mocks.authenticate.mockImplementation(async () => ({ user, method: "oauth", scopes }));
  mocks.fileFor.mockResolvedValue({ id: "file" });
  mocks.comments.mockResolvedValue([thread]); mocks.comment.mockResolvedValue(detail);
  for (const fn of [mocks.create, mocks.reply, mocks.resolve]) fn.mockResolvedValue(detail);
});

describe("agent comment tools", () => {
  it("advertises the complete feedback workflow", async () => {
    const response = await rpc("tools/list", {});
    expect(response.result?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["list_comments", "get_comment_thread", "add_comment", "reply_to_comment", "resolve_comment"]));
  });

  it("lists open feedback by default, filters and paginates, then reads full threads", async () => {
    mocks.comments.mockResolvedValue([thread, { ...thread, id: "resolved", resolvedAt: 20 }, { ...thread, id: "second" }]);
    const response = await call("list_comments", { fileId: "file", limit: 1 });
    const result = JSON.parse(response.result!.content[0]!.text);
    expect(result).toMatchObject({ total: 2, nextOffset: 1, threads: [{ id: "thread", pageName: "Screens", node: null }] });
    const resolved = await call("list_comments", { fileId: "file", status: "resolved", pageId: "page" });
    expect(JSON.parse(resolved.result!.content[0]!.text)).toMatchObject({ total: 1, nextOffset: null, threads: [{ id: "resolved" }] });
    const full = await call("get_comment_thread", { fileId: "file", threadId: "thread" });
    expect(JSON.parse(full.result!.content[0]!.text)).toEqual(detail);
  });

  it("creates, replies and resolves with explicit agent attribution", async () => {
    expect((await call("add_comment", { fileId: "file", anchor, body: "Feedback" })).result?.isError).not.toBe(true);
    expect(mocks.create).toHaveBeenCalledWith("file", anchor, "Feedback", actor);
    await call("reply_to_comment", { fileId: "file", threadId: "thread", body: "Fixed and checked." });
    expect(mocks.reply).toHaveBeenCalledWith("file", "thread", "Fixed and checked.", actor);
    await call("resolve_comment", { fileId: "file", threadId: "thread", resolved: false });
    expect(mocks.resolve).toHaveBeenCalledWith("file", "thread", false, actor);
  });

  it("allows read-only connections to read feedback and blocks every comment mutation", async () => {
    scopes = ["sharpner:read"];
    expect((await call("list_comments", { fileId: "file" })).result?.isError).not.toBe(true);
    for (const [name, args] of [
      ["add_comment", { fileId: "file", anchor, body: "Feedback" }],
      ["reply_to_comment", { fileId: "file", threadId: "thread", body: "Feedback" }],
      ["resolve_comment", { fileId: "file", threadId: "thread", resolved: true }],
    ] as const) expect((await call(name, args)).result?.isError).toBe(true);
    for (const fn of [mocks.create, mocks.reply, mocks.resolve]) expect(fn).not.toHaveBeenCalled();
  });

  it("never reads or mutates feedback in an inaccessible file", async () => {
    mocks.fileFor.mockResolvedValue(null);
    expect((await call("list_comments", { fileId: "other-file" })).result?.isError).toBe(true);
    expect((await call("get_comment_thread", { fileId: "other-file", threadId: "thread" })).result?.isError).toBe(true);
    expect((await call("reply_to_comment", { fileId: "other-file", threadId: "thread", body: "Feedback" })).result?.isError).toBe(true);
    for (const fn of [mocks.comments, mocks.comment, mocks.reply]) expect(fn).not.toHaveBeenCalled();
  });
});

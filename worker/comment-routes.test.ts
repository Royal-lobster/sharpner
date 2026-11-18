import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), comment: vi.fn(), create: vi.fn(), reply: vi.fn(), resolve: vi.fn(),
  commentLocation: vi.fn(), approve: vi.fn(), resolveMentions: vi.fn(), deliverMentions: vi.fn(), workspaceMembers: vi.fn(), listNotifications: vi.fn(), markRead: vi.fn(),
  workspaceFor: vi.fn(), deleteThread: vi.fn(), deleteReply: vi.fn(), forgetMentions: vi.fn() }));
vi.mock("./notifications", async (original) => ({ ...await original<typeof import("./notifications")>(),
  resolveMentions: mocks.resolveMentions, deliverMentions: mocks.deliverMentions, workspaceMembers: mocks.workspaceMembers,
  listNotifications: mocks.listNotifications, markNotificationsRead: mocks.markRead, forgetMentions: mocks.forgetMentions }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor, workspaceFor: mocks.workspaceFor,
  room: () => ({ commentLocation: mocks.commentLocation, comment: mocks.comment, createComment: mocks.create, replyComment: mocks.reply, resolveComment: mocks.resolve,
    deleteComment: mocks.deleteThread, deleteCommentReply: mocks.deleteReply, approve: mocks.approve }),
}));
vi.mock("./room", () => ({ FileRoom: class {} }));
vi.mock("./thumbnail-queue", () => ({ ThumbnailQueue: class {} }));
vi.mock("./mcp", async () => ({ mcp: new (await import("hono")).Hono() }));
import app from "./index";

const user = { id: "alice", login: "alice", name: "Alice", avatar_url: null };
const actor = { id: user.id, name: user.name, avatar: user.avatar_url };
const anchor = { pageId: "page", nodeId: "screen", x: 12, y: 20 };
const env = {} as Env;
const jobs: Promise<unknown>[] = [];
const ctx = { waitUntil: (job: Promise<unknown>) => { jobs.push(job); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const api = (path: string, method = "GET", body?: unknown) => app.request(`https://sharpner.example/api${path}`, {
  method, headers: { authorization: "Bearer session", "content-type": "application/json" },
  ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }),
}, env, ctx);
const request = (path: string, method = "GET", body?: unknown) => api(`/files/file/comments${path}`, method, body);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ user });
  jobs.length = 0;
  mocks.fileFor.mockResolvedValue({ id: "file", name: "App", workspace_id: "acme" });
  mocks.resolveMentions.mockResolvedValue([]);
  for (const fn of [mocks.comment, mocks.create, mocks.reply, mocks.resolve]) fn.mockResolvedValue({ id: "thread" });
});

describe("member comment routes", () => {
  it("attributes creation and replies to the verified member, ignoring forged author fields", async () => {
    expect((await request("", "POST", { anchor, body: "  Improve spacing  ", author: { id: "forged" } })).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("file", anchor, "Improve spacing", actor, []);
    expect((await request("/thread/replies", "POST", { body: "Thanks", author: { agent: true } })).status).toBe(200);
    expect(mocks.reply).toHaveBeenCalledWith("file", "thread", "Thanks", actor, []);
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

describe("deleting comments", () => {
  const msg = (id: string, author: { id: string; agent?: boolean }) => ({ id, author: { name: id, avatar: null, ...author }, body: "x", createdAt: 0 });
  const thread = { id: "thread", messages: [msg("m1", { id: "alice" }), msg("m2", { id: "bob" }), msg("m3", { id: "alice", agent: true })] };
  beforeEach(() => {
    mocks.comment.mockResolvedValue(thread);
    mocks.workspaceFor.mockResolvedValue({ id: "acme", role: "member" });
    mocks.deleteReply.mockResolvedValue({ id: "thread", messages: [] });
  });

  it("lets the author delete their thread and forgets its mention notifications", async () => {
    expect((await request("/thread", "DELETE")).status).toBe(204);
    expect(mocks.deleteThread).toHaveBeenCalledWith("file", "thread", actor, false);
    expect(mocks.forgetMentions).toHaveBeenCalledWith(env, "file", "thread");
  });

  it("lets a member delete their agent's reply, and forgets that reply's notifications", async () => {
    expect((await request("/thread/messages/m3", "DELETE")).status).toBe(200);
    expect(mocks.deleteReply).toHaveBeenCalledWith("file", "thread", "m3", actor, false);
    expect(mocks.forgetMentions).toHaveBeenCalledWith(env, "file", "thread", "m3");
  });

  it("refuses a member deleting someone else's thread or reply", async () => {
    mocks.comment.mockResolvedValue({ ...thread, messages: [msg("m1", { id: "bob" }), msg("m2", { id: "bob" })] });
    const thread403 = await request("/thread", "DELETE");
    expect(thread403.status).toBe(403);
    expect(await thread403.json()).toEqual({ error: "Only its author or a workspace owner can delete this comment" });
    expect((await request("/thread/messages/m2", "DELETE")).status).toBe(403);
    expect(mocks.deleteThread).not.toHaveBeenCalled();
    expect(mocks.deleteReply).not.toHaveBeenCalled();
    expect(mocks.forgetMentions).not.toHaveBeenCalled();
  });

  it("lets a workspace owner delete anyone's comment", async () => {
    mocks.workspaceFor.mockResolvedValue({ id: "acme", role: "owner" });
    mocks.comment.mockResolvedValue({ ...thread, messages: [msg("m1", { id: "bob" }), msg("m2", { id: "bob" })] });
    expect((await request("/thread/messages/m2", "DELETE")).status).toBe(200);
    expect((await request("/thread", "DELETE")).status).toBe(204);
    expect(mocks.deleteThread).toHaveBeenCalledWith("file", "thread", actor, true);
  });

  it("returns 404 for an unknown thread or reply, and for a file outside the member's workspaces", async () => {
    mocks.comment.mockRejectedValue(new Error("Comment thread not found"));
    expect((await request("/gone", "DELETE")).status).toBe(404);
    mocks.comment.mockResolvedValue(thread);
    expect((await request("/thread/messages/missing", "DELETE")).status).toBe(404);
    mocks.fileFor.mockResolvedValue(null);
    expect((await request("/thread", "DELETE")).status).toBe(404);
    expect(mocks.deleteThread).not.toHaveBeenCalled();
    expect(mocks.deleteReply).not.toHaveBeenCalled();
  });
});

describe("mentions", () => {
  const bob = { id: "bob", name: "Bob", avatar: null, email: "bob@example.com" };
  const posted = { id: "thread", number: 3, anchor, messages: [{ id: "m1", author: actor, body: "@Bob look", createdAt: 5, mentions: [{ id: "bob", name: "Bob", avatar: null }] }] };

  it("tags only members of the file's workspace and notifies them after responding", async () => {
    mocks.resolveMentions.mockResolvedValue([bob]);
    mocks.create.mockResolvedValue(posted);
    expect((await request("", "POST", { anchor, body: "@Bob look", mentions: ["bob", "outsider"] })).status).toBe(201);
    expect(mocks.resolveMentions).toHaveBeenCalledWith(env, "acme", ["bob", "outsider"]);
    expect(mocks.create).toHaveBeenCalledWith("file", anchor, "@Bob look", actor, [{ id: "bob", name: "Bob", avatar: null }]);
    expect(jobs).toHaveLength(1);
    expect(mocks.deliverMentions).toHaveBeenCalledWith(env, {
      workspaceId: "acme", file: expect.objectContaining({ id: "file", name: "App" }), origin: "https://sharpner.example",
      thread: { id: "thread", number: 3, pageId: "page" }, message: posted.messages[0],
    }, [bob], expect.any(Function));
  });

  it("notifies from replies too, and does nothing without tags", async () => {
    mocks.reply.mockResolvedValue(posted);
    expect((await request("/thread/replies", "POST", { body: "No tags" })).status).toBe(200);
    expect(jobs).toHaveLength(0);
    mocks.resolveMentions.mockResolvedValue([bob]);
    expect((await request("/thread/replies", "POST", { body: "@Bob look", mentions: ["bob"] })).status).toBe(200);
    expect(mocks.deliverMentions).toHaveBeenCalledOnce();
  });

  it("rejects malformed or excessive mention lists before writing", async () => {
    expect((await request("", "POST", { anchor, body: "Hi", mentions: "bob" })).status).toBe(400);
    expect((await request("", "POST", { anchor, body: "Hi", mentions: Array.from({ length: 21 }, (_, i) => `m${i}`) })).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("lists taggable members only for a member of the file", async () => {
    mocks.workspaceMembers.mockResolvedValue([{ id: "bob", name: "Bob", login: "bob", avatar: null }]);
    const ok = await api("/files/file/members");
    expect(await ok.json()).toEqual({ members: [{ id: "bob", name: "Bob", login: "bob", avatar: null }] });
    expect(mocks.workspaceMembers).toHaveBeenCalledWith(env, "acme");
    mocks.fileFor.mockResolvedValue(null);
    expect((await api("/files/file/members")).status).toBe(404);
  });
});

describe("notification inbox", () => {
  it("reads and marks the signed-in member's own notifications", async () => {
    mocks.listNotifications.mockResolvedValue({ notifications: [], unread: 0 });
    expect(await (await api("/notifications")).json()).toEqual({ notifications: [], unread: 0 });
    expect(mocks.listNotifications).toHaveBeenCalledWith(env, "alice");
    expect((await api("/notifications/read", "POST", { threadId: "thread", userId: "bob" })).status).toBe(204);
    expect(mocks.markRead).toHaveBeenCalledWith(env, "alice", { threadId: "thread" });
  });

  it("refuses anonymous requests and malformed read targets", async () => {
    expect((await api("/notifications/read", "POST", { ids: "all" })).status).toBe(400);
    mocks.authenticate.mockResolvedValue(null);
    expect((await api("/notifications")).status).toBe(401);
    expect(mocks.listNotifications).not.toHaveBeenCalled();
    expect(mocks.markRead).not.toHaveBeenCalled();
  });
});

describe("member approval route", () => {
  const approve = (body: unknown) => api("/files/file/nodes/screen/approval", "PATCH", body);

  it("approves and withdraws as the verified member, ignoring forged approvers", async () => {
    mocks.approve.mockResolvedValue([{ nodeId: "screen", approvedAt: 5, approvedBy: actor }]);
    const response = await approve({ approved: true, approvedBy: { id: "forged", agent: true } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ approval: { nodeId: "screen", approvedAt: 5, approvedBy: actor } });
    expect(mocks.approve).toHaveBeenCalledWith("file", ["screen"], true, actor);
    mocks.approve.mockResolvedValue([]);
    expect(await (await approve({ approved: false })).json()).toEqual({ approval: null });
    expect(mocks.approve).toHaveBeenLastCalledWith("file", ["screen"], false, actor);
  });

  it("rejects non-members, signed-out requests and malformed bodies without touching the file", async () => {
    mocks.fileFor.mockResolvedValue(null);
    expect((await approve({ approved: true })).status).toBe(404);
    mocks.fileFor.mockResolvedValue({ id: "file", name: "App", workspace_id: "acme" });
    expect((await approve({ approved: "yes" })).status).toBe(400);
    mocks.authenticate.mockResolvedValue(null);
    expect((await approve({ approved: true })).status).toBe(401);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("reports a room refusal, such as approving a component", async () => {
    mocks.approve.mockRejectedValue(new Error("Only frames can be approved; Button is a component"));
    const response = await approve({ approved: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Only frames can be approved; Button is a component" });
  });
});

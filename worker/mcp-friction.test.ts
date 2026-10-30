import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), report: vi.fn(), list: vi.fn(), reports: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor, room: () => ({}) }));
vi.mock("./friction", async (original) => ({ ...await original<typeof import("./friction")>(),
  reportFriction: mocks.report, listFriction: mocks.list, frictionReports: mocks.reports }));
import { mcp } from "./mcp";

const user = { id: "alice", login: "alice", name: "Alice", avatar_url: null };
let scopes: string[];

async function call(name: string, args: unknown) {
  const list = name === "tools/list";
  const response = await mcp.request("https://sharpner.example/", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: list ? name : "tools/call", params: list ? {} : { name, arguments: args } }),
  }, {} as Env);
  const { result } = await response.json() as { result: { content: { text: string }[]; isError?: boolean; tools?: { name: string; description: string }[] } };
  return { ...result, value: result.content?.[0] && !result.isError ? JSON.parse(result.content[0].text) : undefined };
}

beforeEach(() => {
  vi.resetAllMocks(); scopes = ["sharpner:read", "sharpner:write"];
  mocks.authenticate.mockImplementation(async () => ({ user, method: "oauth", scopes }));
  mocks.fileFor.mockImplementation(async (_env: Env, _user: string, id: string) => id === "app" ? { id, workspace_id: "acme", name: "App", library_id: null } : null);
  mocks.report.mockResolvedValue({ id: "r1", issueId: "r1" });
  mocks.list.mockResolvedValue({ total: 0, nextOffset: null, issues: [] });
  mocks.reports.mockResolvedValue([]);
});

describe("agent friction tools", () => {
  it("advertises the complaint box and points agents at it from the instructions", async () => {
    const tools = (await call("tools/list", {})).tools!;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["report_friction", "list_friction"]));
    const initialize = await mcp.request("https://sharpner.example/", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    }, {} as Env);
    expect(JSON.stringify(await initialize.json())).toContain("report_friction");
  });

  it("files a report under the file's workspace, or privately without a file, for read-only agents too", async () => {
    scopes = ["sharpner:read"];
    await call("report_friction", { summary: "get_file overflows", severity: "major", fileId: "app", tool: "get_file", agent: "Claude Code" });
    expect(mocks.report).toHaveBeenLastCalledWith(expect.anything(), { summary: "get_file overflows", severity: "major", tool: "get_file", agent: "Claude Code",
      userId: "alice", workspaceId: "acme", fileId: "app" });
    await call("report_friction", { summary: "Same", severity: "minor", sameAs: "r1" });
    expect(mocks.report).toHaveBeenLastCalledWith(expect.anything(), { summary: "Same", severity: "minor", sameAs: "r1", userId: "alice", workspaceId: null, fileId: null });
    expect((await call("report_friction", { summary: "Elsewhere", severity: "minor", fileId: "secret" })).isError).toBe(true);
    expect((await call("report_friction", { summary: "Bad", severity: "catastrophic" })).isError).toBe(true);
    expect(mocks.report).toHaveBeenCalledTimes(2);
  });

  it("lists the heaviest issues, or one issue's reports", async () => {
    expect((await call("list_friction", {})).value).toEqual({ total: 0, nextOffset: null, issues: [] });
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), "alice", 20, 0);
    expect((await call("list_friction", { issueId: "r1" })).value).toEqual({ issueId: "r1", reports: [] });
    expect(mocks.reports).toHaveBeenCalledWith(expect.anything(), "alice", "r1");
  });
});

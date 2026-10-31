import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CallToolResult, InitializeResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(),
  authenticate: async () => ({ user: { id: "alice", name: "Alice", login: "alice", avatar_url: null },
    method: "oauth", scopes: ["sharpner:read"] }),
}));
import { mcp } from "./mcp";

async function rpc<T>(method: string, params: unknown, browser = false) {
  const response = await mcp.request("https://sharpner.example/", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }, (browser ? { BROWSER: {} } : {}) as Env);
  expect(response.status).toBe(200);
  const message = await response.json() as { result: T; error?: unknown };
  expect(message.error).toBeUndefined();
  return message.result;
}

describe("MCP discovery context budget", () => {
  it("keeps startup instructions small and points to the skill", async () => {
    const { instructions } = await rpc<InitializeResult>("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
    });
    expect(instructions).toContain("get_app_state");
    expect(instructions).toContain("read_skill()");
    // Character and byte budgets avoid adding a tokenizer dependency to the project.
    // Keep discovery small even in clients that eagerly load every MCP definition.
    expect(instructions!.length).toBeLessThanOrEqual(400);
  });

  it("bounds the full advertised catalog, including optional screenshots", async () => {
    const listing = await rpc<ListToolsResult>("tools/list", {}, true);
    expect(listing.tools.some((tool) => tool.name === "screenshot_nodes")).toBe(true);
    expect(listing.tools.some((tool) => tool.name === "rename_page")).toBe(false);
    expect(listing.tools.some((tool) => tool.name === "read_guide")).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(listing)).byteLength).toBeLessThanOrEqual(17_500);
    for (const tool of listing.tools) {
      expect(tool.description?.length ?? 0, tool.name).toBeLessThanOrEqual(300);
    }
  });

  it("returns SKILL.md by default and serves each linked reference on request for read-only agents", async () => {
    const { tools } = await rpc<ListToolsResult>("tools/list", {});
    const reader = tools.find((tool) => tool.name === "read_skill")!;
    expect(reader.annotations?.readOnlyHint).toBe(true);
    const root = await rpc<CallToolResult>("tools/call", { name: "read_skill", arguments: {} });
    expect(root.isError).not.toBe(true);
    const block = root.content[0];
    if (block?.type !== "text") throw new Error("Expected skill text");
    expect(block.text).toBe(readFileSync(new URL("./skills/sharpner/SKILL.md", import.meta.url), "utf8"));
    const paths = [...block.text.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(0);
    expect(reader.inputSchema.properties?.path).toMatchObject({ default: "SKILL.md", enum: expect.arrayContaining(["SKILL.md", ...paths]) });

    for (const path of ["SKILL.md", ...paths]) {
      const result = await rpc<CallToolResult>("tools/call", { name: "read_skill", arguments: { path } });
      const text = readFileSync(new URL("./skills/sharpner/" + path, import.meta.url), "utf8");
      expect(result.isError, path).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text }]);
      expect(JSON.stringify(reader)).not.toContain(text);
      if (path !== "SKILL.md") expect(block.text).not.toContain(text);
    }
  });

  it("rejects paths outside the skill's published files", async () => {
    for (const path of ["references/missing.md", "../SKILL.md", "../../CONTEXT.md"]) {
      const result = await rpc<CallToolResult>("tools/call", { name: "read_skill", arguments: { path } });
      expect(result.isError, path).toBe(true);
    }
  });
});

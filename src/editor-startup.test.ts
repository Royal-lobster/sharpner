import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ changes: [] as unknown[], cleanup: null as (() => void) | null, api: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  // Exercise Editor's real asynchronous bootstrap effect without mounting its canvas UI.
  useState: (value: unknown) => [value, (next: unknown) => state.changes.push(next)],
  useEffect: (effect: () => (() => void) | void) => { state.cleanup = effect() ?? null; },
}));
vi.mock("@clerk/react", async (original) => ({
  ...await original<typeof import("@clerk/react")>(),
  useAuth: () => ({ userId: "clerk-person", sessionId: "sdk-session", orgId: "org-one" }),
  useClerk: () => ({ setActive: vi.fn() }),
}));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), api: state.api }));

import { Editor } from "./Editor";
import { cancelFileStartup } from "./file-startup";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  close = vi.fn(() => { this.readyState = 3; });
  constructor() { Socket.instances.push(this); }
  send() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  state.changes = []; state.cleanup = null; Socket.instances = [];
  vi.stubGlobal("location", { protocol: "https:", host: "sharpner.example" });
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => { state.cleanup?.(); cancelFileStartup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("waits for socket identity before exposing legacy metadata on the regular startup path", async () => {
  const metadata = {
    user: { id: "legacy-author", name: "Member", login: "member", avatar_url: null },
    file: { id: "file-one", name: "Private file", workspace_id: "workspace-one", library_id: null },
    workspace: { id: "workspace-one", clerkOrganizationId: "org-one", name: "Workspace", role: "owner" },
    files: [], shareToken: null,
  };
  state.api.mockResolvedValue(metadata);
  Editor({ fileId: "file-one" });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.changes).not.toContain(metadata);
  expect(state.changes.filter((value) => value && typeof value === "object")).toEqual([]);

  const socket = Socket.instances[0]!;
  socket.onmessage?.({ data: JSON.stringify({
    type: "init", cid: "connection", pages: [], nodes: [], peers: [], library: null,
    principal: { clerkUserId: "clerk-person", sessionId: "different-session", organizationId: "org-one" },
    sessionExpiresAt: Date.now() + 60_000,
  }) });
  expect(state.changes).toContain("Your session changed. Reload this file to continue.");
  expect(state.changes).not.toContain(metadata);
  expect(socket.close).toHaveBeenCalledOnce();
});

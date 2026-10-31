import { Hono } from "hono";
import { renderPrototype } from "./render.prototype";
import { auth, authenticate, authErrorStatus, clerkClient, sessionPrincipal, type AppEnv } from "./auth";
import { serveAsset, servePreviewBatch } from "./assets";
import { createFile, fileFor, MAX_UPLOAD, newShareToken, putFile, room, setLibrary, sharedFile, workspaceFiles, workspaceFor } from "./data";
import { mcp } from "./mcp";
import { oauth } from "./oauth";
import { newComment, commentReply, commentResolution } from "./comment-schema";

export { FileRoom } from "./room";
export { ThumbnailQueue } from "./thumbnail-queue";

const app = new Hono<AppEnv>();

if (import.meta.env.DEV || import.meta.env.VITE_RENDER_EXPERIMENT === "1") app.route("/api/render-prototype", renderPrototype);
app.route("/auth", auth);
app.route("/mcp", mcp);
app.route("/.well-known", oauth);
app.onError((err, c) => c.json({ error: err.message }, authErrorStatus(err) ?? 500));

// ---- view-only links: the token is the only credential ------------------------

/** Lease for a link viewer's socket; the client reconnects (and the token is rechecked) when it lapses. */
const VIEWER_LEASE_MS = 60 * 60 * 1000;
const validToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);

app.get("/api/shared/:token", async (c) => {
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  const token = c.req.param("token");
  const file = validToken(token) ? await sharedFile(c.env, token) : null;
  if (!file) return c.json({ error: "This link is no longer shared" }, 404);
  return c.json({ file: { id: file.id, name: file.name }, workspace: { name: file.workspace } });
});

app.get("/api/shared/:token/ws", async (c) => {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "bad origin" }, 403);
  const token = c.req.param("token");
  const file = validToken(token) ? await sharedFile(c.env, token) : null;
  if (!file) return c.json({ error: "This link is no longer shared" }, 404);
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-file", file.id);
  headers.set("x-origin", new URL(c.req.url).origin);
  headers.delete("x-actor");
  headers.delete("x-session-principal");
  headers.delete("x-session-id");
  headers.set("x-share-token", token);
  headers.set("x-session-expiry", String(Date.now() + VIEWER_LEASE_MS));
  return room(c.env, file.id).fetch(new Request(c.req.url, { headers }));
});

// ---- everything else under /api needs a browser session ---------------------

const api = new Hono<AppEnv>();

api.use(async (c, next) => {
  c.header("cache-control", "no-store");
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "bad origin" }, 403);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !origin && !/^Bearer\s+/i.test(c.req.header("authorization") ?? "")) {
    return c.json({ error: "Same-origin request or session bearer token required" }, 403);
  }
  const identity = await authenticate(c.env, c.req.raw, "session");
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  c.set("identity", identity);
  c.set("user", identity.user);
  await next();
});

api.onError((err, c) => c.json({ error: err.message }, authErrorStatus(err) ?? 400));

api.get("/me", async (c) => {
  const { user, workspaces, organizationId } = c.get("identity");
  const active = workspaces.find((w) => w.clerkOrganizationId === organizationId);
  const files = active ? await workspaceFiles(c.env, active.id) : [];
  return c.json({ user, workspaces, activeWorkspaceId: active?.id ?? null, files });
});

// Workspaces are Clerk Organizations; creation, invitations and membership live in Clerk.

api.get("/workspaces/:id", async (c) => {
  const workspace = await workspaceFor(c.env, c.get("user").id, c.req.param("id"));
  if (!workspace) return c.json({ error: "not found" }, 404);
  const files = await workspaceFiles(c.env, workspace.id);
  return c.json({ workspace, files });
});

// Files

api.post("/workspaces/:id/files", async (c) => {
  const workspace = await workspaceFor(c.env, c.get("user").id, c.req.param("id"));
  if (!workspace) return c.json({ error: "not found" }, 404);
  const { name, libraryId } = await c.req.json<{ name: string; libraryId?: string | null }>();
  return c.json(await createFile(c.env, c.get("user").id, workspace.id, name ?? "", libraryId ?? null));
});

api.get("/files/:id", async (c) => {
  const file = await fileFor(c.env, c.get("user").id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  const [workspace, others, share] = await Promise.all([
    workspaceFor(c.env, c.get("user").id, file.workspace_id),
    c.env.DB.prepare(`SELECT id, name FROM files WHERE workspace_id = ? AND id != ? ORDER BY name`).bind(file.workspace_id, file.id).all<{ id: string; name: string }>(),
    c.env.DB.prepare(`SELECT share_token FROM files WHERE id = ?`).bind(file.id).first<{ share_token: string | null }>(),
  ]);
  // Other files in the workspace are the candidates for this file's library.
  return c.json({ user: c.get("user"), file, workspace, files: others.results, shareToken: share?.share_token ?? null,
    principal: sessionPrincipal(c.get("identity")), sessionExpiresAt: c.get("identity").sessionExpiresAt });
});

api.patch("/files/:id", async (c) => {
  const file = await fileFor(c.env, c.get("user").id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ name?: string; libraryId?: string | null }>();
  if (body.name !== undefined) {
    await c.env.DB.prepare(`UPDATE files SET name = ? WHERE id = ?`).bind(body.name.trim().slice(0, 120) || file.name, file.id).run();
  }
  if (body.libraryId !== undefined) await setLibrary(c.env, file, body.libraryId);
  return c.body(null, 204);
});

api.delete("/files/:id", async (c) => {
  const file = await fileFor(c.env, c.get("user").id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  const dependents = await c.env.DB.prepare(`SELECT id FROM files WHERE library_id = ?`).bind(file.id).all<{ id: string }>();
  await room(c.env, file.id).destroy(file.id);
  await c.env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(file.id).run();
  // Files that used it as their library fall back to their own design system.
  await Promise.all(dependents.results.map((d) => room(c.env, d.id).setLibrary(d.id, null)));
  return c.body(null, 204);
});

/** Turns on view-only link sharing (or returns the current link). Any member may share. */
api.put("/files/:id/share", async (c) => {
  const file = await fileFor(c.env, c.get("user").id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  const token = newShareToken();
  await c.env.DB.prepare(`UPDATE files SET share_token = COALESCE(share_token, ?) WHERE id = ?`).bind(token, file.id).run();
  const row = await c.env.DB.prepare(`SELECT share_token FROM files WHERE id = ?`).bind(file.id).first<{ share_token: string }>();
  return c.json({ shareToken: row!.share_token });
});

/** Turns link sharing off: the old link stops working and open viewers are disconnected. */
api.delete("/files/:id/share", async (c) => {
  const file = await fileFor(c.env, c.get("user").id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare(`UPDATE files SET share_token = NULL WHERE id = ?`).bind(file.id).run();
  await room(c.env, file.id).revokeViewers();
  return c.body(null, 204);
});

// Comments are workspace feedback. Public view links never expose them.
api.get("/files/:id/comments/:threadId", async (c) => {
  const file = await fileFor(c.env, c.get("user").id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  return c.json(await room(c.env, file.id).comment(c.req.param("threadId")));
});

api.post("/files/:id/comments", async (c) => {
  const user = c.get("user");
  const file = await fileFor(c.env, user.id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  const { anchor, body } = newComment.parse(await c.req.json());
  return c.json(await room(c.env, file.id).createComment(file.id, anchor, body, { id: user.id, name: user.name, avatar: user.avatar_url }), 201);
});

api.post("/files/:id/comments/:threadId/replies", async (c) => {
  const user = c.get("user");
  const file = await fileFor(c.env, user.id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  const { body } = commentReply.parse(await c.req.json());
  return c.json(await room(c.env, file.id).replyComment(file.id, c.req.param("threadId"), body, { id: user.id, name: user.name, avatar: user.avatar_url }));
});

api.patch("/files/:id/comments/:threadId", async (c) => {
  const user = c.get("user");
  const file = await fileFor(c.env, user.id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  const { resolved } = commentResolution.parse(await c.req.json());
  return c.json(await room(c.env, file.id).resolveComment(file.id, c.req.param("threadId"), resolved, { id: user.id, name: user.name, avatar: user.avatar_url }));
});

/** Renew an existing connection with a freshly verified session and current file access. */
api.post("/files/:id/session", async (c) => {
  const { user, sessionExpiresAt, sessionId } = c.get("identity");
  if (!sessionId || typeof sessionExpiresAt !== "number" || !Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now()) {
    return c.json({ error: "A current Clerk session is required" }, 401);
  }
  const { cid } = await c.req.json<{ cid?: unknown }>();
  if (typeof cid !== "string" || !cid || cid.length > 128) return c.json({ error: "Invalid connection" }, 400);
  const file = await fileFor(c.env, user.id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  const lease = await room(c.env, file.id).renewSession(file.id, cid, user.id, sessionId, sessionExpiresAt);
  return lease ? c.json(lease) : c.json({ error: "Connection is no longer current" }, 409);
});

/** Upgrades to the file's realtime WebSocket. */
api.get("/files/:id/ws", async (c) => {
  const user = c.get("user");
  const { sessionExpiresAt } = c.get("identity");
  if (typeof sessionExpiresAt !== "number" || !Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now()) {
    return c.json({ error: "A current Clerk session is required" }, 401);
  }
  // Browsers always send Origin on WebSocket upgrades; refuse other sites riding the session cookie.
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "bad origin" }, 403);
  const file = await fileFor(c.env, user.id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare(`UPDATE users SET last_file_id = ? WHERE id = ?`).bind(file.id, user.id).run();
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-share-token");
  headers.set("x-file", file.id);
  headers.set("x-origin", new URL(c.req.url).origin);
  headers.set("x-actor", JSON.stringify({ id: user.id, name: user.name, avatar: user.avatar_url }));
  // Never trust a client-supplied lease: only the verified JWT sets its lifetime.
  headers.set("x-session-expiry", String(sessionExpiresAt));
  // Bind renewal to this exact verified Clerk session, never a caller-supplied header.
  headers.delete("x-session-id");
  if (c.get("identity").sessionId) headers.set("x-session-id", c.get("identity").sessionId!);
  // This internal header is always replaced, including when no principal can be issued.
  headers.delete("x-session-principal");
  const principal = sessionPrincipal(c.get("identity"));
  if (principal) headers.set("x-session-principal", JSON.stringify(principal));
  return room(c.env, file.id).fetch(new Request(c.req.url, { headers }));
});

/** Uploads an image (and an optional low-res preview made in the browser) to R2. */
api.post("/files/:id/assets", async (c) => {
  const file = await fileFor(c.env, c.get("user").id, c.req.param("id"));
  if (!file) return c.json({ error: "not found" }, 404);
  const form = await c.req.formData();
  const urls: Record<string, string> = {};
  for (const field of ["file", "preview"]) {
    const upload = form.get(field);
    if (!(upload instanceof File)) continue;
    if (!upload.type.startsWith("image/")) return c.json({ error: "Only images can be uploaded" }, 400);
    if (upload.size > MAX_UPLOAD) return c.json({ error: "Images must be under 25 MB" }, 413);
    urls[field] = await putFile(c.env, file.id, await upload.arrayBuffer(), upload.type);
  }
  if (!urls.file) return c.json({ error: "Missing file" }, 400);
  return c.json({ src: urls.file, preview: urls.preview ?? urls.file });
});

// Optional agent keys are Clerk user-scoped keys. OAuth is the primary MCP connection.

api.get("/keys", async (c) => {
  const result = await clerkClient(c.env).apiKeys.list({ subject: c.get("identity").clerkUserId, limit: 100 });
  return c.json(result.data.filter((k) => !k.revoked && !k.expired).map((k) => ({
    id: k.id, name: k.name, scopes: k.scopes, expiration: k.expiration,
    created_at: k.createdAt, last_used_at: k.lastUsedAt,
  })));
});

api.post("/keys", async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  const userId = c.get("identity").clerkUserId;
  const key = await clerkClient(c.env).apiKeys.create({
    name: name?.trim().slice(0, 80) || "My agent", subject: userId, createdBy: userId,
    scopes: ["sharpner:read", "sharpner:write"], secondsUntilExpiration: 90 * 24 * 60 * 60,
  });
  if (!key.secret) throw new Error("Clerk did not return an agent key");
  return c.json({ key: key.secret });
});

api.delete("/keys/:id", async (c) => {
  const client = clerkClient(c.env);
  const key = await client.apiKeys.get(c.req.param("id"));
  if (key.subject !== c.get("identity").clerkUserId) return c.json({ error: "not found" }, 404);
  await client.apiKeys.revoke({ apiKeyId: key.id, revocationReason: "Revoked by member" });
  return c.body(null, 204);
});

app.route("/api", api);

// Uploaded images and thumbnails. Keys contain random ids, so URLs work as capabilities and cache forever.
const ASSET_CACHE = "immutable-assets-v4";
app.get("/a/:fileId/bundle", async (c) => servePreviewBatch(c.req.raw, c.req.param("fileId"), c.env.FILES, await caches.open(ASSET_CACHE), c.executionCtx));
app.get("/a/*", async (c) => serveAsset(c.req.raw, c.env.FILES, await caches.open(ASSET_CACHE), c.executionCtx));

export default app satisfies ExportedHandler<Env>;

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authenticate, authErrorStatus, requireScope, type AppEnv, type Identity } from "./auth";
import { oauthChallenge } from "./oauth";
import { createFile, fileFor, filesFor, MAX_UPLOAD, putFile, room, setLibrary, workspaceFor, workspacesFor } from "./data";
import { layoutHeight, layoutRects, pageArrangement, union, type Rect } from "../shared/layout";
import { componentTag, DESCRIPTION_MAX, tokenNames, type Actor, type CanvasNode, type NodeInput, type Op, type Page } from "../shared/types";
import { effectiveTheme, themeNames } from "../shared/themes";
import skill from "./skills/sharpner/SKILL.md?raw";
import designSystemGuide from "./skills/sharpner/references/design-system.md?raw";
import screensGuide from "./skills/sharpner/references/screens.md?raw";
import { commentAnchor, commentBody } from "./comment-schema";
import { frictionReports, listFriction, reportFriction, SEVERITIES } from "./friction";

const SKILL_FILES = { "SKILL.md": skill, "references/design-system.md": designSystemGuide, "references/screens.md": screensGuide } as const;
const pageDescription = z.string().max(DESCRIPTION_MAX)
  .describe("Describe the page's contents and purpose in one or two sentences. Empty clears it.");
const sectionDescription = z.string().max(DESCRIPTION_MAX)
  .describe("Sections only. Describe the contents and purpose in one or two sentences. Empty clears it.");
const themeChoice = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).nullable();

const INSTRUCTIONS = `Use Sharpner for shared UI design and canvas feedback. Call read_skill() before edits. Use get_app_state to find the member's file and selection. Preserve other members' edits.`;

export const mcp = new Hono<AppEnv>();

mcp.all("/", async (c) => {
  let identity: Identity | null;
  try {
    identity = await authenticate(c.env, c.req.raw, "machine");
    if (identity) requireScope(identity, "sharpner:read");
  } catch (error) {
    const status = authErrorStatus(error) ?? 503;
    if (status === 401) return oauthChallenge(c.req.raw, "Invalid or expired credentials. Reconnect through Clerk.");
    return c.json({ error: error instanceof Error ? error.message : "Authentication unavailable" }, status);
  }
  if (!identity) return oauthChallenge(c.req.raw);
  const server = buildServer(c.env, identity, new URL(c.req.url).origin);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

function buildServer(env: Env, identity: Identity, origin: string) {
  const { user } = identity;
  const server = new McpServer({ name: "sharpner", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  const actor: Actor = { id: user.id, name: `${user.name}'s agent`, avatar: user.avatar_url, agent: true };

  const access = async (fileId: string) => {
    const file = await fileFor(env, user.id, fileId);
    if (!file) throw new Error(`File ${fileId} not found or you are not a member of its workspace`);
    const stub = room(env, file.id);
    return { file, stub, apply: (ops: Op[]) => {
      requireScope(identity, "sharpner:write");
      return stub.apply(file.id, origin, ops, actor);
    } };
  };
  const abs = (url: string | null) => (url?.startsWith("/") ? origin + url : url);
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] });
  const propsOf = (html: string) => [...new Set([...html.matchAll(/\{\{\s*([\w-]+)/g)].map((m) => m[1]!))];

  server.registerTool("get_app_state", {
    description: "List workspaces and files. Show the member's open file, page, selection, and page descriptions.",
    inputSchema: {},
  }, async () => {
    const [workspaces, files, me] = await Promise.all([
      workspacesFor(env, user.id),
      filesFor(env, user.id),
      env.DB.prepare(`SELECT last_file_id FROM users WHERE id = ?`).bind(user.id).first<{ last_file_id: string | null }>(),
    ]);
    let active = null;
    const open = files.find((f) => f.id === me?.last_file_id);
    if (open) {
      const stub = room(env, open.id);
      const [peers, outline, comments, cover, fileTheme] = await Promise.all([stub.peers(), stub.outline(), stub.comments(), stub.cover(), stub.theme()]);
      const mine = peers.find((p) => p.id === user.id && !p.agent);
      const page = outline.find((p) => p.id === mine?.pageId);
      const nodes = outline.flatMap((p) => p.nodes);
      active = {
        fileId: open.id,
        fileName: open.name,
        libraryFileId: open.library_id,
        fileTheme,
        cover: { ...cover, url: abs(cover.url) },
        openInBrowser: Boolean(mine),
        currentPage: page ? { id: page.id, name: page.name } : null,
        pages: outline.map(({ id, name, description }) => ({ id, name, description })),
        selection: (mine?.selection ?? []).map((id) => nodes.find((n) => n.id === id)).filter(Boolean).map((n) => ({ id: n!.id, kind: n!.kind, name: n!.name })),
        othersOnline: [...new Set(peers.filter((p) => p.id !== user.id).map((p) => p.name))],
        openCommentCount: comments.filter((t) => t.resolvedAt === null).length,
      };
    }
    return json({
      user: { name: user.name, login: user.login },
      active,
      workspaces: workspaces.map((w) => ({
        ...w,
        files: files.filter((f) => f.workspace_id === w.id).map((f) => ({ id: f.id, name: f.name, libraryFileId: f.library_id })),
      })),
      screenshots: Boolean(env.BROWSER),
    });
  });

  server.registerTool("list_comments", {
    description: "List comment excerpts and anchors. Defaults to open threads. Follow nextOffset until null. Read relevant threads with get_comment_thread before edits.",
    inputSchema: {
      fileId: z.string(), pageId: z.string().optional(), nodeId: z.string().optional(),
      status: z.enum(["open", "resolved", "all"]).default("open"),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: { readOnlyHint: true },
  }, async ({ fileId, pageId, nodeId, status, offset, limit }) => {
    const { stub } = await access(fileId);
    const [all, nodes, pages] = await Promise.all([stub.comments(), stub.nodes(), stub.pages()]);
    const matches = all.filter((t) => (!pageId || t.anchor.pageId === pageId) && (!nodeId || t.anchor.nodeId === nodeId)
      && (status === "all" || (status === "resolved") === (t.resolvedAt !== null)));
    const threads = matches.slice(offset, offset + limit);
    const rects = layoutRects(nodes, layoutHeight);
    return json({ total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null,
      threads: threads.map((t) => ({ ...t,
        pageName: pages.find((p) => p.id === t.anchor.pageId)?.name ?? null,
        node: (() => { const node = nodes.find((n) => n.id === t.anchor.nodeId); return node ? { id: node.id, name: node.name, kind: node.kind, ...nodeGeometry(node, rects) } : null; })(),
      })),
    });
  });

  server.registerTool("get_comment_thread", {
    description: "Read a comment thread with full messages and replies, including resolved threads.",
    inputSchema: { fileId: z.string(), threadId: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ fileId, threadId }) => {
    const { stub } = await access(fileId);
    return json(await stub.comment(threadId));
  });

  server.registerTool("add_comment", {
    description: "Pin a comment to a node or page. With nodeId, x/y are offsets from its computed top-left. Otherwise, use page coordinates.",
    inputSchema: { fileId: z.string(), anchor: commentAnchor, body: commentBody },
  }, async ({ fileId, anchor, body }) => {
    requireScope(identity, "sharpner:write");
    const { stub } = await access(fileId);
    return json(await stub.createComment(fileId, anchor, body, actor));
  });

  server.registerTool("reply_to_comment", {
    description: "Reply to a comment thread as the member's agent.",
    inputSchema: { fileId: z.string(), threadId: z.string(), body: commentBody },
  }, async ({ fileId, threadId, body }) => {
    requireScope(identity, "sharpner:write");
    const { stub } = await access(fileId);
    return json(await stub.replyComment(fileId, threadId, body, actor));
  });

  server.registerTool("resolve_comment", {
    description: "Resolve a comment after you verify the fix. Use resolved:false to reopen it. This preserves the thread and changes no designs.",
    inputSchema: { fileId: z.string(), threadId: z.string(), resolved: z.boolean() },
  }, async ({ fileId, threadId, resolved }) => {
    requireScope(identity, "sharpner:write");
    const { stub } = await access(fileId);
    return json(await stub.resolveComment(fileId, threadId, resolved, actor));
  });

  server.registerTool("report_friction", {
    description: "Report a Sharpner tool problem. Check list_friction first; use sameAs for duplicates. Exclude secrets. File-scoped reports are shared with workspace members; others are private to you. The Sharpner team can review all reports.",
    inputSchema: {
      summary: z.string().trim().min(1).max(200).describe("Name the problem in one line"),
      details: z.string().max(4000).optional().describe("Task, result, expected result, and workaround"),
      severity: z.enum(SEVERITIES).describe("blocker: could not do the task; major: a costly workaround; minor: an annoyance"),
      tool: z.string().max(60).optional().describe("Tool or area, e.g. get_file, layout, components"),
      fileId: z.string().optional().describe("Shares the report with this file's workspace"),
      agent: z.string().max(100).optional().describe("Your client and model"),
      sameAs: z.string().optional().describe("Existing issue ID from list_friction"),
    },
  }, async ({ fileId, ...report }) => {
    const file = fileId ? (await access(fileId)).file : null;
    return json(await reportFriction(env, { ...report, userId: user.id, workspaceId: file?.workspace_id ?? null, fileId: file?.id ?? null }));
  });

  server.registerTool("list_friction", {
    description: "List Sharpner tool problems visible to you, ranked by weighted report count. Check before report_friction; pass issueId to read its reports.",
    inputSchema: {
      issueId: z.string().optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: { readOnlyHint: true },
  }, async ({ issueId, offset, limit }) =>
    json(issueId ? { issueId, reports: await frictionReports(env, user.id, issueId) } : await listFriction(env, user.id, limit, offset)));

  server.registerTool("read_skill", {
    description: "Read Sharpner's design skill. Omit path for SKILL.md. Read referenced files only when the task needs them.",
    inputSchema: { path: z.enum(["SKILL.md", "references/design-system.md", "references/screens.md"]).default("SKILL.md") },
    annotations: { readOnlyHint: true },
  }, async ({ path }) => ({ content: [{ type: "text" as const, text: SKILL_FILES[path] }] }));

  server.registerTool("create_file", {
    description: "Create a workspace file. Optionally use another file in that workspace as its library.",
    inputSchema: { workspaceId: z.string(), name: z.string(), libraryFileId: z.string().optional() },
  }, async ({ workspaceId, name, libraryFileId }) => {
    requireScope(identity, "sharpner:write");
    if (!(await workspaceFor(env, user.id, workspaceId))) throw new Error(`Workspace ${workspaceId} not found`);
    const file = await createFile(env, user.id, workspaceId, name, libraryFileId ?? null);
    return json({ fileId: file.id, pages: await room(env, file.id).pages() });
  });

  server.registerTool("set_library", {
    description: "Use a file in the same workspace as a library, or null to remove it. Its tokens and components become available.",
    inputSchema: { fileId: z.string(), libraryFileId: z.string().nullable() },
  }, async ({ fileId, libraryFileId }) => {
    requireScope(identity, "sharpner:write");
    const { file } = await access(fileId);
    await setLibrary(env, file, libraryFileId);
    return json({ ok: true });
  });

  server.registerTool("set_cover", {
    description: "Set an existing frame or image as the file cover. Use null for automatic selection. Check get_file.cover before replacing it.",
    inputSchema: { fileId: z.string(), nodeId: z.string().min(1).nullable().describe("An existing frame or image in this file, or null for automatic selection.") },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ fileId, nodeId }) => {
    const { stub, apply } = await access(fileId);
    await apply([{ t: "cover.set", id: nodeId }]);
    const cover = await stub.cover();
    return json({ ok: true, cover: { ...cover, url: abs(cover.url) } });
  });

  server.registerTool("set_theme", {
    description: "Set the file theme from get_design_system.themes. Use null to preserve HTML themes. Frame overrides remain; change them with update_nodes.",
    inputSchema: { fileId: z.string(), theme: themeChoice.describe("Named theme from the token CSS, or null for As authored.") },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ fileId, theme }) => {
    const { stub, apply } = await access(fileId);
    await apply([{ t: "theme.set", theme }]);
    return json({ ok: true, fileTheme: await stub.theme() });
  });

  server.registerTool("list_pages", {
    description: "List page and section descriptions and design counts. Use this overview to choose a pageId for get_file.",
    inputSchema: { fileId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ fileId }) => {
    const { file, stub } = await access(fileId);
    const outline = await stub.outline();
    const pages = outline.map((p) => ({
      id: p.id, name: p.name, description: p.description ?? "", ...arrangementOf(p.nodes),
      designs: p.nodes.filter((n) => n.kind !== "section").length,
      sections: p.nodes.filter((n) => n.kind === "section").map((s) => ({
        id: s.id, name: s.name, description: s.description ?? "", parentId: s.parentId,
        designs: p.nodes.filter((n) => n.parentId === s.id && n.kind !== "section").length,
      })),
    }));
    const undescribed = pages.some((p) => !p.description || p.sections.some((s) => !s.description));
    return json({ id: file.id, name: file.name, libraryFileId: file.library_id, pages,
      ...(undescribed ? { hint: "Some pages or sections have no description. When you create or reorganize one, describe it with update_page or update_nodes." } : {}) });
  });

  server.registerTool("get_file", {
    description: "Read file metadata, cover, and node bounds without sources. Pass pageId for one page. Use list_pages for navigation and read_nodes for sources.",
    inputSchema: { fileId: z.string(), pageId: z.string().optional().describe("Only this page. Omit for every page.") },
    annotations: { readOnlyHint: true },
  }, async ({ fileId, pageId }) => {
    const { file, stub } = await access(fileId);
    const [all, cover, fileTheme] = await Promise.all([stub.outline(), stub.cover(), stub.theme()]);
    const outline = all.filter((p) => !pageId || p.id === pageId);
    if (pageId && !outline.length) throw new Error(`Page ${pageId} not found`);
    const pages = outline.map((p) => {
      const rects = layoutRects(p.nodes, (n) => layoutHeight(n));
      return {
        id: p.id,
        name: p.name,
        description: p.description ?? "",
        ...arrangementOf(p.nodes),
        sections: p.nodes.filter((n) => n.kind === "section").map((n) => ({ id: n.id, name: n.name, description: n.description ?? "", parentId: n.parentId, layout: n.layout ?? "free", order: n.order, ...rects.get(n.id) })),
        nodes: p.nodes.filter((n) => n.kind !== "section").map((n) => ({
          id: n.id, kind: n.kind, name: n.name, sectionId: n.parentId, order: n.order,
          ...nodeGeometry(n, rects),
          ...(n.height == null && n.measuredHeight ? { renderedHeight: n.measuredHeight } : {}),
          ...(n.kind === "image" ? { src: abs(n.src) } : {}),
          ...(n.kind === "component" ? { tag: componentTag(n.name) } : {}),
          ...(n.kind === "frame" ? { theme: n.theme ?? null, effectiveTheme: effectiveTheme(n, fileTheme) ?? null } : {}),
          ...(n.kind === "component" && n.theme ? { theme: n.theme } : {}),
          ...(n.kind === "frame" || n.kind === "component" ? { interactive: n.interactive ?? false } : {}),
        })),
      };
    });
    return json({ id: file.id, name: file.name, libraryFileId: file.library_id, fileTheme, cover: { ...cover, url: abs(cover.url) }, pages });
  });

  server.registerTool("get_design_system", {
    description: "Read tokens, CSS, themes, and component tags, props, slots, theme overrides, locations, and use counts from the file and its library.",
    inputSchema: { fileId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ fileId }) => {
    const { file, stub } = await access(fileId);
    const design = await stub.designSystem();
    const describe = async (id: string, source: "file" | "library") => {
      const s = room(env, id);
      const [outline, own] = await Promise.all([s.outline(), s.ownDesignSystem()]);
      const nodes = outline.flatMap((p) => p.nodes.map((n) => ({ ...n, page: p.name })));
      const node = (tag: string, theme: string | null) => nodes.find((x) => x.kind === "component" && componentTag(x.name) === tag && (x.theme ?? null) === theme);
      // One entry per tag. Theme overrides are listed with it: the same component, restructured for one theme.
      const tags = [...new Set(own.components.map((c) => c.tag))];
      return tags.map((tag) => {
        const defs = own.components.filter((c) => c.tag === tag);
        const c = defs.find((d) => !d.theme) ?? defs[0]!;
        const n = node(tag, c.theme ?? null);
        const overrides = defs.filter((d) => d.theme).map((d) => ({ theme: d.theme!, nodeId: node(tag, d.theme!)?.id, props: propsOf(d.html) }));
        return {
          tag, name: n?.name, nodeId: n?.id, page: n?.page, props: propsOf(c.html), slot: /<slot[\s>/]/i.test(c.html),
          ...(c.theme ? { missingDefault: true } : {}), ...(overrides.length ? { themeOverrides: overrides } : {}),
          source, ...(source === "library" ? { libraryFileId: id } : {}),
        };
      });
    };
    const own = await describe(file.id, "file");
    const lib = design.library ? (await describe(design.library.fileId, "library")).filter((c) => !own.some((o) => o.tag === c.tag)) : [];
    const uses = new Map<string, number>();
    for (const { tag } of await stub.instances()) uses.set(tag, (uses.get(tag) ?? 0) + 1);
    const components = [...lib, ...own].map((c) => ({ ...c, uses: uses.get(c.tag) ?? 0 }));
    return json({
      library: design.library,
      fileTheme: design.fileTheme,
      themes: themeNames(design.tokens),
      tokens: tokenNames(design.tokens),
      tokenCss: design.tokens,
      components,
      ...(!design.tokens && !components.length ? { hint: 'No design system. For product work, read_skill({ path: "references/design-system.md" }). Create a system or link a workspace library with set_library.' } : {}),
    });
  });

  server.registerTool("find_instances", {
    description: "Find direct component uses here and in files that use this file as a library. Local definitions override library components. Check before component changes.",
    inputSchema: { fileId: z.string(), component: z.string().describe("Tag (x-button-primary) or component name (Button/Primary)") },
    annotations: { readOnlyHint: true },
  }, async ({ fileId, component }) => {
    const { file } = await access(fileId);
    const tag = /^<?x-/i.test(component) ? component.replace(/[<>]/g, "").toLowerCase() : componentTag(component);
    const { results: dependents } = await env.DB.prepare(`SELECT id FROM files WHERE library_id = ?`).bind(file.id).all<{ id: string }>();
    const files = [file, ...(await Promise.all(dependents.map((d) => fileFor(env, user.id, d.id)))).filter((f) => f !== null)];
    const instances = (await Promise.all(files.map(async (f) => {
      const s = room(env, f.id);
      const [found, pages, nodes] = await Promise.all([s.instances(), s.pages(), f.id === file.id ? [] : s.nodes()]);
      // A dependent's own component with the same tag replaces the library's there.
      if (nodes.some((n) => n.kind === "component" && componentTag(n.name) === tag)) return [];
      return found.filter((i) => i.tag === tag).map(({ tag: _tag, id, ...node }) => ({
        fileId: f.id, fileName: f.name, pageId: node.pageId, pageName: pages.find((p) => p.id === node.pageId)?.name ?? null, nodeId: id, name: node.name, kind: node.kind,
      }));
    }))).flat();
    return json({ tag, total: instances.length, instances });
  });

  server.registerTool("create_page", {
    description: "Add a page to a file with a description of its contents.",
    inputSchema: { fileId: z.string(), name: z.string(), description: pageDescription.optional() },
  }, async ({ fileId, name, description }) => {
    const { stub, apply } = await access(fileId);
    const pages = await stub.pages();
    const page: Page = { id: crypto.randomUUID(), name, sort: Math.max(0, ...pages.map((p) => p.sort)) + 1, description: description ?? "" };
    await apply([{ t: "page.put", page }]);
    return json(page);
  });

  const updatePage = async (fileId: string, pageId: string, name?: string, description?: string) => {
    const { stub, apply } = await access(fileId);
    const page = (await stub.pages()).find((p) => p.id === pageId);
    if (!page) throw new Error(`Page ${pageId} not found`);
    await apply([{ t: "page.put", page: { id: page.id, sort: page.sort, name: name ?? page.name, ...description !== undefined && { description } } }]);
    return json({ ok: true });
  };

  server.registerTool("update_page", {
    description: "Rename a page or change its description.",
    inputSchema: { fileId: z.string(), pageId: z.string(), name: z.string().min(1).optional(), description: pageDescription.optional() },
  }, ({ fileId, pageId, name, description }) => updatePage(fileId, pageId, name, description));

  server.registerTool("delete_page", {
    description: "Delete a page and every node on it. Only do this when explicitly asked.",
    inputSchema: { fileId: z.string(), pageId: z.string() },
    annotations: { destructiveHint: true },
  }, async ({ fileId, pageId }) => {
    const { apply } = await access(fileId);
    await apply([{ t: "page.del", id: pageId }]);
    return json({ ok: true });
  });

  /** Where to auto-place new nodes: right of the section's contents, or right of everything on the page. */
  const placement = (nodes: CanvasNode[], sectionId: string | null, gap: number) => {
    const rects = layoutRects(nodes, (n) => layoutHeight(n));
    const siblings = nodes.filter((n) => n.parentId === sectionId).map((n) => rects.get(n.id)!);
    if (siblings.length) {
      const r = union(siblings);
      return { x: r.x + r.w + gap, y: r.y };
    }
    const section = nodes.find((n) => n.id === sectionId);
    return section ? { x: section.x, y: section.y } : { x: 0, y: 0 };
  };

  server.registerTool("create_section", {
    description: "Create a section, optionally nested. Auto layout arranges children; omit x/y and add nodes with create_nodes.sectionId. Use free layout for manual positions.",
    inputSchema: {
      fileId: z.string(),
      name: z.string(),
      pageId: z.string().optional().describe("Defaults to the page the user is viewing, else the first page"),
      parentSectionId: z.string().optional(),
      description: sectionDescription.optional(),
      layout: z.enum(["auto", "free"]).optional().describe("Default auto. Free uses manual positions."),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  }, async ({ fileId, name, description, pageId, parentSectionId, layout = "auto", x, y }) => {
    const { stub, apply } = await access(fileId);
    const page = await targetPage(stub, user.id, pageId, parentSectionId);
    const existingStack = !parentSectionId && layout === "auto" ? page.nodes.filter((n) => !n.parentId && n.kind === "section" && n.layout === "auto") : [];
    const at = existingStack.length ? { x: Math.min(...existingStack.map((n) => n.x)), y: Math.min(...existingStack.map((n) => n.y)) } : placement(page.nodes, parentSectionId ?? null, 160);
    const id = crypto.randomUUID();
    await apply([{ t: "node.put", id, node: { kind: "section", pageId: page.id, parentId: parentSectionId ?? null, layout, name, description, x: x ?? at.x, y: y ?? at.y } }]);
    return json({ sectionId: id, pageId: page.id, layout });
  });

  server.registerTool("create_nodes", {
    description: "Create frames and components from HTML source, token sheets from CSS source, or images from imageUrl. Default kind is frame. In auto sections, omit x/y. Return IDs and computed bounds.",
    inputSchema: {
      fileId: z.string(),
      pageId: z.string().optional().describe("Defaults to the section's page, else the page the user is viewing, else the first page"),
      sectionId: z.string().optional().describe("Section to put the nodes in"),
      nodes: z.array(z.object({
        kind: z.enum(["frame", "component", "tokens", "image"]).optional(),
        name: z.string().describe("Component names set their tag: Button/Primary -> <x-button-primary>"),
        source: z.string().optional().describe("HTML for frames/components, Tailwind v4 CSS for token sheets"),
        theme: themeChoice.optional().describe("Frames: named theme override; null or omitted inherits the file theme. Components: create a theme override, a second definition of an existing component (same name) used only inside that theme; omit for the default definition."),
        interactive: z.boolean().optional().describe("Frames/components only: allow the viewer to enter interaction mode. Default false. Playback and input state stay local to the viewer."),
        imageUrl: z.string().optional().describe("For images, e.g. a URL from upload_image"),
        previewUrl: z.string().optional().describe("Small image preview. Omit to generate one if Browser Rendering is available."),
        width: z.number().positive().optional().describe("Viewport width in px. Default 400; token sheets default to 960."),
        height: z.number().positive().nullish().describe("Fixed height in px; omit to fit content"),
        x: z.number().optional(),
        y: z.number().optional(),
      })).min(1).max(20),
    },
  }, async ({ fileId, pageId, sectionId, nodes }) => {
    const { stub, apply } = await access(fileId);
    const page = await targetPage(stub, user.id, pageId, sectionId);
    let at = placement(page.nodes, sectionId ?? null, 80);
    const created = nodes.map((n) => {
      const kind = n.kind ?? "frame";
      if (kind === "image" ? !n.imageUrl : n.source === undefined) throw new Error(`"${n.name}" needs ${kind === "image" ? "imageUrl" : "source"}`);
      const width = n.width ?? (kind === "tokens" ? 960 : 400);
      const x = n.x ?? at.x, y = n.y ?? at.y;
      at = { x: Math.max(at.x, x + width + 80), y: at.y };
      const base = { kind, pageId: page.id, parentId: sectionId ?? null, name: n.name, width, x, y, ...(n.theme !== undefined ? { theme: n.theme } : {}), ...(n.interactive !== undefined ? { interactive: n.interactive } : {}) };
      const node: NodeInput = kind === "image"
        ? { ...base, src: n.imageUrl, thumbLo: n.previewUrl ?? null, height: n.height ?? width }
        : { ...base, source: n.source, height: n.height ?? null };
      return { id: crypto.randomUUID(), ...node };
    });
    await apply(created.map(({ id, ...node }) => ({ t: "node.put", id, node })));
    const actual = (await stub.nodes()).filter((n) => n.pageId === page.id);
    const rects = layoutRects(actual, (n) => layoutHeight(n));
    return json({
      pageId: page.id,
      nodes: created.map((node) => ({
        id: node.id,
        kind: node.kind,
        name: node.name,
        ...nodeGeometry(node, rects),
        ...(node.kind === "component" ? { tag: componentTag(node.name!) } : {}),
      })),
    });
  });

  server.registerTool("read_nodes", {
    description: "Read node sources and computed bounds. heightMode is auto or fixed. Preserve auto sizing by leaving height unset or null.",
    inputSchema: { fileId: z.string(), nodeIds: z.array(z.string()).min(1).max(20) },
    annotations: { readOnlyHint: true },
  }, async ({ fileId, nodeIds }) => {
    const { stub } = await access(fileId);
    const nodes = await Promise.all(nodeIds.map((id) => stub.node(id)));
    const [all, fileTheme] = await Promise.all([stub.nodes(), stub.theme()]);
    const rects = layoutRects(all, (n) => layoutHeight(n));
    await stub.agentActivity(actor, nodes.flatMap((n) => (n && n.kind !== "section" ? [n.id] : [])));
    return json(nodes.map((node, index) => {
      if (!node) return { id: nodeIds[index], error: "not found" };
      return {
        id: node.id,
        pageId: node.pageId,
        kind: node.kind,
        name: node.name,
        sectionId: node.parentId,
        layout: node.kind === "section" ? node.layout ?? "free" : undefined,
        order: node.order,
        ...(node.kind === "frame" ? { theme: node.theme ?? null, effectiveTheme: effectiveTheme(node, fileTheme) ?? null } : {}),
        ...(node.kind === "component" && node.theme ? { theme: node.theme } : {}),
        ...(node.kind === "frame" || node.kind === "component" ? { interactive: node.interactive ?? false } : {}),
        ...nodeGeometry(node, rects),
        ...(node.kind === "image" ? { src: abs(node.src) } : { source: node.source }),
      };
    }));
  });

  server.registerTool("update_nodes", {
    description: "Update nodes or sections. height:null fits content. In auto sections, omit x/y and use order. sectionId:null removes the parent. pageId moves to another page.",
    inputSchema: {
      fileId: z.string(),
      updates: z.array(z.object({
        nodeId: z.string(),
        pageId: z.string().optional(),
        sectionId: z.string().nullable().optional(),
        layout: z.enum(["auto", "free"]).optional().describe("Sections only. Legacy sections default to free."),
        order: z.number().finite().optional().describe("Auto layout sibling order. Lower values come first. New nodes append."),
        name: z.string().optional(),
        description: sectionDescription.optional(),
        source: z.string().optional(),
        theme: themeChoice.optional().describe("Frames: named theme override; null restores file inheritance. Components: the theme this definition overrides; null makes it the default. Omit to preserve."),
        interactive: z.boolean().optional().describe("Frames/components only: allow entering interaction mode. Omit to preserve. Playback and input state are viewer-local; this changes no source or thumbnail."),
        width: z.number().positive().optional(),
        height: z.number().positive().nullish(),
        x: z.number().optional(),
        y: z.number().optional(),
      })).min(1).max(50),
    },
  }, async ({ fileId, updates }) => {
    const { stub, apply } = await access(fileId);
    const all = await stub.nodes();
    const nodesById = new Map(all.map((node) => [node.id, node]));
    const missing = updates.filter((update) => !nodesById.has(update.nodeId)).map((update) => update.nodeId);
    if (missing.length) throw new Error(`Nodes not found: ${missing.join(", ")}`);
    const rects = layoutRects(all, (n) => layoutHeight(n));
    const arrivals: CanvasNode[] = [];
    await apply(updates.map(({ nodeId, sectionId, ...patch }) => {
      const cur = nodesById.get(nodeId)!;
      const node = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as NodeInput;
      if (sectionId !== undefined) node.parentId = sectionId;
      // Moving loose to another page without coordinates: land to the right of that page's content (and of
      // anything moved there in this call) instead of reusing a position from the old page. Automatic
      // sections join that page's arrangement instead, so their stored position must not move its origin.
      const joinsLayout = cur.kind === "section" && (patch.layout ?? cur.layout) === "auto";
      if (patch.pageId !== undefined && patch.pageId !== cur.pageId && !sectionId && !joinsLayout && patch.x === undefined && patch.y === undefined) {
        const target = [...all.filter((n) => n.pageId === patch.pageId), ...arrivals.filter((n) => n.pageId === patch.pageId)];
        Object.assign(node, placement(target, null, 160));
        const r = rects.get(cur.id)!;
        arrivals.push({ ...cur, id: `${cur.id}:arrival`, kind: "frame", parentId: null, pageId: patch.pageId, x: node.x!, y: node.y!, width: r.w, height: r.h });
      }
      // A section's x/y refer to its visible bounds; the whole section moves with its contents.
      const reparented = sectionId !== undefined && sectionId !== cur.parentId || patch.pageId !== undefined && patch.pageId !== cur.pageId;
      const relayout = patch.layout !== undefined && patch.layout !== cur.layout;
      if (cur.kind === "section" && !reparented && !relayout) {
        const r = rects.get(cur.id)!;
        if (patch.x !== undefined) node.x = cur.x + (patch.x - r.x);
        if (patch.y !== undefined) node.y = cur.y + (patch.y - r.y);
      }
      return { t: "node.put", id: nodeId, node } as Op;
    }));
    return json({ ok: true, updated: updates.length });
  });

  server.registerTool("edit_node_source", {
    description: "Apply ordered find/replace edits to a node's HTML or CSS. Each find must match once unless all is true.",
    inputSchema: {
      fileId: z.string(),
      nodeId: z.string(),
      edits: z.array(z.object({ find: z.string().min(1), replace: z.string(), all: z.boolean().optional() })).min(1),
    },
  }, async ({ fileId, nodeId, edits }) => {
    const { stub, apply } = await access(fileId);
    const node = await stub.node(nodeId);
    if (!node || !["frame", "component", "tokens"].includes(node.kind)) throw new Error(`Node ${nodeId} not found or has no source`);
    let source = node.source;
    edits.forEach((e, i) => {
      const count = source.split(e.find).length - 1;
      if (count === 0) throw new Error(`Edit ${i}: \`find\` text not found`);
      if (count > 1 && !e.all) throw new Error(`Edit ${i}: \`find\` matches ${count} times; make it unique or set all: true`);
      source = e.all ? source.replaceAll(e.find, () => e.replace) : source.replace(e.find, () => e.replace);
    });
    await apply([{ t: "node.put", id: nodeId, node: { source } }]);
    return json({ ok: true, length: source.length });
  });

  server.registerTool("delete_nodes", {
    description: "Delete nodes. Deleting a section deletes everything inside it.",
    inputSchema: { fileId: z.string(), nodeIds: z.array(z.string()).min(1) },
    annotations: { destructiveHint: true },
  }, async ({ fileId, nodeIds }) => {
    const { apply } = await access(fileId);
    await apply([{ t: "node.del", ids: nodeIds }]);
    return json({ ok: true });
  });

  server.registerTool("upload_image", {
    description: "Store an image from a public URL or base64 data. Return a permanent URL for HTML or imageUrl.",
    inputSchema: {
      fileId: z.string(),
      url: z.string().url().optional(),
      base64: z.string().optional(),
      mimeType: z.string().optional().describe("Required with base64, e.g. image/png"),
    },
  }, async ({ fileId, url, base64, mimeType }) => {
    requireScope(identity, "sharpner:write");
    const { file } = await access(fileId);
    let bytes: Uint8Array;
    let type = mimeType ?? "";
    if (url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Fetching ${url} failed: ${res.status}`);
      type = res.headers.get("content-type")?.split(";")[0] ?? type;
      bytes = new Uint8Array(await res.arrayBuffer());
    } else if (base64) {
      bytes = Uint8Array.from(atob(base64.replace(/^data:[^,]+,/, "")), (ch) => ch.charCodeAt(0));
    } else throw new Error("Pass url or base64");
    if (!type.startsWith("image/")) throw new Error(`Not an image (${type || "unknown type"})`);
    if (bytes.byteLength > MAX_UPLOAD) throw new Error("Images must be under 25 MB");
    return json({ url: abs(await putFile(env, file.id, bytes, type)) });
  });

  const browserBinding = env.BROWSER;
  if (browserBinding) {
    server.registerTool("screenshot_nodes", {
      description: "Return browser screenshots of frames, components, or token sheets. Auto height captures content up to 8000px.",
      inputSchema: { fileId: z.string(), nodeIds: z.array(z.string()).min(1).max(4) },
      annotations: { readOnlyHint: true },
    }, async ({ fileId, nodeIds }) => {
      const { stub } = await access(fileId);
      const nodes = (await stub.nodes(nodeIds))
        .filter((n) => nodeIds.includes(n.id) && ["frame", "component", "tokens"].includes(n.kind))
        .sort((a, b) => nodeIds.indexOf(a.id) - nodeIds.indexOf(b.id));
      if (!nodes.length) throw new Error("No matching frames, components or token sheets");
      await stub.agentActivity(actor, nodes.map((n) => n.id));
      const { content } = await stub.screenshotNodes(nodes.map((n) => n.id), origin);
      return { content };
    });
  }

  return server;
}

/** Tool responses expose computed bounds, while heightMode retains the node's authored sizing choice. */
/** Whether a page tiles its automatic top-level sections, and if they stay in one column, what to change. */
function arrangementOf(nodes: CanvasNode[]) {
  const page = pageArrangement(nodes);
  if (page.arrangement !== "stacked") return { arrangement: page.arrangement };
  const free = page.stackedBy.filter((n) => n.kind === "section"), loose = page.stackedBy.length - free.length;
  const named = free.slice(0, 5).map((n) => `"${n.name}"`).join(", ") + (free.length > 5 ? ` and ${free.length - 5} more` : "");
  const causes = [free.length ? `free section${free.length === 1 ? "" : "s"} ${named}` : "", loose ? `${loose} loose node${loose === 1 ? "" : "s"}` : ""];
  return {
    arrangement: page.arrangement,
    reason: `Automatic sections stay in one column because of ${causes.filter(Boolean).join(" and ")}. Set those sections to layout "auto", or move loose nodes into a section, to let the page tile.`,
    stackedBy: page.stackedBy.map((n) => ({ id: n.id, name: n.name, kind: n.kind })),
  };
}

function nodeGeometry(node: { id: string; height?: number | null }, rects: ReadonlyMap<string, Rect>) {
  const rect = rects.get(node.id)!;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
    heightMode: node.height == null ? "auto" : "fixed",
  };
}

type RoomStub = ReturnType<typeof room>;

/** The page new nodes go on: the section's page, else an explicit page, else what the user is viewing, else the first. */
async function targetPage(stub: RoomStub, userId: string, pageId: string | undefined, sectionId: string | undefined) {
  const [outline, peers] = await Promise.all([stub.outline(), stub.peers()]);
  if (sectionId) {
    const page = outline.find((p) => p.nodes.some((n) => n.id === sectionId && n.kind === "section"));
    if (!page) throw new Error(`Section ${sectionId} not found`);
    return page;
  }
  const viewing = peers.find((p) => p.id === userId && !p.agent)?.pageId;
  const page = pageId ? outline.find((p) => p.id === pageId) : outline.find((p) => p.id === viewing) ?? outline[0];
  if (!page) throw new Error(`Page ${pageId} not found`);
  return page;
}

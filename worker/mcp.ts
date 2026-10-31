import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import puppeteer from "@cloudflare/puppeteer";
import { z } from "zod";
import { authenticate, authErrorStatus, requireScope, type AppEnv, type Identity } from "./auth";
import { oauthChallenge } from "./oauth";
import { createFile, fileFor, filesFor, MAX_UPLOAD, putFile, room, setLibrary, workspaceFor, workspacesFor } from "./data";
import { capture, loadFrame } from "./render";
import { layoutHeight, layoutRects, pageArrangement, union, type Rect } from "../shared/layout";
import { componentTag, DESCRIPTION_MAX, renderedHtml, tokenNames, type Actor, type CanvasNode, type NodeInput, type Op, type Page } from "../shared/types";
import { effectiveTheme, themeNames } from "../shared/themes";
import designSystemGuide from "./guides/design-system.md?raw";
import screensGuide from "./guides/screens.md?raw";
import { commentAnchor, commentBody } from "./comment-schema";
import { frictionReports, listFriction, reportFriction, SEVERITIES } from "./friction";

const GUIDES = { "design-system": designSystemGuide, screens: screensGuide } as const;
const pageDescription = z.string().max(DESCRIPTION_MAX)
  .describe("One or two sentences: what the page holds and when to look at it, so agents can find their way. Empty clears it.");
const sectionDescription = z.string().max(DESCRIPTION_MAX)
  .describe("Sections only. One or two sentences: what the group holds and when to look at it. Empty clears it.");
const themeChoice = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).nullable();

const INSTRUCTIONS = `Sharpner is a shared infinite canvas where you design product UI for and with a team, who watch your edits live. Aim for production-quality design grounded in a design system.

Vocabulary:
- Workspace → files → pages → nodes. Node kinds: "frame" (HTML rendered at a viewport width: a screen, state, slide), "image", "section" (a labeled group that auto-fits its contents and can nest), "component" (reusable HTML), "tokens" (a token sheet: Tailwind v4 CSS defining the design tokens).
- A file's design system = its token sheets + components, plus those of its library (another workspace file it uses, at most one).
- Themes come from named [data-theme="…"] selectors in token CSS (legacy .dark also works). set_theme chooses the file default; a frame's theme field overrides it, or null inherits. Keep component variants separate from themes. Use metadata for theme comparisons so file switching preserves explicit frame choices.
- Frame/component source is the HTML of <body>. Tailwind v4 is preloaded; tokens become utilities (bg-primary, text-muted-foreground, font-display, rounded-md). Components are used as <x-name prop="…">children</x-name>.
- Pages and sections carry a short description: what they hold and when to look at them, like a skill's description. They are the file's table of contents for you and other agents. Give every page and section you create one or two sentences (e.g. "Foundations and generic primitives. Check before building any screen."), and update them when you reorganize. Members can edit them too.
- Geometry is in canvas px (x right, y down). Width = the viewport the HTML lays out at (1440 desktop, 390 mobile). Omit height to fit content; set it for fixed artboards (mobile 844). New sections arrange their contents automatically in ordered wrapping rows. Sibling sections that contain screens are flows and each take a row; other sibling sections (catalogs, token sheets, groups of them), nested or top-level, tile into about √n columns filled top to bottom, so a page grows about as wide as it is tall. A page with free sections or loose nodes keeps its top-level automatic sections in one column; list_pages and get_file report that as arrangement "stacked" with the reason, so set those sections to "auto" or move the loose nodes into a section to let the page tile. Omit x/y inside them; measured content heights reflow the layout without overlaps. Loose nodes and legacy/free sections keep manual positioning.

Workflow:
1. get_app_state: what the user has open and selected ("this frame" means the selection), with the open file's page descriptions.
   To find your way around a file, call list_pages (page and section descriptions), then get_file with pageId for just the part you need.
2. For product work (an app/site with several screens), read_guide("design-system") once, then get_design_system. Reuse the existing system or the workspace library (set_library); otherwise create a "Design System" page for foundations and generic primitives only. Add primitives as screens need them; keep application-specific components with their feature. One-off files can skip this.
3. read_guide("screens") before designing screens. One page per sizable feature, with screens/states in sections per flow and feature components on that same page. One frame per screen/state, left to right. Compare themes in neighboring frames with data-theme on each HTML root; light/dark/uwu are themes, Primary/Ghost are component variants.
4. Use token utilities and reuse component instances. Extract repeated feature markup into components on the feature page, with feature-prefixed names (Trade/OrderForm); tags remain file-wide. Before removing, renaming or reshaping a component, check its uses with find_instances.
5. Prefer edit_node_source (find/replace) for small changes. Verify with screenshot_nodes after each section of work and fix issues in place.
6. The canvas is multiplayer: re-read if something changed, never undo others' edits.
7. When asked to address comments, call list_comments for the file (open by default), then get_comment_thread for each relevant thread to read the full feedback and replies. Inspect the anchored node with read_nodes/screenshot_nodes, make the requested fixes, verify them, then reply_to_comment with what changed and resolve_comment. Comments are feedback, not an automatic request to edit; wait for the member to ask. Reopen with resolve_comment(resolved: false) if more work is needed.
8. If Sharpner's own tools get in your way (a confusing result, a missing capability, output too large to use, a workaround you had to invent), check list_friction and file it with report_friction, adding to an existing issue with sameAs when it is already listed. Keep it brief and carry on with the user's task.`;

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
    description: "Start here. Lists your workspaces and files, plus the file, page and selection the user currently has open in the browser, and that file's pages with their descriptions.",
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
      const [peers, outline, comments, fileTheme] = await Promise.all([stub.peers(), stub.outline(), stub.comments(), stub.theme()]);
      const mine = peers.find((p) => p.id === user.id && !p.agent);
      const page = outline.find((p) => p.id === mine?.pageId);
      const nodes = outline.flatMap((p) => p.nodes);
      active = {
        fileId: open.id,
        fileName: open.name,
        libraryFileId: open.library_id,
        fileTheme,
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
    description: "List canvas feedback with excerpts, authors, resolution state and anchored design context. Open threads by default. Follow nextOffset until null; call get_comment_thread to read each relevant thread's full text and replies before fixing it.",
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
    description: "Read a single comment thread with full messages and replies, including resolved feedback.",
    inputSchema: { fileId: z.string(), threadId: z.string() }, annotations: { readOnlyHint: true },
  }, async ({ fileId, threadId }) => {
    const { stub } = await access(fileId);
    return json(await stub.comment(threadId));
  });

  server.registerTool("add_comment", {
    description: "Leave feedback pinned to a design or canvas point. With nodeId, x/y are offsets from its computed top-left; otherwise x/y are page coordinates. This does not change any designs.",
    inputSchema: { fileId: z.string(), anchor: commentAnchor, body: commentBody },
  }, async ({ fileId, anchor, body }) => {
    requireScope(identity, "sharpner:write");
    const { stub } = await access(fileId);
    return json(await stub.createComment(fileId, anchor, body, actor));
  });

  server.registerTool("reply_to_comment", {
    description: "Reply to a canvas comment thread, e.g. to explain a verified design fix or ask for clarification. Replies are visibly attributed to the member's agent.",
    inputSchema: { fileId: z.string(), threadId: z.string(), body: commentBody },
  }, async ({ fileId, threadId, body }) => {
    requireScope(identity, "sharpner:write");
    const { stub } = await access(fileId);
    return json(await stub.replyComment(fileId, threadId, body, actor));
  });

  server.registerTool("resolve_comment", {
    description: "Resolve feedback after making and verifying the requested fix, or reopen it with resolved: false. The conversation is preserved. Resolving a thread does not change the design.",
    inputSchema: { fileId: z.string(), threadId: z.string(), resolved: z.boolean() },
  }, async ({ fileId, threadId, resolved }) => {
    requireScope(identity, "sharpner:write");
    const { stub } = await access(fileId);
    return json(await stub.resolveComment(fileId, threadId, resolved, actor));
  });

  server.registerTool("report_friction", {
    description: "Complaint box for Sharpner's agent experience. Report anything in these tools that slowed you down, confused you, returned too much or too little, or forced a workaround (e.g. \"get_file overflowed my context\", \"no way to see where a component is used\"). Call list_friction first: if the issue is listed, pass its id as sameAs with your own details, so it ranks higher instead of being duplicated. Reports are visible to members of the file's workspace (only to you without a fileId) and to the Sharpner team. Don't include secrets; quote design content only as far as it explains the problem. Changes no designs.",
    inputSchema: {
      summary: z.string().trim().min(1).max(200).describe("One line naming the problem, not the fix"),
      details: z.string().max(4000).optional().describe("What you were doing, what happened, what you expected, and any workaround"),
      severity: z.enum(SEVERITIES).describe("blocker: could not do the task; major: a costly workaround; minor: an annoyance"),
      tool: z.string().max(60).optional().describe("Tool or area, e.g. get_file, layout, components"),
      fileId: z.string().optional().describe("File you were working on; shares the report with its workspace"),
      agent: z.string().max(100).optional().describe("Your client and model, e.g. Claude Code / Claude Opus 5.5"),
      sameAs: z.string().optional().describe("Id of an existing issue from list_friction that this report repeats"),
    },
  }, async ({ fileId, ...report }) => {
    const file = fileId ? (await access(fileId)).file : null;
    return json(await reportFriction(env, { ...report, userId: user.id, workspaceId: file?.workspace_id ?? null, fileId: file?.id ?? null }));
  });

  server.registerTool("list_friction", {
    description: "The biggest known agent-experience flaws in Sharpner, heaviest first: each issue's weight sums its reports (blocker 5, major 3, minor 1). Covers your own reports and those from your workspaces. Check it before report_friction; pass issueId to read every report of one issue.",
    inputSchema: {
      issueId: z.string().optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: { readOnlyHint: true },
  }, async ({ issueId, offset, limit }) =>
    json(issueId ? { issueId, reports: await frictionReports(env, user.id, issueId) } : await listFriction(env, user.id, limit, offset)));

  server.registerTool("read_guide", {
    description: "Read a design guide. 'design-system': foundations, primitives, feature-local components, themes and libraries. 'screens': quality rules for product screens and landing pages.",
    inputSchema: { topic: z.enum(["design-system", "screens"]) },
    annotations: { readOnlyHint: true },
  }, async ({ topic }) => ({ content: [{ type: "text" as const, text: GUIDES[topic] }] }));

  server.registerTool("create_file", {
    description: "Create a file in one of your workspaces, optionally using another file of the workspace as its library (shared design system).",
    inputSchema: { workspaceId: z.string(), name: z.string(), libraryFileId: z.string().optional() },
  }, async ({ workspaceId, name, libraryFileId }) => {
    requireScope(identity, "sharpner:write");
    if (!(await workspaceFor(env, user.id, workspaceId))) throw new Error(`Workspace ${workspaceId} not found`);
    const file = await createFile(env, user.id, workspaceId, name, libraryFileId ?? null);
    return json({ fileId: file.id, pages: await room(env, file.id).pages() });
  });

  server.registerTool("set_library", {
    description: "Make a file use another file of the same workspace as its library (its tokens and components become available), or pass null to stop.",
    inputSchema: { fileId: z.string(), libraryFileId: z.string().nullable() },
  }, async ({ fileId, libraryFileId }) => {
    requireScope(identity, "sharpner:write");
    const { file } = await access(fileId);
    await setLibrary(env, file, libraryFileId);
    return json({ ok: true });
  });

  server.registerTool("set_theme", {
    description: "Set the file's theme, such as light, dark, or uwu, using the names reported by get_design_system. Frames with their own theme keep that override; other screens and component specimens inherit this choice. Pass null to preserve authored HTML themes. Token sheets keep showing every theme. To choose a single screen's theme, use update_nodes with theme (null restores file inheritance).",
    inputSchema: { fileId: z.string(), theme: themeChoice.describe("Named theme from the token CSS, or null for As authored.") },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ fileId, theme }) => {
    const { stub, apply } = await access(fileId);
    await apply([{ t: "theme.set", theme }]);
    return json({ ok: true, fileTheme: await stub.theme() });
  });

  server.registerTool("list_pages", {
    description: "A file's table of contents: each page's name and description, and its sections (name, description, parent, number of designs directly inside). Read it to choose where to look, then call get_file with that pageId. Cheaper than get_file for the whole file.",
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
    description: "A file's pages with their descriptions, sections and nodes (id, kind, name, sectionId, computed geometry and heightMode auto/fixed). Pass pageId to read one page; list_pages is the cheaper overview. No sources; use read_nodes for those, get_design_system for tokens and components.",
    inputSchema: { fileId: z.string(), pageId: z.string().optional().describe("Only this page. Omit for every page.") },
    annotations: { readOnlyHint: true },
  }, async ({ fileId, pageId }) => {
    const { file, stub } = await access(fileId);
    const [all, fileTheme] = await Promise.all([stub.outline(), stub.theme()]);
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
        })),
      };
    });
    return json({ id: file.id, name: file.name, libraryFileId: file.library_id, fileTheme, pages });
  });

  server.registerTool("get_design_system", {
    description: "The tokens and components available to a file's frames across all pages, including feature components (its own plus its library's): token names with the full token CSS, and each component's tag, props, whether it has a slot, where it is defined, and `uses`: how many frames and components in this file use it directly. Call find_instances before removing or reshaping a component.",
    inputSchema: { fileId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ fileId }) => {
    const { file, stub } = await access(fileId);
    const design = await stub.designSystem();
    const describe = async (id: string, source: "file" | "library") => {
      const s = room(env, id);
      const [outline, own] = await Promise.all([s.outline(), s.ownDesignSystem()]);
      const nodes = outline.flatMap((p) => p.nodes.map((n) => ({ ...n, page: p.name })));
      return own.components.map((c) => {
        const n = nodes.find((x) => x.kind === "component" && componentTag(x.name) === c.tag)!;
        return { tag: c.tag, name: n?.name, nodeId: n?.id, page: n?.page, props: propsOf(c.html), slot: /<slot[\s>/]/i.test(c.html), source, ...(source === "library" ? { libraryFileId: id } : {}) };
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
      ...(!design.tokens && !components.length ? { hint: "This file has no design system yet. For product work, read_guide('design-system') and set one up (or set_library to a workspace library)." } : {}),
    });
  });

  server.registerTool("find_instances", {
    description: "Where a component is used: every frame or component whose HTML contains its tag, in this file and in workspace files that use this file as their library (unless they define their own component with that tag). Use before removing, renaming or reshaping a component. Lists direct uses; a component entry means it is used inside another component.",
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
    description: "Add a page to a file (e.g. 'Design System', 'Trade', 'Portfolio'), with a description of what it will hold.",
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

  // Kept so cached tool lists and saved prompts that rename pages keep working.
  server.registerTool("rename_page", {
    description: "Deprecated: use update_page. Renames a page and keeps its description.",
    inputSchema: { fileId: z.string(), pageId: z.string(), name: z.string().min(1) },
  }, ({ fileId, pageId, name }) => updatePage(fileId, pageId, name));

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
    description: "Create a labeled section, optionally nested, with a description of what it holds. Defaults to automatic layout: children wrap in order (screens at the row-width limit, about four desktop or thirteen phone screens; other nodes up to four per row); sections that contain screens each take a row, other sibling sections tile into about √n columns filled top to bottom; measured heights move sections down their column without reshuffling them. A section holding only components packs them as a catalog: tight spacing, one row per family (the part before the last slash), the family named once in a gutter. Add children with create_nodes' sectionId and omit coordinates. Use layout 'free' for manual positioning.",
    inputSchema: {
      fileId: z.string(),
      name: z.string().describe("e.g. 'Onboarding', 'Components', 'Buttons'"),
      pageId: z.string().optional().describe("Defaults to the page the user is viewing, else the first page"),
      parentSectionId: z.string().optional(),
      description: sectionDescription.optional(),
      layout: z.enum(["auto", "free"]).optional().describe("Default auto. Free preserves explicit child positions and lets the section be placed freely."),
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
    description:
      "Create nodes. kind 'frame' (default) and 'component' take HTML `source`; 'tokens' takes CSS `source` (a token sheet); 'image' takes `imageUrl`. " +
      "Put related screens in a section and omit x/y: automatic sections arrange them in creation order and reflow after content sizing. Coordinates apply only to loose nodes or free sections; omitted loose coordinates place nodes to the right. Returns the new ids and computed geometry.",
    inputSchema: {
      fileId: z.string(),
      pageId: z.string().optional().describe("Defaults to the section's page, else the page the user is viewing, else the first page"),
      sectionId: z.string().optional().describe("Section to put the nodes in"),
      nodes: z.array(z.object({
        kind: z.enum(["frame", "component", "tokens", "image"]).optional(),
        name: z.string().describe("e.g. 'Checkout · Payment'. For components this sets the tag: 'Button/Primary' -> <x-button-primary>"),
        source: z.string().optional().describe("HTML for frames/components, Tailwind v4 CSS for token sheets"),
        theme: themeChoice.optional().describe("Frames only: named theme override; null or omitted inherits the file theme."),
        imageUrl: z.string().optional().describe("For images, e.g. a URL from upload_image"),
        previewUrl: z.string().optional().describe("Optional small image preview. If omitted, one is generated in the background when Browser Rendering is available."),
        width: z.number().positive().optional().describe("Viewport width in px, e.g. 1440 or 390. Default 400 (960 for token sheets)"),
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
      const base = { kind, pageId: page.id, parentId: sectionId ?? null, name: n.name, width, x, y, ...(n.theme !== undefined ? { theme: n.theme } : {}) };
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
    description: "Read nodes including source (HTML, or CSS for token sheets), computed x/y/width/height, and heightMode auto/fixed. Computed heights may grow after rendering; heightMode auto means edits should leave height unset (or null).",
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
        ...nodeGeometry(node, rects),
        ...(node.kind === "image" ? { src: abs(node.src) } : { source: node.source }),
      };
    }));
  });

  server.registerTool("update_nodes", {
    description: "Update nodes or sections. height null = fit content. Auto sections derive positions from order and current measured heights: omit x/y, use order to reorder siblings. Set section layout 'auto' to arrange an existing group, or 'free' to preserve its current positions for manual placement. Free-section x/y move its visible top-left and contents. sectionId moves a node into/out of a section (null = out), pageId to another page (without x/y it lands right of that page's content).",
    inputSchema: {
      fileId: z.string(),
      updates: z.array(z.object({
        nodeId: z.string(),
        pageId: z.string().optional(),
        sectionId: z.string().nullable().optional(),
        layout: z.enum(["auto", "free"]).optional().describe("Sections only. Existing legacy sections remain free until explicitly changed."),
        order: z.number().finite().optional().describe("Sibling order in automatic layout; smaller values come first. Creation appends by default."),
        name: z.string().optional(),
        description: sectionDescription.optional(),
        source: z.string().optional(),
        theme: themeChoice.optional().describe("Frames only: named theme override; null restores file inheritance. Omit to preserve."),
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
    description: "Find/replace edits on one node's source (frame/component HTML or token sheet CSS), applied in order. Each `find` must match exactly once unless `all` is true. Cheaper than resending the whole source.",
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
    description: "Store an image in the file (from a public URL or base64 data) and get back a permanent URL to use in HTML or as an image node's imageUrl.",
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
      description: "Render frames, components or token sheets in a real browser and return screenshots to check your work. Auto-height nodes are captured at full height (up to 8000px).",
      inputSchema: { fileId: z.string(), nodeIds: z.array(z.string()).min(1).max(4) },
      annotations: { readOnlyHint: true },
    }, async ({ fileId, nodeIds }) => {
      const { stub } = await access(fileId);
      const nodes = (await Promise.all(nodeIds.map((id) => stub.node(id))))
        .filter((n) => n && ["frame", "component", "tokens"].includes(n.kind))
        .map((n) => ({ ...n!, html: renderedHtml(n!, n!.source) }));
      if (!nodes.length) throw new Error("No matching frames, components or token sheets");
      await stub.agentActivity(actor, nodes.map((n) => n.id));
      const design = await stub.designSystem();
      const browser = await puppeteer.launch(browserBinding);
      try {
        const content = [];
        const tab = await browser.newPage();
        for (const n of nodes) {
          const { width, height } = await loadFrame(tab, { ...n, theme: effectiveTheme(n, design.fileTheme) }, origin, design);
          // Keep the image within ~1600px on its long side so it stays legible but cheap.
          const scale = Math.min(1, 1600 / Math.max(width, height));
          const data = btoa(Array.from(await capture(tab, width, height, { type: "jpeg", scale }), (b) => String.fromCharCode(b)).join(""));
          content.push({ type: "text" as const, text: `${n.name} (${n.id}) ${width}x${height}` });
          content.push({ type: "image" as const, data, mimeType: "image/jpeg" });
        }
        return { content };
      } finally {
        await browser.close();
      }
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

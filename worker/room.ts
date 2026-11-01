import { DurableObject } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { clerkIssuer } from "./auth";
import { fileFor, room } from "./data";
import { prepareRenderDesign } from "./render-fonts";
import { bytesToBase64, capture, captureThumbnails, loadFrame, loadImagePreview, withTimeout } from "./render";
import { selectThumbnail, type ThemeThumbnails } from "../shared/thumbnails";
import { imagePreviewFor } from "../shared/image-preview";
import { sourceBatches, type SourceItem } from "../shared/source-batches";
import { layoutHeight, layoutRects } from "../shared/layout";
import { viewerMessage } from "./viewer-message";
import { ViewerAccess } from "./viewer-access";
import { Comments, COMMENT_SCHEMA } from "./comments";
import { presenceMessage } from "./presence";
import { isSessionPrincipal, type SessionPrincipal } from "../shared/session-principal";
import { backfilling, THUMBNAIL_POLICY } from "./thumbnail-policy";
import { themeLabel } from "../shared/themes";
import { bakeTheme } from "../shared/bake-theme";
import { patchBrand } from "../shared/design-system";
import {
  componentTag, mergeDesignSystems, DESCRIPTION_MAX, renderedHtml, previewCurrent, emptyBrand, type Brand,
  type Actor, type CanvasNode, type ClientMsg, type DesignSystem, type LibraryInfo, type NodeInput, type NodeKind,
  type Op, type Page, type Peer, type Presence, type ServerMsg, type CommentAnchor, type CommentDetail, type CommentThread,
} from "../shared/types";

/** `shareToken` marks a view-only link viewer: anonymous, invisible to others, and unable to edit. */
type Attachment = {
  cid: string; fileId: string; origin: string; actor: Actor; presence: Presence; sessionExpiresAt: number;
  /** Member leases are tied to the Clerk instance that authenticated the upgrade. Legacy leases have no issuer. */
  sessionIssuer?: string;
  sessionId?: string;
  principal?: SessionPrincipal;
  shareToken?: string;
};
const VIEWER: Actor = { id: "link-viewer", name: "Viewer", avatar: null };
type NodeRow = Omit<CanvasNode, "thumbnails"> & { thumbnails: string };
type BrowserTab = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>;

const MAX_SOURCE = 1_000_000;
const THUMB_DELAY = THUMBNAIL_POLICY.debounceMs;
/** Nodes rendered per alarm, and browser tabs used in parallel for them. */
const THUMB_BATCH = THUMBNAIL_POLICY.batch;
const THUMB_TABS = THUMBNAIL_POLICY.tabs;
const THUMB_MAX_TRIES = THUMBNAIL_POLICY.maxTries;
const META_COLS = `nodes.id AS id, page_id AS pageId, parent_id AS parentId, kind, name, x, y, layout, d.text AS description, sort AS 'order', width, height, measured_h AS measuredHeight,
  src, thumb_lo AS thumbLo, thumb_hi AS thumbHi, rev, thumb_rev AS thumbRev, thumb_theme AS thumbTheme,
  (SELECT json_group_object(t.theme, json_object('rev', t.rev, 'lo', t.thumb_lo, 'hi', t.thumb_hi, 'measuredHeight', t.measured_h))
   FROM node_thumbnails t WHERE t.node_id = nodes.id AND t.thumb_lo IS NOT NULL) AS thumbnails`;
/** Node rows with their descriptions (only sections have one). */
const NODES = `nodes LEFT JOIN descriptions d ON d.id = nodes.id`;
const KINDS: NodeKind[] = ["frame", "image", "component", "section", "tokens"];
const DEFAULT_NAME: Record<NodeKind, string> = { frame: "Frame", image: "Image", component: "Component", section: "Section", tokens: "Tokens" };
const DEFAULT_WIDTH: Partial<Record<NodeKind, number>> = { tokens: 960 };
/** Kinds rendered from a source in a browser (and so get thumbnails). */
const RENDERED = `kind IN ('frame', 'component', 'tokens')`;
const PENDING_IMAGES = `kind = 'image' AND thumb_rev < rev AND thumb_tries < ${THUMB_MAX_TRIES}`;
const isRendered = (k: NodeKind) => k === "frame" || k === "component" || k === "tokens";

/** Schema migrations for each room's SQLite storage. Append only; each runs once per room. */
const MIGRATIONS = [
  `CREATE TABLE pages (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort REAL NOT NULL);
   CREATE TABLE nodes (
     id TEXT PRIMARY KEY, page_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
     x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL, measured_h REAL,
     src TEXT, thumb_lo TEXT, thumb_hi TEXT,
     rev INTEGER NOT NULL DEFAULT 1,          -- bumps when what the node renders changes
     thumb_rev INTEGER NOT NULL DEFAULT 0,    -- rev the current thumbnails show
     thumb_tries INTEGER NOT NULL DEFAULT 0,  -- failed render attempts for rev
     source TEXT NOT NULL DEFAULT '');        -- HTML (frames, components) or CSS (token sheets)
   CREATE INDEX nodes_page ON nodes(page_id);
   CREATE INDEX nodes_parent ON nodes(parent_id);`,
  // Existing specimens get the new presentation. Unpreviewed agent images enter the same bounded queue.
  `UPDATE nodes SET rev = rev + 1, thumb_tries = 0 WHERE kind IN ('component', 'tokens');
   UPDATE nodes SET rev = rev + 1, thumb_rev = 0, thumb_tries = 0, thumb_lo = NULL
     WHERE kind = 'image' AND (thumb_lo IS NULL OR thumb_lo = src);`,
  // Existing sections keep their authored geometry. New sections opt into managed layout at creation.
  `ALTER TABLE nodes ADD COLUMN layout TEXT NOT NULL DEFAULT 'free';
   ALTER TABLE nodes ADD COLUMN sort REAL NOT NULL DEFAULT 0;
   UPDATE nodes SET sort = rowid;
   CREATE INDEX nodes_sort ON nodes(sort);`,
  // Refresh existing design-system previews after removing the old specimen card presentation.
  `UPDATE nodes SET rev = rev + 1, thumb_tries = 0, measured_h = NULL WHERE kind IN ('component', 'tokens');`,
  COMMENT_SCHEMA,
  // Page and section descriptions, for agent navigation. A separate table keyed by page or node id keeps the
  // migration repeatable and leaves the pages/nodes columns that older deployments write unchanged.
  `CREATE TABLE IF NOT EXISTS descriptions (id TEXT PRIMARY KEY, text TEXT NOT NULL);`,
  // Token specimens now include named themes; refresh their cached previews and content heights.
  `UPDATE nodes SET rev = rev + 1, thumb_tries = 0, measured_h = NULL WHERE kind = 'tokens';`,
  // Older deployments can lower the recorded schema version; adding the column must survive replay.
  (sql: SqlStorage) => {
    if (!sql.exec<{ name: string }>(`PRAGMA table_info(nodes)`).toArray().some((column) => column.name === "theme")) {
      sql.exec(`ALTER TABLE nodes ADD COLUMN theme TEXT`);
    }
  },
  // Separate metadata preserves compatibility with older page writers and repeatable migrations.
  `CREATE TABLE IF NOT EXISTS page_kinds (id TEXT PRIMARY KEY, kind TEXT NOT NULL);`,
  // Preserve legacy URLs and heights. Replay after an older deployment must not relabel them.
  (sql: SqlStorage) => {
    if (sql.exec<{ name: string }>(`PRAGMA table_info(nodes)`).toArray().some((column) => column.name === "thumb_theme")) return;
    sql.exec(`ALTER TABLE nodes ADD COLUMN thumb_theme TEXT NOT NULL DEFAULT '';
   UPDATE nodes SET thumb_theme = CASE WHEN kind IN ('frame', 'component') THEN coalesce(theme, (SELECT nullif(v, '') FROM meta WHERE k = 'fileTheme'), '') ELSE '' END;
   CREATE TABLE node_thumbnails (
     node_id TEXT NOT NULL, theme TEXT NOT NULL, rev INTEGER NOT NULL,
     thumb_lo TEXT, thumb_hi TEXT, measured_h REAL, tries INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (node_id, theme));
   INSERT INTO node_thumbnails (node_id, theme, rev, thumb_lo, thumb_hi, measured_h, tries)
     SELECT id, thumb_theme, thumb_rev, thumb_lo, thumb_hi, measured_h, thumb_tries FROM nodes WHERE kind IN ('frame', 'component', 'tokens');
   CREATE TABLE used_themes (theme TEXT PRIMARY KEY, used_at INTEGER NOT NULL);
   INSERT OR IGNORE INTO used_themes SELECT coalesce((SELECT v FROM meta WHERE k = 'fileTheme'), ''), 0 WHERE EXISTS (SELECT 1 FROM nodes WHERE kind = 'frame');
   INSERT OR IGNORE INTO used_themes SELECT theme, 0 FROM nodes WHERE kind = 'frame' AND theme IS NOT NULL;
   INSERT OR REPLACE INTO meta (k, v) VALUES ('thumbReconcile', '1');`);
  },
  // The file-wide theme is gone: screens that inherited it keep its look as their own theme. Replay-safe.
  (sql: SqlStorage) => {
    const fileTheme = sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'fileTheme'`).toArray()[0]?.v;
    if (fileTheme) sql.exec(`UPDATE nodes SET theme = ? WHERE kind = 'frame' AND theme IS NULL`, fileTheme);
    sql.exec(`DELETE FROM meta WHERE k = 'fileTheme'`);
    sql.exec(`DROP TABLE IF EXISTS used_themes`);
    sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('thumbReconcile', '1')`);
  },
  // Theme switching is gone: screens render exactly their HTML. A screen's theme is written into its own
  // HTML, and a component's theme override becomes a standalone component. Replay-safe: it only touches
  // rows that still have a theme, and clears it.
  (sql: SqlStorage) => {
    const bump = `rev = rev + 1, thumb_tries = 0`;
    const frames = sql.exec<{ id: string; source: string; theme: string }>(`SELECT id, source, theme FROM nodes WHERE kind = 'frame' AND theme IS NOT NULL`).toArray();
    for (const f of frames) sql.exec(`UPDATE nodes SET source = ?, theme = NULL, ${bump} WHERE id = ?`, bakeTheme(f.source, f.theme), f.id);
    const overrides = sql.exec<{ id: string; name: string; theme: string }>(`SELECT id, name, theme FROM nodes WHERE kind = 'component' AND theme IS NOT NULL ORDER BY rowid`).toArray();
    const bumped = new Set([...frames.map((f) => f.id), ...overrides.map((o) => o.id)]);
    const tags = new Set(sql.exec<{ name: string }>(`SELECT name FROM nodes WHERE kind = 'component' AND theme IS NULL`).toArray().map((c) => componentTag(c.name)));
    for (const o of overrides) {
      const base = `${o.name} (${themeLabel(o.theme)})`;
      let name = base;
      for (let n = 2; tags.has(componentTag(name)); n++) name = `${base} ${n}`;
      tags.add(componentTag(name));
      sql.exec(`UPDATE nodes SET name = ?, theme = NULL, ${bump} WHERE id = ?`, name, o.id);
    }
    if (overrides.length) {
      // Screens and components using the formerly overriding tags render differently now.
      for (const { id } of sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE kind IN ('frame', 'component')`).toArray()) {
        if (!bumped.has(id)) sql.exec(`UPDATE nodes SET ${bump} WHERE id = ?`, id);
      }
      const rev = Number(sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'designRev'`).toArray()[0]?.v ?? 0) + 1;
      sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('designRev', ?)`, String(rev));
    }
    sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('thumbReconcile', '1')`);
  },
  // Specimens present a design system's dark theme when its tokens define one. The IQ Industries files
  // (fraxnet, fraxramp, tupredices) are dark-only at their owner's request: every screen's roots and
  // light theme wrappers become dark. Every rendered node in those files re-renders. Runs once per room,
  // even when an older deployment lowers the recorded schema version.
  (sql: SqlStorage) => {
    if (sql.exec(`SELECT 1 FROM meta WHERE k = 'darkSpecimens'`).toArray().length) return;
    sql.exec(`INSERT INTO meta (k, v) VALUES ('darkSpecimens', '1')`);
    const fileId = sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'fileId'`).toArray()[0]?.v;
    if (fileId && DARK_ONLY_FILES.has(fileId)) {
      for (const f of sql.exec<{ id: string; source: string }>(`SELECT id, source FROM nodes WHERE kind = 'frame'`).toArray()) {
        sql.exec(`UPDATE nodes SET source = ? WHERE id = ?`, darken(f.source), f.id);
      }
      sql.exec(`UPDATE nodes SET rev = rev + 1, thumb_tries = 0 WHERE kind IN ('frame', 'component', 'tokens')`);
    } else {
      sql.exec(`UPDATE nodes SET rev = rev + 1, thumb_tries = 0 WHERE kind IN ('component', 'tokens')`);
    }
    sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('thumbReconcile', '1')`);
  },
  // Backfill files render their queued previews without waiting for a viewer; see BACKFILL.
  (sql: SqlStorage) => {
    const fileId = sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'fileId'`).toArray()[0]?.v;
    if (backfilling(fileId)) sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('backfill', '1')`);
  },
  // Full documents without a doctype were rendered in quirks mode, where <body> fills the viewport, so their
  // measured heights read as the page height. Dark specimens and baked screens are such documents; frameDocument
  // now adds the doctype. Specimens and doctype-less screens re-render once to measure their real heights.
  (sql: SqlStorage) => {
    if (sql.exec(`SELECT 1 FROM meta WHERE k = 'standardsMode'`).toArray().length) return;
    sql.exec(`INSERT INTO meta (k, v) VALUES ('standardsMode', '1')`);
    sql.exec(`UPDATE nodes SET rev = rev + 1, thumb_tries = 0 WHERE kind IN ('component', 'tokens')`);
    for (const f of sql.exec<{ id: string; source: string }>(`SELECT id, source FROM nodes WHERE kind = 'frame'`).toArray()) {
      if (/^\s*<html/i.test(f.source)) sql.exec(`UPDATE nodes SET rev = rev + 1, thumb_tries = 0 WHERE id = ?`, f.id);
    }
    sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('thumbReconcile', '1')`);
  },
  // The standards-mode re-renders were queued after the IQ Industries backfill had finished, so pages nobody
  // opened kept their quirks-mode heights. Backfill files start the backfill once more to render them unviewed.
  (sql: SqlStorage) => {
    const fileId = sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'fileId'`).toArray()[0]?.v;
    if (backfilling(fileId)) sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('backfill', '1')`);
  },
];

/** Files whose owner asked for every screen in dark; see the migration that uses it. */
const DARK_ONLY_FILES = new Set(["2f86e75c-5e8a-4a4d-a5a6-5a065a943e4a", "c84c7946-be06-46d7-9b1d-c4486691dabb", "4d0f3398-96fd-4b9c-a8fc-dd7b1b75f437"]);

/** A screen in dark: dark document roots, and any authored `data-theme="light"` wrapper switched to dark. */
export function darken(source: string): string {
  return bakeTheme(source, "dark").replace(/(\sdata-theme\s*=\s*)(["']?)light\2(?=[\s>\/])/gi, '$1"dark"');
}

/** Public URL for an object in the FILES bucket (served by the worker at /a/*). */
export const fileUrl = (key: string) => `/a/${key}`;

/**
 * One instance per file. Owns the canvas (pages + nodes) in its SQLite storage, fans every change out to
 * connected browsers over hibernatable WebSockets, and renders node thumbnails in the background.
 * Browsers (WebSocket) and agents (MCP -> RPC) both write through `apply`.
 *
 * Design system: a file renders with its own token sheets and components plus its library's. When a file's
 * own design system changes it re-renders the nodes that depend on it and tells the files using it as a library.
 */
export class FileRoom extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private commentStore = new Comments(this.sql);
  private touchedAt = 0;
  private viewerAccess = new ViewerAccess();
  /** Serializes the D1 projection so a slower old write cannot overwrite the current cover. */
  private coverProjection: Promise<void> | null = null;
  private coverDirty = false;
  /** Cached library info; undefined = not fetched since wake-up. */
  private library: LibraryInfo | null | undefined;
  /** Explicit screenshots and automatic previews share one browser slot per file. */
  private browserTask: Promise<unknown> | null = null;
  private screenshotRequests = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const version = Number(this.meta("schema") ?? 0);
    for (const m of MIGRATIONS.slice(version)) {
      if (typeof m === "string") this.sql.exec(m);
      else m(this.sql);
    }
    this.setMeta("schema", String(MIGRATIONS.length));
    if (this.sql.exec(`SELECT 1 FROM pages LIMIT 1`).toArray().length === 0) {
      this.sql.exec(`INSERT INTO pages (id, name, sort) VALUES (?, ?, ?)`, crypto.randomUUID(), "Page 1", 0);
    }
    if (version < MIGRATIONS.length && this.sql.exec(`SELECT 1 FROM nodes LIMIT 1`).toArray().length) {
      this.ctx.waitUntil(this.scheduleThumbs());
    }
  }

  // ---- reads -------------------------------------------------------------

  pages(): Page[] {
    return this.sql.exec<Page>(`SELECT p.id, p.name, p.sort, coalesce(d.text, '') AS description, k.kind FROM pages p LEFT JOIN descriptions d ON d.id = p.id LEFT JOIN page_kinds k ON k.id = p.id ORDER BY p.sort, p.rowid`).toArray().map(({ kind, ...page }) => kind ? { ...page, kind } : page);
  }

  nodes(ids?: string[]): CanvasNode[] {
    if (!ids) return this.sql.exec<NodeRow>(`SELECT ${META_COLS} FROM ${NODES} ORDER BY sort, nodes.id`).toArray().map((n) => this.nodeMeta(n));
    return ids.flatMap((id) => this.sql.exec<NodeRow>(`SELECT ${META_COLS} FROM ${NODES} WHERE nodes.id = ?`, id).toArray().map((n) => this.nodeMeta(n)));
  }

  /** One node including its source. */
  node(id: string): (CanvasNode & { source: string }) | null {
    const row = this.sql.exec<NodeRow & { source: string }>(`SELECT ${META_COLS}, source FROM ${NODES} WHERE nodes.id = ?`, id).toArray()[0];
    return row ? this.nodeMeta(row) : null;
  }

  private nodeMeta<T extends NodeRow>(row: T): Omit<T, "thumbnails"> & CanvasNode {
    const thumbnails = JSON.parse(row.thumbnails ?? "{}") as ThemeThumbnails;
    return selectThumbnail(meta({ ...row, thumbnails: isRendered(row.kind) ? thumbnails : undefined, thumbTheme: isRendered(row.kind) ? row.thumbTheme : undefined }));
  }

  /** Pages with their nodes' metadata (no sources). */
  outline() {
    const nodes = this.nodes();
    return this.pages().map((p) => ({ ...p, nodes: nodes.filter((n) => n.pageId === p.id) }));
  }

  brand(): Brand { return JSON.parse(this.meta("brand") || JSON.stringify(emptyBrand())) as Brand; }

  /** Only this file's catalog is exported: libraries never re-export another library. */
  catalog() {
    const pageId = this.pages().find((p) => p.kind === "design-system")?.id ?? null;
    const nodes = this.nodes();
    return { brand: this.brand(), pageId, primitives: nodes.filter((n) => n.kind === "component" && n.pageId === pageId), tokenSheets: nodes.filter((n) => n.kind === "tokens").length };
  }

  /** The explicit choice and its current preview. A pending first preview uses the automatic fallback. */
  cover(): { nodeId: string | null; url: string | null } {
    const nodeId = this.meta("coverNodeId") || null;
    const url = this.sql.exec<{ c: string }>(
      `SELECT CASE WHEN n.kind = 'image' THEN n.thumb_lo ELSE coalesce(t.thumb_hi, t.thumb_lo, n.thumb_hi, n.thumb_lo) END AS c
       FROM nodes n JOIN pages p ON p.id = n.page_id
       LEFT JOIN node_thumbnails t ON t.node_id = n.id AND t.rev = n.rev
         AND t.theme = ''
       WHERE coalesce(t.thumb_lo, n.thumb_lo) IS NOT NULL AND n.kind IN ('frame', 'image', 'tokens', 'component')
       ORDER BY CASE WHEN n.id = ? THEN -1 WHEN n.kind = 'frame' THEN 0 WHEN n.kind = 'image' THEN 1 WHEN n.kind = 'tokens' THEN 2 ELSE 3 END,
         p.sort, p.id, n.sort, n.id LIMIT 1`, nodeId,
    ).toArray()[0]?.c ?? null;
    return { nodeId, url };
  }

  peers(): Peer[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const att = ws.deserializeAttachment() as Attachment;
      return this.currentSession(ws, att) && !att.shareToken ? [toPeer(att)] : [];
    });
  }

  /** Pages open in connected editors and view links. */
  private viewedPages(): string[] {
    const pages = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (ws.readyState !== 1 || !att || att.sessionExpiresAt <= Date.now()) continue;
      const pageId = att.presence?.pageId;
      if (pageId) pages.add(pageId);
    }
    return [...pages];
  }

  comments(): CommentThread[] { return this.commentStore.list(); }
  comment(id: string): CommentDetail { return this.commentStore.get(id); }

  createComment(fileId: string, anchor: CommentAnchor, body: string, by: Actor): CommentDetail {
    let thread!: CommentDetail;
    this.ctx.storage.transactionSync(() => {
      if (!this.pages().some((p) => p.id === anchor.pageId)) throw new Error("Page not found");
      if (anchor.nodeId) {
        const node = this.node(anchor.nodeId);
        if (!node || node.pageId !== anchor.pageId) throw new Error("The design is no longer on this page");
      }
      thread = this.commentStore.create(anchor, body, by);
    });
    this.publishComment(fileId, thread);
    return thread;
  }

  replyComment(fileId: string, id: string, body: string, by: Actor): CommentDetail {
    const thread = this.ctx.storage.transactionSync(() => this.commentStore.reply(id, body, by));
    this.publishComment(fileId, thread);
    return thread;
  }

  resolveComment(fileId: string, id: string, resolved: boolean, by: Actor): CommentDetail {
    const thread = this.ctx.storage.transactionSync(() => this.commentStore.resolve(id, resolved, by));
    this.publishComment(fileId, thread);
    return thread;
  }

  private publishComment(fileId: string, thread: CommentDetail) {
    const { messages: _messages, ...summary } = thread;
    this.broadcast({ type: "comments", threads: [summary] });
    this.touch(fileId);
  }

  /** This file's own token sheets and components (what it offers when used as a library). */
  ownDesignSystem(): DesignSystem {
    const rows = this.sql.exec<{ kind: NodeKind; name: string; source: string }>(
      `SELECT kind, name, source FROM nodes WHERE kind IN ('tokens', 'component') ORDER BY rowid`,
    ).toArray();
    return {
      tokens: rows.filter((r) => r.kind === "tokens").map((r) => r.source).join("\n"),
      components: rows.filter((r) => r.kind === "component").map((r) => ({ tag: componentTag(r.name), html: r.source })),
    };
  }

  /** Direct component instances in this file's frames and components: one entry per using node and tag. */
  instances(): { tag: string; id: string; name: string; kind: NodeKind; pageId: string }[] {
    const rows = this.sql.exec<{ id: string; name: string; kind: NodeKind; pageId: string; source: string }>(
      `SELECT id, name, kind, page_id AS pageId, source FROM nodes WHERE kind IN ('frame', 'component') AND instr(lower(source), '<x-') > 0 ORDER BY sort, id`,
    ).toArray();
    return rows.flatMap(({ source, ...node }) => [...new Set(instanceTags(source))].map((tag) => ({ tag, ...node })));
  }

  /** What this file's frames render with: its library's design system overridden by its own. */
  async designSystem(): Promise<DesignSystem & { library: { fileId: string; name: string } | null}> {
    const lib = await this.libraryInfo();
    return { ...mergeDesignSystems(lib?.design, this.ownDesignSystem()), library: lib && { fileId: lib.fileId, name: lib.name } };
  }

  private async libraryInfo(): Promise<LibraryInfo | null> {
    if (this.library !== undefined) return this.library;
    const libraryId = this.meta("libraryId");
    if (!libraryId) return (this.library = null);
    const row = await this.env.DB.prepare(`SELECT name FROM files WHERE id = ?`).bind(libraryId).first<{ name: string }>();
    if (!row) return (this.library = null);
    const stub = room(this.env, libraryId);
    const [design, catalog] = await Promise.all([stub.ownDesignSystem(), stub.catalog()]);
    return (this.library = { fileId: libraryId, name: row.name, design, catalog });
  }

  // ---- writes ------------------------------------------------------------

  /** Applies ops atomically (all or nothing), then broadcasts the resulting state. */
  async apply(fileId: string, origin: string, ops: Op[], by: Actor): Promise<void> {
    // Dependency traversal below needs inherited components too, including after hibernation.
    await this.libraryInfo();
    this.setMeta("fileId", fileId);
    this.setMeta("origin", origin);
    const touched = { pages: new Set<string>(), pageDels: new Set<string>(), nodes: new Set<string>(), nodeDels: new Set<string>() };
    const design = { tags: new Set<string>(), tokens: false };
    let renderChanged = false;
    const staleThumbs: string[] = [];
    const reconcileComments = ops.some((op) => op.t === "page.del" || op.t === "node.del" || op.t === "node.put" && op.node.pageId !== undefined);
    const before = reconcileComments && this.comments().length ? layoutRects(this.nodes(), layoutHeight) : null;
    let commentChanges: { threads: CommentThread[]; deleted: string[] } | undefined;
    const previousCoverNodeId = this.meta("coverNodeId") || null;
    const previousBrand = JSON.stringify(this.brand());
    const catalogChanged = ops.some((op) => op.t === "brand.set" || op.t === "page.put" || op.t === "page.del" || op.t === "node.del" || op.t === "node.put" && op.node.pageId !== undefined);

    this.ctx.storage.transactionSync(() => {
      for (const op of ops) {
        switch (op.t) {
          case "page.put": {
            if (op.page.kind === "design-system") {
              // Choosing another page restores the previous one to canvas without touching nodes.
              for (const p of this.pages()) if (p.kind === "design-system" && p.id !== op.page.id) {
                this.sql.exec(`DELETE FROM page_kinds WHERE id = ?`, p.id);
                touched.pages.add(p.id);
              }
            }
            this.putPage(op.page);
            touched.pages.add(op.page.id);
            break;
          }
          case "page.del": {
            if (this.pages().length <= 1) throw new Error("A file needs at least one page");
            const ids = this.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE page_id = ?`, op.id).toArray().map((r) => r.id);
            for (const id of ids) this.deleteNode(id, staleThumbs, design, touched.nodeDels);
            this.sql.exec(`DELETE FROM pages WHERE id = ?`, op.id);
            this.sql.exec(`DELETE FROM page_kinds WHERE id = ?`, op.id);
            this.describe(op.id, "");
            touched.pageDels.add(op.id);
            break;
          }
          case "node.put": {
            if (this.putNode(op.id, op.node, touched.nodes, design)) renderChanged = true;
            touched.nodes.add(op.id);
            break;
          }
          case "node.del": {
            // Deleting a section deletes everything inside it.
            const ids = new Set(op.ids.flatMap((id) => [id, ...this.descendants(id)]));
            for (const id of ids) this.deleteNode(id, staleThumbs, design, touched.nodeDels);
            break;
          }
          case "cover.set": {
            if (op.id !== null) {
              if (typeof op.id !== "string" || !op.id) throw new Error("A cover needs a frame or image ID, or null for automatic selection");
              const node = this.node(op.id);
              if (!node || (node.kind !== "frame" && node.kind !== "image")) throw new Error("Cover must be a frame or image in this file");
            }
            this.setMeta("coverNodeId", op.id ?? "");
            const cover = op.id ? this.node(op.id) : null;
            const needsPreview = cover && (cover.kind === "image" ? !cover.thumbLo : !previewCurrent(cover));
            this.setMeta("coverRender", needsPreview ? op.id! : "");
            if (needsPreview) renderChanged = true;
            break;
          }
          case "brand.set": {
            this.setMeta("brand", JSON.stringify(patchBrand(this.brand(), op.brand)));
            break;
          }
          default:
            throw new Error(`Unknown op ${(op as { t: string }).t}`);
        }
      }
      for (const id of this.invalidate(design.tokens, design.tags)) touched.nodes.add(id);
      if (design.tokens || design.tags.size) {
        this.setMeta("designRev", String(Number(this.meta("designRev") ?? 0) + 1));
        renderChanged = true;
      }
      // Only tokens affect nodes beyond the touched ones.
      const everyNode = design.tokens;
      if (renderChanged) this.reconcileThumbnails(staleThumbs, everyNode ? undefined : [...touched.nodes]);
      for (const id of touched.nodeDels) touched.nodes.delete(id);
      const coverNodeId = this.meta("coverNodeId");
      if (coverNodeId) {
        const node = this.node(coverNodeId);
        if (!node || (node.kind !== "frame" && node.kind !== "image")) this.setMeta("coverNodeId", "");
      }
      if (before) commentChanges = this.commentStore.reconcile(new Map(this.nodes().map((n) => [n.id, n])), new Set(this.pages().map((p) => p.id)), before);
    });

    const coverNodeId = this.meta("coverNodeId") || null;
    this.broadcast({
      type: "sync",
      pages: touched.pages.size ? this.pages().filter((p) => touched.pages.has(p.id)) : undefined,
      pageDels: touched.pageDels.size ? [...touched.pageDels] : undefined,
      nodes: touched.nodes.size ? this.nodes([...touched.nodes]) : undefined,
      nodeDels: touched.nodeDels.size ? [...touched.nodeDels] : undefined,
      coverNodeId: previousCoverNodeId !== coverNodeId ? coverNodeId : undefined,
      brand: previousBrand !== JSON.stringify(this.brand()) ? this.brand() : undefined,
      by,
    });
    if (commentChanges && (commentChanges.threads.length || commentChanges.deleted.length)) this.broadcast({ type: "comments", ...commentChanges });
    if (staleThumbs.length) this.ctx.waitUntil(this.env.FILES.delete([...new Set(staleThumbs)]));
    if (renderChanged) await this.scheduleThumbs();
    if (design.tokens || design.tags.size || catalogChanged) this.ctx.waitUntil(this.notifyDependents(fileId, design.tokens, [...design.tags]));
    this.updateCover(fileId);
    this.touch(fileId);
  }

  /** Upserts a page. A put without a description keeps the stored one, so a rename from a stale copy can't clobber it. */
  private putPage({ id, name, sort, description, kind }: Page) {
    if (kind !== undefined && kind !== "canvas" && kind !== "design-system") throw new Error("Page kind must be canvas or design-system");
    this.sql.exec(
      `INSERT INTO pages (id, name, sort) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort = excluded.sort`,
      str(id), str(name).slice(0, 200) || "Untitled", Number(sort) || 0,
    );
    if (description !== undefined) this.describe(str(id), description);
    if (kind === "design-system") this.sql.exec(`INSERT OR REPLACE INTO page_kinds (id, kind) VALUES (?, ?)`, str(id), kind);
    else if (kind === "canvas") this.sql.exec(`DELETE FROM page_kinds WHERE id = ?`, str(id));
  }

  /** Sets a page's or section's description; empty removes it. */
  private describe(id: string, text: string) {
    const value = str(text).trim().slice(0, DESCRIPTION_MAX);
    if (value) this.sql.exec(`INSERT OR REPLACE INTO descriptions (id, text) VALUES (?, ?)`, id, value);
    else this.sql.exec(`DELETE FROM descriptions WHERE id = ?`, id);
  }

  /**
   * Upserts a node. Returns true when what it renders changed (needs a new thumbnail).
   * Moving a section moves everything inside it; nodes that moved along are added to `touched`.
   * Design system edits are recorded in `design` so dependent nodes (and files) re-render.
   */
  private putNode(id: string, input: NodeInput, touched: Set<string>, design: { tags: Set<string>; tokens: boolean }): boolean {
    let cur = this.node(id);
    const pageId = input.pageId ?? cur?.pageId ?? this.pages()[0]!.id;
    if (!this.pages().some((p) => p.id === pageId)) throw new Error(`Unknown page ${pageId}`);
    const kind = cur?.kind ?? (KINDS.includes(input.kind!) ? input.kind! : "frame");
    if (input.layout !== undefined && (kind !== "section" || !["auto", "free"].includes(input.layout))) throw new Error("Layout must be auto or free on a section");
    if (input.order !== undefined && !Number.isFinite(input.order)) throw new Error("Order must be a finite number");
    if (input.description && kind !== "section") throw new Error("Only sections and pages have descriptions");
    // When a node leaves a managed group, its stored placeholder coordinates must become its actual
    // visible position. The same applies when changing a section's layout mode.
    if (cur) {
      const changesParent = input.parentId !== undefined && input.parentId !== cur.parentId;
      const changesPage = input.pageId !== undefined && input.pageId !== cur.pageId;
      const changesLayout = cur.kind === "section" && input.layout !== undefined && input.layout !== cur.layout;
      if (changesParent || changesPage || changesLayout) {
        this.preserveLayoutPositions(cur, touched);
        cur = this.node(id)!;
      }
    }
    // Moving to another page leaves the section unless a new one is given.
    const parentId = input.parentId !== undefined ? input.parentId : pageId !== cur?.pageId ? null : cur?.parentId ?? null;
    if (parentId) this.checkParent(id, parentId, pageId);

    const next = {
      name: str(input.name ?? cur?.name).slice(0, 200) || DEFAULT_NAME[kind],
      x: num(input.x ?? cur?.x),
      y: num(input.y ?? cur?.y),
      layout: kind === "section" ? input.layout ?? cur?.layout ?? "auto" : "free",
      order: input.order ?? cur?.order ?? (this.sql.exec<{ n: number }>(`SELECT coalesce(max(sort), 0) + 1 AS n FROM nodes`).toArray()[0]!.n),
      width: kind === "section" ? 0 : Math.max(1, num(input.width ?? cur?.width ?? DEFAULT_WIDTH[kind] ?? 400)),
      height: kind === "section" ? null : input.height === null ? null : input.height !== undefined ? Math.max(1, num(input.height)) : cur?.height ?? null,
      source: isRendered(kind) ? (input.source !== undefined ? source(input.source) : cur?.source ?? "") : "",
      src: kind === "image" ? str(input.src ?? cur?.src) : null,
    };
    if (kind === "image" && !next.src) throw new Error("Images need a src");

    if (kind === "component") {
      // One definition per tag.
      const tag = componentTag(next.name);
      const clash = this.sql.exec<{ name: string }>(`SELECT name FROM nodes WHERE kind = 'component' AND id != ?`, id)
        .toArray().find((c) => componentTag(c.name) === tag);
      if (clash) throw new Error(`Component "${clash.name}" already uses the tag <${tag}>; pick another name`);
    }

    if (kind === "section" && cur) {
      const dx = next.x - cur.x, dy = next.y - cur.y;
      if (dx || dy || pageId !== cur.pageId) {
        for (const d of this.descendants(id)) {
          this.sql.exec(`UPDATE nodes SET x = x + ?, y = y + ?, page_id = ? WHERE id = ?`, dx, dy, pageId, d);
          touched.add(d);
        }
      }
    }

    const specimenChanged = (kind === "component" || kind === "tokens") && next.name !== cur?.name;
    const changed = !cur || next.source !== cur.source || next.width !== cur.width || next.height !== cur.height || next.src !== cur.src
      || specimenChanged;
    const rev = changed ? (cur?.rev ?? 0) + 1 : cur!.rev;
    if (kind === "component" && (changed || next.name !== cur?.name)) {
      design.tags.add(componentTag(next.name));
      if (cur) design.tags.add(componentTag(cur.name));
    }
    if (kind === "tokens" && (!cur || next.source !== cur.source)) design.tokens = true;

    // Browser uploads may supply a preview. Agent/external images use the bounded thumbnail queue.
    const thumbLo = kind === "image" ? imagePreviewFor(next.src!, input.thumbLo, cur) : cur?.thumbLo ?? null;
    const thumbHi = kind === "image" ? next.src : cur?.thumbHi ?? null;
    const thumb = this.thumbState(id);
    // Token CSS follows insertion order. REPLACE must retain the rowid when a sheet moves or changes.
    this.sql.exec(
      `INSERT OR REPLACE INTO nodes (rowid, id, page_id, parent_id, kind, name, x, y, layout, sort, width, height, measured_h, src, thumb_lo, thumb_hi, rev, thumb_rev, thumb_tries, source)
       VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      str(id), str(id), pageId, parentId, kind, next.name, next.x, next.y, next.layout, next.order, next.width, next.height, cur?.measuredHeight ?? null,
      next.src, thumbLo, thumbHi, rev, isRendered(kind) ? cur?.thumbRev ?? 0 : kind === "image" && !thumbLo ? 0 : rev, changed ? 0 : thumb.tries, next.source,
    );
    if (cur?.thumbTheme !== undefined) this.sql.exec(`UPDATE nodes SET thumb_theme = ? WHERE id = ?`, cur.thumbTheme, id);
    if (kind === "section" && input.description !== undefined) this.describe(str(id), input.description);
    return changed && (isRendered(kind) || kind === "image" && !thumbLo);
  }

  /** Materializes computed positions before a node changes its page, parent or layout mode. */
  private preserveLayoutPositions(current: CanvasNode, touched: Set<string>) {
    const pageNodes = this.nodes().filter((node) => node.pageId === current.pageId);
    const rects = layoutRects(pageNodes, layoutHeight);
    const preservedIds = new Set([current.id, ...this.descendants(current.id)]);

    // If a root leaves the stack, the remaining stack keeps its current origin.
    if (!current.parentId && current.layout === "auto") {
      for (const node of pageNodes) {
        if (!node.parentId && node.kind === "section" && node.layout === "auto") preservedIds.add(node.id);
      }
    }
    for (const id of preservedIds) {
      const rect = rects.get(id)!;
      this.sql.exec(`UPDATE nodes SET x = ?, y = ? WHERE id = ?`, rect.x, rect.y, id);
      touched.add(id);
    }
  }

  private checkParent(id: string, parentId: string, pageId: string) {
    const parent = this.sql.exec<{ kind: string; pageId: string }>(`SELECT kind, page_id AS pageId FROM nodes WHERE id = ?`, parentId).toArray()[0];
    if (!parent || parent.kind !== "section") throw new Error(`Section ${parentId} not found`);
    if (parent.pageId !== pageId) throw new Error("A section's contents must be on the same page");
    if (parentId === id || this.descendants(id).includes(parentId)) throw new Error("A section can't be placed inside itself");
  }

  /** Ids of every node nested (at any depth) inside a section. */
  private descendants(id: string): string[] {
    return this.sql.exec<{ id: string }>(
      `WITH RECURSIVE d(id) AS (SELECT id FROM nodes WHERE parent_id = ? UNION SELECT n.id FROM nodes n JOIN d ON n.parent_id = d.id)
       SELECT id FROM d`, id,
    ).toArray().map((r) => r.id);
  }

  /**
   * Bumps the revision of every node whose rendering depends on changed design system parts:
   * all rendered nodes when tokens changed, else the users of the changed component tags (directly or
   * through other components). Returns the ids it bumped.
   */
  private invalidate(tokens: boolean, tags: Set<string>): Set<string> {
    const users = new Set<string>();
    if (tokens) {
      for (const r of this.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE ${RENDERED}`)) users.add(r.id);
    } else if (tags.size) {
      const comps = mergeDesignSystems(this.library?.design, this.ownDesignSystem()).components;
      for (let grew = true; grew;) {
        grew = false;
        for (const c of comps) {
          if (!tags.has(c.tag) && [...tags].some((t) => c.html.includes(`<${t}`))) {
            tags.add(c.tag);
            grew = true;
          }
        }
      }
      for (const t of tags) {
        for (const r of this.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE kind IN ('frame', 'component') AND instr(source, ?) > 0`, `<${t}`)) {
          users.add(r.id);
        }
      }
    }
    for (const id of users) this.sql.exec(`UPDATE nodes SET rev = rev + 1, thumb_tries = 0 WHERE id = ?`, id);
    return users;
  }

  /** Deletes one node, collecting its thumbnail keys and any design system change it causes. */
  private deleteNode(id: string, staleThumbs: string[], design: { tags: Set<string>; tokens: boolean }, deleted: Set<string>) {
    const n = this.node(id);
    if (!n) return;
    // Image URLs come from clients, so only rendered kinds own their stored keys.
    const raw = isRendered(n.kind) ? this.sql.exec<{ thumbLo: string | null; thumbHi: string | null }>(`SELECT thumb_lo AS thumbLo, thumb_hi AS thumbHi FROM nodes WHERE id = ?`, id).toArray()[0] : undefined;
    if (raw) staleThumbs.push(...thumbKeys(raw));
    this.sql.exec(`DELETE FROM nodes WHERE id = ?`, id);
    this.describe(id, "");
    deleted.add(id);
    if (isRendered(n.kind)) {
      for (const row of this.sql.exec<{ thumbLo: string | null; thumbHi: string | null }>(`SELECT thumb_lo AS thumbLo, thumb_hi AS thumbHi FROM node_thumbnails WHERE node_id = ?`, id)) staleThumbs.push(...thumbKeys(row));
      staleThumbs.push(...thumbKeys(n));
      this.sql.exec(`DELETE FROM node_thumbnails WHERE node_id = ?`, id);
    }
    if (n.kind === "component") design.tags.add(componentTag(n.name));
    if (n.kind === "tokens") design.tokens = true;
  }

  private thumbState(id: string) {
    return this.sql.exec<{ rev: number; tries: number }>(`SELECT thumb_rev AS rev, thumb_tries AS tries FROM nodes WHERE id = ?`, id)
      .toArray()[0] ?? { rev: 0, tries: 0 };
  }

  /** Wipes everything, including files in R2; called when the file is deleted. */
  async destroy(fileId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4404, "File deleted");
    let cursor: string | undefined;
    do {
      const list = await this.env.FILES.list({ prefix: `${fileId}/`, cursor });
      if (list.objects.length) await this.env.FILES.delete(list.objects.map((o) => o.key));
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Lets browsers show that an agent is working on nodes it is reading or screenshotting. */
  agentActivity(by: Actor, ids: string[]): void {
    if (ids.length) this.broadcast({ type: "activity", by, ids });
  }

  // ---- library -------------------------------------------------------------

  /** Links (or unlinks) the file whose design system this file uses, then re-renders everything. */
  async setLibrary(fileId: string, libraryId: string | null): Promise<void> {
    this.setMeta("fileId", fileId);
    if (libraryId) this.setMeta("libraryId", libraryId);
    else this.sql.exec(`DELETE FROM meta WHERE k = 'libraryId'`);
    await this.refreshLibrary(true, []);
  }

  /** Called by this file's library when its design system changed. */
  async libraryChanged(tokens: boolean, tags: string[]): Promise<void> {
    await this.refreshLibrary(tokens, tags);
  }

  private async refreshLibrary(tokens: boolean, tags: string[]) {
    this.setMeta("designRev", String(Number(this.meta("designRev") ?? 0) + 1));
    this.library = undefined;
    const library = await this.libraryInfo();
    this.broadcast({ type: "library", library });
    const bumped = this.invalidate(tokens, new Set(tags));
    const stale: string[] = [];
    this.reconcileThumbnails(stale);
    if (stale.length) this.ctx.waitUntil(this.env.FILES.delete([...new Set(stale)]));
    if (bumped.size) {
      this.broadcast({ type: "sync", nodes: this.nodes([...bumped]), by: null });
      await this.scheduleThumbs();
    }
  }

  /** Tells every file using this one as its library that the design system changed. */
  private async notifyDependents(fileId: string, tokens: boolean, tags: string[]) {
    const { results } = await this.env.DB.prepare(`SELECT id FROM files WHERE library_id = ?`).bind(fileId).all<{ id: string }>();
    await Promise.allSettled(results.map((r) => room(this.env, r.id).libraryChanged(tokens, tags)));
  }

  // ---- thumbnails ----------------------------------------------------------

  /**
   * Each rendered node has exactly one thumbnail row, under the empty theme key. Only that row is kept
   * at the current revision; any other row is dropped.
   * Retains the last selected raster until its replacement lands.
   * Pass `ids` when nothing file-wide (tokens) changed, so edits cost O(touched nodes).
   */
  private reconcileThumbnails(stale: string[], ids?: string[]) {
    for (const node of this.nodes(ids).filter((n) => isRendered(n.kind))) {
      // Persist the selected cache hit as the one fallback retained across future content edits.
      const raw = this.sql.exec<{ thumbLo: string | null; thumbHi: string | null }>(`SELECT thumb_lo AS thumbLo, thumb_hi AS thumbHi FROM nodes WHERE id = ?`, node.id).toArray()[0]!;
      const retained = new Set(Object.values(node.thumbnails ?? {}).flatMap((t) => thumbKeys({ thumbLo: t.lo, thumbHi: t.hi })));
      stale.push(...thumbKeys(raw).filter((key) => !retained.has(key) && !thumbKeys(node).includes(key)));
      this.sql.exec(`UPDATE nodes SET thumb_lo = ?, thumb_hi = ?, thumb_rev = ?, thumb_theme = ?, measured_h = ? WHERE id = ?`,
        node.thumbLo, node.thumbHi, node.thumbRev ?? 0, node.thumbTheme ?? "", node.measuredHeight, node.id);
      const rows = this.sql.exec<{ theme: string; rev: number; thumbLo: string | null; thumbHi: string | null }>(
        `SELECT theme, rev, thumb_lo AS thumbLo, thumb_hi AS thumbHi FROM node_thumbnails WHERE node_id = ?`, node.id,
      ).toArray();
      for (const row of rows) {
        if (row.theme !== "" || row.rev !== node.rev) {
          // The selected fallback owns its URLs until a replacement is ready.
          stale.push(...thumbKeys(row).filter((key) => !thumbKeys(node).includes(key)));
          this.sql.exec(`DELETE FROM node_thumbnails WHERE node_id = ? AND theme = ?`, node.id, row.theme);
        }
      }
      this.sql.exec(`INSERT OR IGNORE INTO node_thumbnails (node_id, theme, rev) VALUES (?, '', ?)`, node.id, node.rev);
    }
  }

  /** Migrated rows hold only their old revision; create current-revision work once. Needs the library loaded. */
  private reconcileMigrated() {
    if (!this.meta("thumbReconcile")) return;
    const stale: string[] = [];
    this.reconcileThumbnails(stale);
    this.setMeta("thumbReconcile", "");
    if (stale.length) this.ctx.waitUntil(this.env.FILES.delete([...new Set(stale)]));
  }

  private async scheduleThumbs(debounce = true) {
    if (!this.env.BROWSER || !this.env.THUMBNAIL_QUEUE || !this.hasRenderAudience()) return;
    const fileId = this.meta("fileId");
    if (!fileId) return;
    await this.libraryInfo();
    this.reconcileMigrated();
    if (!this.hasPendingThumbnails()) return;
    const readyAt = debounce ? Date.now() + THUMB_DELAY : Number(this.meta("thumbAfter") ?? 0);
    if (debounce) this.setMeta("thumbAfter", String(readyAt));
    await this.env.THUMBNAIL_QUEUE.get(this.env.THUMBNAIL_QUEUE.idFromName("global")).enqueue(fileId, readyAt);
  }

  /** Old room alarms only enqueue work; all browser access now goes through the global scheduler. */
  async alarm() { await this.scheduleThumbs(false); }

  private coverRequest() {
    const requested = this.meta("coverRender");
    return requested && requested === this.meta("coverNodeId") ? requested : null;
  }

  private hasRenderAudience() { return this.viewedPages().length > 0 || this.coverRequest() !== null || this.backfill(); }

  /** A one-off backfill renders the whole file without a viewer until it finishes or expires. */
  private backfill() { return this.meta("backfill") === "1" && backfilling(this.meta("fileId")); }

  private pendingThumbnails(limit: number = THUMB_BATCH, design?: DesignSystem) {
    return this.sql.exec<{
      id: string; kind: NodeKind; name: string; source: string; src: string | null;
      width: number; height: number | null; rev: number;
    }>(
      `SELECT n.id, n.kind, n.name, n.source, n.src, n.width, n.height, n.rev
       FROM nodes n JOIN node_thumbnails t ON t.node_id = n.id AND t.rev = n.rev
       WHERE t.thumb_lo IS NULL AND t.tries < ${THUMB_MAX_TRIES}
         AND t.theme = '' AND (? OR n.id = ?)
       ORDER BY n.page_id IN (SELECT value FROM json_each(?)) DESC, t.tries, n.sort, n.id LIMIT ?`,
      Number(this.viewedPages().length > 0 || this.backfill()), this.coverRequest(),
      JSON.stringify(this.viewedPages()), limit,
    ).toArray().map((n) => ({ ...n, html: renderedHtml(n, n.source, design) }));
  }

  private pendingImages(limit: number) {
    return this.sql.exec<{ id: string; src: string; width: number; height: number | null; rev: number }>(
      `SELECT id, src, width, height, rev FROM nodes WHERE ${PENDING_IMAGES} AND (? OR id = ?) LIMIT ?`,
      Number(this.viewedPages().length > 0 || this.backfill()), this.coverRequest(), limit,
    ).toArray().map((n) => ({ ...n, kind: "image" as const, html: "" }));
  }

  private hasPendingThumbnails() { return !!this.pendingThumbnails(1).length || !!this.pendingImages(1).length; }

  /** One bounded fair turn, one browser for the file's entire queue. Called only by ThumbnailQueue. */
  async renderThumbnails(notAfter = Date.now() + 20_000): Promise<{ more: boolean; browserMs: number; rendered: number; retryAt?: number }> {
    if (this.browserTask) return { more: true, browserMs: 0, rendered: 0 };
    return this.withFileBrowser(() => this.renderThumbnailsNow(notAfter));
  }

  private async withFileBrowser<T>(run: () => Promise<T>): Promise<T> {
    while (this.browserTask) await this.browserTask.catch(() => {});
    const task = run();
    this.browserTask = task;
    try { return await task; }
    finally { if (this.browserTask === task) this.browserTask = null; }
  }

  /** Explicit agent requests remain available without viewers or automatic preview budget. */
  async screenshotNodes(ids: string[], origin: string) {
    if (!this.env.BROWSER) throw new Error("Browser Rendering is unavailable");
    if (!ids.length || ids.length > 4) throw new Error("Request between one and four nodes");
    if (this.screenshotRequests >= 4) throw new Error("Too many pending screenshots for this file; retry shortly");
    this.screenshotRequests++;
    try {
      return await this.withFileBrowser(async () => {
        const nodes = this.nodes(ids).filter((n) => isRendered(n.kind));
        if (!nodes.length) throw new Error("No matching frames, components or token sheets");
        const design = await prepareRenderDesign(await this.designSystem());
        const coordinator = this.env.THUMBNAIL_QUEUE?.get(this.env.THUMBNAIL_QUEUE.idFromName("global"));
        let lease: string | null = null;
        const waiting = Date.now();
        if (coordinator) {
          while (!(lease = await coordinator.acquireScreenshot())) {
            if (Date.now() - waiting > 30_000) throw new Error("The shared browser is busy; retry the screenshot shortly");
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        const started = Date.now();
        let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
        let stopped = false;
        try {
          const run = async () => {
            browser = await puppeteer.launch(this.env.BROWSER!, { keep_alive: 10_000 });
            if (stopped) { await browser.close(); return { content: [] }; }
            const tab = await browser.newPage();
            const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
            for (const n of nodes) {
              if (stopped) break;
              const size = await loadFrame(tab, { ...n, html: renderedHtml(n, this.node(n.id)!.source, design) }, origin, design);
              const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
              const bytes = await capture(tab, size.width, size.height, { type: "jpeg", scale });
              content.push({ type: "text", text: `${n.name} (${n.id}) ${size.width}x${size.height}` }, { type: "image", data: bytesToBase64(bytes), mimeType: "image/jpeg" });
            }
            return { content };
          };
          return await withTimeout(run(), THUMBNAIL_POLICY.screenshotSessionMs, "screenshot session");
        } finally {
          stopped = true;
          if (browser) await withTimeout(browser.close(), 5000, "browser close");
          if (coordinator && lease) await coordinator.releaseScreenshot(lease);
          console.log("screenshot-browser", JSON.stringify({ fileId: this.meta("fileId"), screens: nodes.length, browserMs: Date.now() - started }));
        }
      });
    } finally { this.screenshotRequests--; }
  }

  private async renderThumbnailsNow(notAfter: number): Promise<{ more: boolean; browserMs: number; rendered: number; retryAt?: number }> {
    const fileId = this.meta("fileId"), base = this.meta("origin") ?? "";
    if (!this.env.BROWSER || !fileId || !this.hasRenderAudience()) return { more: false, browserMs: 0, rendered: 0 };
    const readyAt = Number(this.meta("thumbAfter") ?? 0);
    if (Date.now() < readyAt) return { more: true, browserMs: 0, rendered: 0 };
    const designRev = this.meta("designRev");
    const design = await prepareRenderDesign(await this.designSystem());
    if (Date.now() > notAfter || this.meta("designRev") !== designRev) return { more: true, browserMs: 0, rendered: 0 };
    // Edits and library refreshes reconcile when they happen; only the migration backfill remains.
    this.reconcileMigrated();
    if (!this.hasPendingThumbnails()) {
      if (this.backfill()) this.setMeta("backfill", "");
      return { more: false, browserMs: 0, rendered: 0 };
    }
    const tabCount = Math.min(THUMB_TABS, this.pendingThumbnails(THUMB_TABS).length + this.pendingImages(THUMB_TABS).length);
    const started = Date.now();
    let rendered = 0;
    let retryAt: number | undefined;
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    let stopped = false;
    try {
      const run = async () => {
        browser = await puppeteer.launch(this.env.BROWSER!, { keep_alive: 10_000 });
        if (stopped) { await browser.close(); return; }
        const tabs = await Promise.all(Array.from({ length: Math.max(1, tabCount) }, () => browser!.newPage()));
        // Re-query between batches so edits supersede queued work.
        // Stop while an edit's debounce is pending; without I/O, Date.now() cannot advance past it.
        while (!stopped && Date.now() - started < THUMBNAIL_POLICY.quantumMs && Date.now() >= Number(this.meta("thumbAfter") ?? 0)
          && this.hasRenderAudience() && this.meta("designRev") === designRev) {
          const queue = this.pendingThumbnails(THUMB_BATCH, design);
          const jobs = [...queue, ...this.pendingImages(THUMB_BATCH - queue.length)];
          if (!jobs.length) break;
          await Promise.all(tabs.map(async (tab) => {
            for (let n = jobs.shift(); n && !stopped; n = jobs.shift()) {
              if (!this.hasRenderAudience() || Date.now() < Number(this.meta("thumbAfter") ?? 0) || Date.now() - started >= THUMBNAIL_POLICY.quantumMs) break;
              // A timed-out tab is never reused; close the whole session before retrying.
              if (!await this.renderThumb(tab, n, fileId, base, design, () => !stopped && this.meta("designRev") === designRev)) { stopped = true; break; }
              rendered++;
              this.broadcast({ type: "sync", nodes: this.nodes([n.id]), by: null });
            }
          }));
        }
      };
      await withTimeout(run(), THUMBNAIL_POLICY.sessionMs, "thumbnail session");
    } catch (err) {
      retryAt = Date.now() + 30_000;
      console.warn("thumbnail session failed", String(err));
    } finally {
      stopped = true;
      if (browser) await withTimeout(browser.close(), 5000, "browser close");
    }
    const browserMs = Date.now() - started;
    console.log("thumbnail-turn", JSON.stringify({ fileId, rendered, browserMs }));
    this.updateCover(fileId);
    const more = this.hasPendingThumbnails();
    if (!more && this.backfill()) { this.setMeta("backfill", ""); console.log("thumbnail-backfill-done", JSON.stringify({ fileId })); }
    return { more: more && this.hasRenderAudience(), browserMs, rendered, retryAt };
  }

  /** Renders one node's lo/hi thumbnails into R2 and records them. Returns false if it failed or the node is gone. */
  private async renderThumb(
    tab: BrowserTab,
    n: { id: string; kind: NodeKind; src: string | null; html: string; width: number; height: number | null; rev: number },
    fileId: string,
    base: string,
    design: DesignSystem,
    valid: () => boolean,
  ) {
    let uploaded: string[] = [];
    try {
      const { measured, lo, hi } = await withTimeout((async () => {
        if (n.kind === "image") {
          const size = await loadImagePreview(tab, n.src!, base);
          return { measured: null, lo: await capture(tab, size.width, size.height, { type: "webp", scale: 1, quality: 70, transparent: true }), hi: null };
        }
        const size = await loadFrame(tab, n, base, design);
        return { ...size, ...await captureThumbnails(tab, size.width, size.height) };
      })(), 30_000, "render");
      if (!valid()) return false;
      // Attempt-specific immutable keys keep a timed-out upload from overwriting/deleting a retry.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(crypto.randomUUID()));
      const themeKey = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const key = `${fileId}/t/${n.id}-${n.rev}${n.kind === "image" ? "" : `-${themeKey}`}`;
      const meta = { httpMetadata: { contentType: "image/webp" } };
      const distinctHi = hi && hi !== lo;
      const hiUrl = fileUrl(`${key}-${distinctHi ? "hi" : "lo"}.webp`);
      uploaded = distinctHi ? [`${key}-lo.webp`, `${key}-hi.webp`] : [`${key}-lo.webp`];
      const puts = [this.env.FILES.put(uploaded[0]!, lo, meta)];
      if (distinctHi) puts.push(this.env.FILES.put(uploaded[1]!, hi, meta));
      const results = await Promise.allSettled(puts);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const cur = this.node(n.id);
      if (!valid() || !cur || cur.rev !== n.rev || n.kind !== "image" && !this.sql.exec(`SELECT 1 FROM node_thumbnails WHERE node_id = ? AND theme = '' AND rev = ?`, n.id, n.rev).toArray().length) {
        await this.env.FILES.delete(uploaded);
        return false;
      }
      if (n.kind === "image") {
        const old = thumbKeys(cur);
        this.sql.exec(`UPDATE nodes SET thumb_lo = ?, thumb_hi = ?, thumb_rev = ?, thumb_tries = 0 WHERE id = ?`, fileUrl(`${key}-lo.webp`), n.src, n.rev, n.id);
        if (old.length) this.ctx.waitUntil(this.env.FILES.delete(old));
      } else {
        this.sql.exec(`UPDATE node_thumbnails SET thumb_lo = ?, thumb_hi = ?, measured_h = ?, tries = 0 WHERE node_id = ? AND theme = '' AND rev = ?`,
          fileUrl(`${key}-lo.webp`), hiUrl, measured, n.id, n.rev);
        const old = thumbKeys(cur).filter((key) => !Object.values(cur.thumbnails ?? {}).some((t) => thumbKeys({ thumbLo: t.lo, thumbHi: t.hi }).includes(key)));
        this.sql.exec(`UPDATE nodes SET thumb_lo = ?, thumb_hi = ?, thumb_rev = ?, thumb_theme = '', measured_h = ? WHERE id = ?`,
          fileUrl(`${key}-lo.webp`), hiUrl, n.rev, measured, n.id);
        if (old.length) this.ctx.waitUntil(this.env.FILES.delete(old));
      }
      if (n.id === this.coverRequest()) this.setMeta("coverRender", "");
      return true;
    } catch (err) {
      if (uploaded.length) this.ctx.waitUntil(this.env.FILES.delete(uploaded));
      console.warn("thumbnail failed", n.id, String(err));
      // A session timeout or design change closes the browser under in-flight renders; that is not the node's fault.
      if (!valid()) return false;
      // Retried on later alarms, up to THUMB_MAX_TRIES per revision.
      if (n.kind === "image") this.sql.exec(`UPDATE nodes SET thumb_tries = thumb_tries + 1 WHERE id = ? AND rev = ?`, n.id, n.rev);
      else this.sql.exec(`UPDATE node_thumbnails SET tries = tries + 1 WHERE node_id = ? AND theme = '' AND rev = ?`, n.id, n.rev);
      return false;
    }
  }

  // ---- realtime ----------------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const sessionExpiresAt = Number(req.headers.get("x-session-expiry"));
    if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now()) {
      return new Response("A current Clerk session is required", { status: 401 });
    }
    const shareToken = req.headers.get("x-share-token") ?? undefined;
    const fileId = req.headers.get("x-file")!;
    // An outer Worker lookup can race unsharing before its upgrade reaches this room.
    if (shareToken && !await this.viewerAllowed(fileId, shareToken)) {
      return new Response("This link is no longer shared", { status: 403 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const principal: unknown = JSON.parse(req.headers.get("x-session-principal") ?? "null");
    const att: Attachment = {
      cid: crypto.randomUUID(),
      fileId,
      origin: req.headers.get("x-origin")!,
      actor: shareToken ? VIEWER : JSON.parse(req.headers.get("x-actor")!) as Actor,
      presence: { pageId: null, selection: [], cursor: null },
      sessionExpiresAt,
      ...(!shareToken && req.headers.get("x-session-id") ? { sessionId: req.headers.get("x-session-id")! } : {}),
      ...(!shareToken && isSessionPrincipal(principal) ? { principal } : {}),
      // Stamp trusted Worker configuration, never a client-supplied issuer header.
      ...(shareToken ? { shareToken } : { sessionIssuer: clerkIssuer(this.env.CLERK_PUBLISHABLE_KEY) }),
    };
    this.setMeta("fileId", att.fileId);
    this.setMeta("origin", att.origin);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);
    await this.sendInit(server, att);
    if (!shareToken && this.currentSession(server, att)) this.broadcast({ type: "peer", peer: toPeer(att) }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const att = ws.deserializeAttachment() as Attachment;
    if (!this.currentSession(ws, att)) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (att.shareToken) {
      // Link viewers only ever read sources, and only while the link is still shared.
      if (msg.type !== "source") return;
      const shared = await this.viewerAllowed(att.fileId, att.shareToken);
      if (!shared) {
        ws.close(4403, "Link sharing was turned off");
        return;
      }
    } else if (msg.type !== "presence" && !(await fileFor(this.env, att.actor.id, att.fileId))) {
      // Recheck data access after hibernation; cursor traffic stays cheap. Clerk webhook
      // reconciliation also closes revoked viewers before further broadcasts reach them.
      ws.close(4403, "Workspace access changed");
      return;
    }
    if (!this.currentSession(ws, att)) return;
    if (msg.type === "ops") {
      try {
        await this.apply(att.fileId, att.origin, msg.ops, att.actor);
      } catch (err) {
        console.warn("rejected ops", String(err));
        await this.sendInit(ws, att); // resync so the sender's optimistic state doesn't drift
      }
    } else if (msg.type === "source") {
      const self = this;
      const ids = msg.ids.slice(0, 50);
      function* items(): Generator<SourceItem> {
        for (const id of ids) {
          const n = self.node(id);
          if (n) yield { id: n.id, rev: n.rev, source: n.source };
        }
      }
      for (const batch of sourceBatches(items())) this.send(ws, { type: "source", items: batch });
    } else if (msg.type === "presence") {
      const parsed = presenceMessage.safeParse(msg.presence);
      if (!parsed.success) return;
      const pageChanged = att.presence.pageId !== parsed.data.pageId;
      att.presence = parsed.data;
      ws.serializeAttachment(att);
      if (pageChanged) await this.scheduleThumbs(false);
      this.broadcast({ type: "peer", peer: toPeer(att) }, ws);
    }
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment;
    if (!att.shareToken) this.broadcast({ type: "peer.leave", cid: att.cid }, ws);
  }

  /** Link sharing was turned off or regenerated: disconnect everyone watching through a link. */
  revokeViewers() {
    this.viewerAccess.revoke();
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment).shareToken) ws.close(4403, "Link sharing was turned off");
    }
  }

  private viewerAllowed(fileId: string, token: string) {
    return this.viewerAccess.check(() => this.env.DB.prepare(
      `SELECT 1 FROM files f JOIN workspaces w ON w.id = f.workspace_id
       WHERE f.id = ? AND f.share_token = ? AND w.clerk_organization_id IS NOT NULL`,
    ).bind(fileId, token).first());
  }

  /** Revocation reaches already-open viewers as well as their next HTTP request. */
  revokeAccess(userId?: string, reconnect = false) {
    if (!userId) this.viewerAccess.revoke();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (!userId || att.actor.id === userId) {
        ws.close(reconnect ? 4001 : 4403, reconnect ? "Session access changed" : "Workspace access changed");
      }
    }
  }

  /** Called only after the Worker verifies a fresh JWT and current file access. */
  renewSession(fileId: string, cid: string, actorId: string, sessionId: string, expiresAt: number) {
    if (!sessionId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    const issuer = clerkIssuer(this.env.CLERK_PUBLISHABLE_KEY);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (ws.readyState !== WebSocket.OPEN || att.shareToken || att.cid !== cid || att.fileId !== fileId ||
        att.actor.id !== actorId || att.sessionId !== sessionId || att.sessionIssuer !== issuer) continue;
      att.sessionExpiresAt = Math.max(att.sessionExpiresAt, expiresAt);
      ws.serializeAttachment(att);
      return { expiresAt: att.sessionExpiresAt };
    }
    return null;
  }

  private async sendInit(ws: WebSocket, att: Attachment) {
    if (!this.currentSession(ws, att)) return;
    const library = await this.libraryInfo();
    // Link viewers never learn who else is in the file.
    const peers = att.shareToken ? [] : this.peers().filter((p) => p.cid !== att.cid);
    this.send(ws, { type: "init", pages: this.pages(), nodes: this.nodes(), cid: att.cid, peers, library,
      coverNodeId: this.meta("coverNodeId") || null,
      brand: this.brand(),
      comments: att.shareToken ? [] : this.comments(),
      ...(!att.shareToken && att.principal ? { principal: att.principal } : {}),
      ...(!att.shareToken && att.sessionId ? { sessionExpiresAt: att.sessionExpiresAt } : {}) });
  }

  private broadcast(msg: ServerMsg, except?: WebSocket) {
    const data = JSON.stringify(msg);
    const publicMessage = viewerMessage(msg);
    const publicData = publicMessage === msg ? data : publicMessage && JSON.stringify(publicMessage);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const viewing = (ws.deserializeAttachment() as Attachment | undefined)?.shareToken;
      if (viewing && !publicData) continue;
      if (!this.currentSession(ws)) continue;
      try {
        ws.send(viewing ? publicData! : data);
      } catch {}
    }
  }

  /** Hibernation-safe: every read/write path checks the persisted lease and its Clerk instance. */
  private currentSession(ws: WebSocket, att = ws.deserializeAttachment() as Attachment | undefined) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (typeof att?.sessionExpiresAt !== "number" || !Number.isFinite(att.sessionExpiresAt) || att.sessionExpiresAt <= Date.now()) {
      try { ws.close(4001, "Session expired; reconnect"); } catch {}
      return false;
    }
    if (!att.shareToken) {
      try {
        if (att.sessionIssuer === clerkIssuer(this.env.CLERK_PUBLISHABLE_KEY)) return true;
      } catch {}
      try { ws.close(4001, "Sign-in configuration changed; reconnect"); } catch {}
      return false;
    }
    return true;
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    if (this.currentSession(ws)) ws.send(JSON.stringify(msg));
  }

  // ---- misc --------------------------------------------------------------

  private meta(k: string) {
    return this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]?.v ?? null;
  }

  private setMeta(k: string, v: string) {
    this.sql.exec(`INSERT OR REPLACE INTO meta VALUES (?, ?)`, k, v);
  }

  /** Mirrors the chosen preview into D1. Failed writes remain eligible for the next activity's retry. */
  private updateCover(fileId: string) {
    this.coverDirty = true;
    if (this.coverProjection) return;
    const project = async () => {
      do {
        this.coverDirty = false;
        const cover = this.cover().url ?? "";
        if (cover === (this.meta("cover") ?? "")) continue;
        await this.env.DB.prepare(`UPDATE files SET cover = ? WHERE id = ?`).bind(cover || null, fileId).run();
        this.setMeta("cover", cover);
      } while (this.coverDirty);
    };
    this.coverProjection = project().finally(() => {
      this.coverProjection = null;
      if (this.coverDirty) this.updateCover(fileId);
    });
    this.ctx.waitUntil(this.coverProjection);
  }

  /** Bumps files.updated_at in D1 at most once a minute. */
  private touch(fileId: string) {
    const now = Date.now();
    if (now - this.touchedAt < 60_000) return;
    this.touchedAt = now;
    this.ctx.waitUntil(this.env.DB.prepare(`UPDATE files SET updated_at = ? WHERE id = ?`).bind(now, fileId).run().then(() => {}));
  }
}

const thumbKeys = (n: Pick<CanvasNode, "thumbLo" | "thumbHi">) =>
  [n.thumbLo, n.thumbHi].filter((u): u is string => Boolean(u && /^\/a\/[^/]+\/t\//.test(u))).map((u) => u.slice(3));
const toPeer = (a: Attachment): Peer => ({ ...a.actor, pageId: a.presence.pageId, selection: a.presence.selection, cursor: a.presence.cursor, cid: a.cid });
const str = (v: unknown) => String(v ?? "");
/** Most nodes have no description; leaving the empty field out keeps sync payloads for large pages lean. */
const meta = <T extends CanvasNode>(row: T): T => {
  if (!row.description) delete row.description;
  return row;
};
/** Exact custom-element tags opened in HTML, so `<x-button>` doesn't count as `<x-button-primary>`. */
const instanceTags = (html: string) => [...html.matchAll(/<(x-[a-z0-9-]+)(?=[\s/>])/gi)].map((m) => m[1]!.toLowerCase());
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const source = (v: unknown) => {
  const s = str(v);
  if (s.length > MAX_SOURCE) throw new Error(`Source exceeds ${MAX_SOURCE} characters`);
  return s;
};

/**
 * Wrangler generates resource bindings; secrets must also be known without a local .dev.vars file.
 * Browser Rendering is optional, so deployments may omit that binding entirely.
 */
type Env = Omit<CloudflareBindings, "BROWSER" | "THUMBNAIL_QUEUE"> & {
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_WEBHOOK_SIGNING_SECRET: string;
  APP_ORIGIN?: string;
  BROWSER?: BrowserRun;
  /** Shared with a render host, which presents it to park its browsers. See worker/render-host.ts. */
  RENDER_HOST_TOKEN?: string;
  /** Workspace ids whose files render on a render host, comma separated, or `*` for every workspace. */
  RENDER_HOST_WORKSPACES?: string;
  /** Absent configurations fail closed: no unbudgeted automatic browser work. */
  THUMBNAIL_QUEUE?: DurableObjectNamespace<import("./thumbnail-queue").ThumbnailQueue>;
};

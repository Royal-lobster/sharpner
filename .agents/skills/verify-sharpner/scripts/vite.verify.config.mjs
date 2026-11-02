// Verification-only Vite config. `verify.mjs launch` starts Vite with it; do not run it by hand.
//
// It reuses the repository's vite.config.ts and swaps only the Cloudflare plugin, so that:
// - the Worker reads a generated, production-free Wrangler config (no routes, no APP_ORIGIN),
// - D1, R2 and Durable Object state lives in this run's scratch directory, not .wrangler/state,
// - no binding can be remote (remoteBindings: false), and no inspector port collides.
import { cloudflare } from "@cloudflare/vite-plugin";
import base from "../../../../vite.config.ts";

const scratch = process.env.VERIFY_SHARPNER_SCRATCH;
if (!scratch) throw new Error("VERIFY_SHARPNER_SCRATCH is not set. Start the app with `verify.mjs launch`.");

const isCloudflare = (plugin) => Boolean(plugin && typeof plugin === "object" && typeof plugin.name === "string" && plugin.name.startsWith("vite-plugin-cloudflare"));
const flat = (base.plugins ?? []).flat(Infinity);
const at = flat.findIndex(isCloudflare);
if (at < 0) throw new Error("vite.config.ts no longer uses @cloudflare/vite-plugin. Update the verify-sharpner skill.");
const plugins = flat.filter((plugin) => !isCloudflare(plugin));
plugins.splice(at, 0, cloudflare({
  configPath: `${scratch}/wrangler.verify.json`,
  persistState: { path: `${scratch}/state` },
  remoteBindings: false,
  inspectorPort: false,
}));

export default {
  ...base,
  plugins,
  cacheDir: `${scratch}/vite-cache`,
  clearScreen: false,
  server: { ...base.server, host: "127.0.0.1", strictPort: true },
};

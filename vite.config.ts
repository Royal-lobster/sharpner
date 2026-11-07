import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { execSync } from "node:child_process";
import { editorPreload } from "./vite.editor-preload";

/** Stamps a production build so the browser and the Worker can tell they came from the same deploy. */
function buildId(command: string) {
  if (command !== "build") return "dev";
  // The config is evaluated once per environment (browser, Worker); the process keeps one id for both.
  if (process.env.SHARPNER_BUILD) return process.env.SHARPNER_BUILD;
  let commit = "";
  try { commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* not a checkout */ }
  return (process.env.SHARPNER_BUILD = `${commit || "build"}-${Date.now().toString(36)}`);
}

export default defineConfig(({ command }) => ({
  define: { __SHARPNER_BUILD__: JSON.stringify(buildId(command)) },
  plugins: [react(), tailwindcss(), cloudflare(), editorPreload()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
}));

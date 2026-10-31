import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { editorPreload } from "./vite.editor-preload";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), editorPreload()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});

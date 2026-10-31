import { effectiveTheme, themeNames } from "../shared/themes";
import type { CanvasNode } from "../shared/types";

/** Automatic previews have a shared budget. Explicit agent screenshots use their own request path. */
export const THUMBNAIL_POLICY = {
  debounceMs: 1200,
  tabs: 4,
  batch: 24,
  maxTries: 3,
  // Includes the current theme; only previously selected, still-declared themes are warmed.
  maxThemes: 4,
  quantumMs: 8000,
  sessionMs: 20_000,
  // Browser lifetime is reserved before starting, then refunded to actual elapsed time.
  reservationMs: 45_000,
  screenshotSessionMs: 110_000,
  screenshotLeaseMs: 150_000,
  fileDailyMs: 90_000,
  teamDailyMs: 180_000,
  globalDailyMs: 900_000,
  maxQueuedFiles: 1000,
} as const;

export function thumbnailThemes(node: Pick<CanvasNode, "kind" | "theme">, fileTheme: string | null, used: string[], tokens: string): string[] {
  const current = effectiveTheme(node, fileTheme) ?? "";
  if (node.kind === "tokens" || node.theme || node.kind === "image" || node.kind === "section") return [current];
  const declared = new Set(["", ...themeNames(tokens)]);
  return [...new Set([current, ...used.filter((theme) => declared.has(theme))])].slice(0, THUMBNAIL_POLICY.maxThemes);
}

/** Automatic previews have a shared budget. Explicit agent screenshots use their own request path. */
/**
 * One-off backfill: these files re-render every preview without a viewer and outside the per-file and
 * per-workspace daily budgets (the global budget still applies) until `until`. Requested by the owner
 * after the dark-only migration queued every preview in the IQ Industries files.
 */
export const BACKFILL = {
  files: new Set(["2f86e75c-5e8a-4a4d-a5a6-5a065a943e4a", "c84c7946-be06-46d7-9b1d-c4486691dabb", "4d0f3398-96fd-4b9c-a8fc-dd7b1b75f437"]),
  until: Date.UTC(2026, 10, 4),
};
export const backfilling = (fileId: string | undefined, now = Date.now()) => !!fileId && BACKFILL.files.has(fileId) && now < BACKFILL.until;

export const THUMBNAIL_POLICY = {
  debounceMs: 1200,
  tabs: 4,
  batch: 24,
  maxTries: 3,
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

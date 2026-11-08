/** Automatic previews have a shared budget. Explicit agent screenshots use their own request path. */
/**
 * One-off backfill: these files re-render every preview without a viewer until `until`. Requested by the
 * owner after the dark-only migration queued every preview in the IQ Industries files. They spend their
 * own daily budget first, then the normal budgets, and wait behind files someone is viewing.
 */
export const BACKFILL = {
  // Extended on 4 Nov 2026 to re-render every component preview after the compact-specimen migrations, and the
  // owner's sharpner file added.
  files: new Set(["2f86e75c-5e8a-4a4d-a5a6-5a065a943e4a", "c84c7946-be06-46d7-9b1d-c4486691dabb", "4d0f3398-96fd-4b9c-a8fc-dd7b1b75f437", "040cd02e-2da6-478a-b9a6-ff4d8d7c11cb"]),
  until: Date.UTC(2026, 10, 5, 12),
};
export const backfilling = (fileId: string | undefined, now = Date.now()) => !!fileId && BACKFILL.files.has(fileId) && now < BACKFILL.until;

export const THUMBNAIL_POLICY = {
  debounceMs: 1200,
  tabs: 4,
  // Nodes queried per batch. Each tab renders a sprite of up to SPRITE_LIMITS.nodes of them from one page.
  batch: 96,
  maxTries: 3,
  quantumMs: 8000,
  // A file with no other file waiting keeps its browser longer, so fewer turns pay for a browser launch.
  soloQuantumMs: 15_000,
  // A sprite still running when the quantum ends finishes; a sprite past spriteMs ends the session.
  spriteMs: 20_000,
  sessionMs: 40_000,
  // Idle browser time is billed like rendering, and a reconnect saves only about 1 s of a 1.5 s launch, so a turn
  // keeps its browser only when more work is due at once: its file has previews left, or another file is waiting.
  // The next turn then reconnects within warmMs; otherwise the queue closes the browser. In production on 7 Nov 2026,
  // a 60 s keep-alive after every turn billed 3.7 idle hours in 15 hours to save 0.2 hours of launches.
  warmMs: 3_000,
  // Browser Run's own idle limit, in case the queue's close fails.
  keepAliveMs: 60_000,
  // Browser lifetime is reserved before starting, then refunded to actual elapsed time.
  reservationMs: 60_000,
  screenshotSessionMs: 110_000,
  screenshotLeaseMs: 150_000,
  // Daily budgets were 30 min per file, 60 min per team, 4 h overall and 60 min of backfill. The owner lifted them
  // on 4 Nov 2026 until someone abuses previews; spend is still recorded per file and team, so they can return.
  fileDailyMs: 1_000_000_000,
  teamDailyMs: 1_000_000_000,
  globalDailyMs: 1_000_000_000,
  backfillDailyMs: 1_000_000_000,
  maxQueuedFiles: 1000,
} as const;

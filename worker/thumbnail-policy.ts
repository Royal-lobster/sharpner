/** Automatic previews have a shared budget. Explicit agent screenshots use their own request path. */
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

/** The small preview belongs to an image source, not to its canvas position or size. */
export function imagePreviewFor(src: string, supplied?: string | null, previous?: { src: string | null; thumbLo: string | null } | null): string | null {
  const preview = supplied !== undefined ? supplied : previous?.src === src ? previous.thumbLo : null;
  return preview && preview !== src ? preview : null;
}

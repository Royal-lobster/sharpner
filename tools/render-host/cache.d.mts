export interface StringCache {
  get(hash: string): string | undefined;
  put(hash: string, text: string): boolean;
  stats(): { strings: number; megabytes: number };
}
export function createCache(dir: string | null, limits?: { diskBytes?: number; memoryChars?: number }): StringCache;
export function rewrite(raw: string, cache: StringCache): { forward?: string; reply?: string; hits?: number; stored?: number };
export const CACHED: string, STORE: string, MISSING: string;

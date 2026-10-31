export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type TokenGetter = ((options?: { skipCache?: boolean }) => Promise<string | null>) | null;
let tokenGetter: TokenGetter = null;
export const setApiTokenGetter = (getter: TokenGetter) => { tokenGetter = getter; };

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown; freshToken?: boolean }): Promise<T> {
  const auth = tokenGetter;
  const token = await auth?.(init?.freshToken ? { skipCache: true } : undefined);
  if (auth !== tokenGetter) throw new DOMException("The signed-in account changed.", "AbortError");
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (auth !== tokenGetter) throw new DOMException("The signed-in account changed.", "AbortError");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new HttpError(res.status, body?.error ?? res.statusText);
  }
  const data = res.status === 204 ? undefined : await res.json();
  if (auth !== tokenGetter) throw new DOMException("The signed-in account changed.", "AbortError");
  return data as T;
}

export type User = { id: string; login: string; name: string; avatar_url: string | null };
export type Workspace = { id: string; clerkOrganizationId: string; name: string; role: "owner" | "member" };
export type Member = User & { role: "owner" | "member" };
export type FileSummary = { id: string; name: string; cover: string | null; library_id: string | null; used_by: number; created_at: number; updated_at: number };
export type FileInfo = { id: string; name: string; workspace_id: string; library_id: string | null };

/** Uploads an image plus a ≤400px WebP preview generated in the browser. Returns URLs and natural size. */
export async function uploadImage(fileId: string, file: File) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const form = new FormData();
  form.append("file", file);
  if (width > 400 && file.type !== "image/gif" && file.type !== "image/svg+xml") {
    const scale = 400 / width;
    const canvas = new OffscreenCanvas(400, Math.max(1, Math.round(height * scale)));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    form.append("preview", new File([await canvas.convertToBlob({ type: "image/webp", quality: 0.75 })], "preview.webp", { type: "image/webp" }));
  }
  bitmap.close();
  const urls = await api<{ src: string; preview: string }>(`/files/${fileId}/assets`, { method: "POST", body: form });
  return { ...urls, width, height };
}

export function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [[60, "m"], [3600, "h"], [86400, "d"], [604800, "w"]];
  let label = `${Math.floor(s / 60)}m`;
  for (const [sec, u] of units) if (s >= sec) label = `${Math.floor(s / sec)}${u}`;
  return `${label} ago`;
}

export function colorFor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 75% 68%)`;
}

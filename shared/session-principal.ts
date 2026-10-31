/** Clerk's verified browser identity. Local author/workspace IDs are projections, not identity. */
export type SessionPrincipal = {
  clerkUserId: string;
  sessionId: string;
  organizationId: string | null;
};

export function isSessionPrincipal(value: unknown): value is SessionPrincipal {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<SessionPrincipal>;
  return typeof p.clerkUserId === "string" && !!p.clerkUserId && typeof p.sessionId === "string" && !!p.sessionId
    && (p.organizationId === null || (typeof p.organizationId === "string" && !!p.organizationId));
}

export function samePrincipal(a: unknown, b: unknown): boolean {
  return isSessionPrincipal(a) && isSessionPrincipal(b) && a.clerkUserId === b.clerkUserId
    && a.sessionId === b.sessionId && a.organizationId === b.organizationId;
}

import { ClerkProvider, SignIn, useAuth, useClerk } from "@clerk/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { api, HttpError, setApiTokenGetter, type User, type Workspace } from "./api";
import { Editor, SharedEditor } from "./Editor";
import { Home } from "./Home";
import { useLocation } from "./router";
import { Loading, Notice } from "./states";
import { Button } from "@/components/ui/button";
import { LoginShowcase } from "./LoginShowcase";

export type Me = { user: User; workspaces: Workspace[]; activeWorkspaceId: string | null };
export type AgentConnectionConfig = { mcpClientId: string | null; mcpCallbackPort: number | null; agentKeysEnabled: boolean };
type AuthConfig = { publishableKey: string; configured: boolean; appOrigin?: string } & AgentConnectionConfig;

type Appearance = NonNullable<ComponentProps<typeof ClerkProvider>["appearance"]>;

// Clerk sizes everything in rem from the document root (16px); the app's own type is set on <body>.
const appearance = {
  variables: {
    colorPrimary: "var(--primary)", colorPrimaryForeground: "var(--primary-foreground)", colorBackground: "var(--card)",
    colorForeground: "var(--foreground)", colorMutedForeground: "var(--muted-foreground)", colorNeutral: "var(--foreground)", colorInput: "var(--background)",
    colorInputForeground: "var(--foreground)", colorBorder: "var(--foreground)", colorDanger: "var(--destructive)", colorShadow: "#000",
    colorModalBackdrop: "#000",
    fontFamily: "var(--font)", fontSize: "0.75rem", borderRadius: "var(--radius-md)",
  },
  options: { shimmer: false, logoImageUrl: "/mark.svg" },
  elements: {
    userButtonTrigger: { padding: "0.25rem", borderRadius: "999px", minWidth: "2.75rem", minHeight: "2.75rem" },
    userButtonAvatarBox: { width: "2rem", height: "2rem" },
    userButtonPopoverCard: { width: "min(22rem, calc(100vw - 1.5rem))" },
    organizationSwitcherPopoverCard: { width: "min(22rem, calc(100vw - 1.5rem))" },
    modalContent: { maxWidth: "calc(100vw - 1rem)" },
  },
} satisfies Appearance;

/** Embed Clerk's form directly in the page; verification and recovery keep their own headings. */
const signInAppearance = {
  options: { logoPlacement: "none", socialButtonsVariant: "blockButton" },
  elements: {
    rootBox: { width: "100%", maxWidth: "100%", minWidth: 0 },
    cardBox: { width: "100%", maxWidth: "100%", minWidth: 0, borderRadius: 0, border: 0, boxShadow: "none", background: "transparent" },
    card: { width: "100%", minWidth: 0, maxWidth: "100%", margin: 0, padding: 0, gap: "1.5rem", boxShadow: "none", border: 0, borderRadius: 0, background: "transparent" },
    footer: { padding: "1rem 0 0", background: "transparent", backgroundImage: "none", border: 0, borderRadius: 0, boxShadow: "none" },
    headerTitle: { fontSize: "0.9375rem", fontWeight: 600, letterSpacing: "-0.01em" },
    headerSubtitle: { fontSize: "0.875rem" },
    identityPreview: { width: "100%", minWidth: 0 },
    identityPreviewText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    socialButtonsBlockButton: { minHeight: "2.75rem", fontSize: "0.75rem", backgroundColor: "var(--secondary)", border: "1px solid var(--input)", boxShadow: "none" },
    formFieldInput: { minHeight: "2.75rem", fontSize: "1rem", border: "1px solid var(--input)", backgroundColor: "var(--background)", boxShadow: "none" },
    formFieldLabel: { fontSize: "0.8125rem" },
    otpCodeFieldInputs: { width: "100%", gap: "0.375rem", justifyContent: "center" },
    otpCodeFieldInput: { width: "2rem", height: "2.75rem", minWidth: 0, fontSize: "1rem" },
    formButtonPrimary: { minHeight: "2.75rem", fontSize: "0.8125rem", fontWeight: 500 },
    formResendCodeLink: { minHeight: "2.75rem", fontSize: "0.875rem" },
    identityPreviewEditButton: { minWidth: "2.75rem", minHeight: "2.75rem", flexShrink: 0 },
    footerActionLink: { fontSize: "0.875rem", padding: "0.5rem 0.25rem" },
    footerActionText: { fontSize: "0.875rem" },
  },
} satisfies Appearance;

export function App() {
  // View links need no account, so they never wait on sign-in.
  const shared = useLocation().match(/^\/s\/([A-Za-z0-9_-]{43})\/?(?:\?|$)/);
  if (shared) return <SharedEditor token={shared[1]!} />;
  return <SignedApp />;
}

function SignedApp() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    const preload = (window as Window & { __sharpnerAuthConfig?: Promise<AuthConfig> }).__sharpnerAuthConfig;
    const pending = attempt === 0 && preload ? preload : fetch("/auth/config", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Sign-in could not be loaded.");
      return response.json() as Promise<AuthConfig>;
    });
    pending.then((config) => {
      if (controller.signal.aborted) return;
      if (config.appOrigin && config.appOrigin !== location.origin) {
        location.replace(`${config.appOrigin}${location.pathname}${location.search}${location.hash}`);
        return;
      }
      setConfig(config);
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [attempt]);

  if (error) return <AuthMessage message={error} onRetry={() => setAttempt(attempt + 1)} />;
  if (!config) return <Loading label="Opening Sharpner…" />;
  if (!config.configured || !config.publishableKey) return <AuthMessage message="Sign-in is not configured for this app yet." />;
  return (
    <ClerkProvider publishableKey={config.publishableKey} appearance={appearance}
      signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/">
      <ClerkApp agentConfig={config} />
    </ClerkProvider>
  );
}

function ClerkApp({ agentConfig }: { agentConfig: AgentConnectionConfig }) {
  const { isLoaded, isSignedIn, userId, orgId, getToken } = useAuth();
  const loc = useLocation();
  // Initialize before child effects; replacing the getter cancels requests waiting for an old token.
  useLayoutEffect(() => {
    setApiTokenGetter(isSignedIn ? (options) => getToken(options) : null);
    return () => setApiTokenGetter(null);
  }, [getToken, isSignedIn, userId, orgId]);

  if (!isLoaded) return <Loading label="Connecting…" />;
  if (!isSignedIn) {
    const returnTo = loc.startsWith("/") && !loc.startsWith("//") ? loc : "/";
    return (
      <main className="login">
        <section className="login-stage" aria-hidden>
          <LoginShowcase />
        </section>
        <div className="login-panel">
          <div className="login-intro rise">
            <h1 className="login-brand"><img src="/mark.svg" width={32} height={32} alt="" />Sharpner</h1>
            <p>Design with your team and your agents on one canvas.</p>
          </div>
          <div className="login-card rise" style={{ animationDelay: "60ms" }}>
            <SignIn routing="hash" withSignUp forceRedirectUrl={returnTo} signUpForceRedirectUrl={returnTo} appearance={signInAppearance} />
          </div>
        </div>
      </main>
    );
  }
  // An identity or workspace change must never retain a previous editor's socket or data.
  return <AuthenticatedApp key={`${userId}:${orgId ?? "none"}`} agentConfig={agentConfig} />;
}

function AuthenticatedApp({ agentConfig }: { agentConfig: AgentConnectionConfig }) {
  const loc = useLocation();
  const path = new URL(loc, location.origin).pathname;
  const file = path.match(/^\/f\/([\w-]+)\/?$/);
  // File metadata includes the verified author; opening a deep link does not need a workspace bootstrap first.
  if (file) return <Editor key={file[1]} fileId={file[1]!} />;
  return <WorkspaceHome agentConfig={agentConfig} />;
}

function WorkspaceHome({ agentConfig }: { agentConfig: AgentConnectionConfig }) {
  const clerk = useClerk();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const request = useRef(0);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    const seq = ++request.current;
    setError(null);
    setExpired(false);
    const data = await api<Me>("/me");
    if (alive.current && request.current === seq) setMe(data);
    return data;
  }, []);
  useEffect(() => {
    let current = true;
    alive.current = true;
    void reload().catch((e: Error) => {
      if (!current || e.name === "AbortError") return;
      const expired = e instanceof HttpError && e.status === 401;
      setExpired(expired);
      setError(expired ? "Your session has expired. Sign in again to continue." : e.message);
    });
    return () => { current = false; alive.current = false; request.current++; };
  }, [reload]);

  if (error) return <AuthMessage message={error} action={expired ? "Sign in again" : "Try again"} onRetry={() => {
    if (expired) void clerk.signOut({ redirectUrl: location.href }).catch((e: Error) => setError(e.message));
    else location.reload();
  }} />;
  if (!me) return <Loading label="Loading your workspace…" />;
  return <Home me={me} agentConfig={agentConfig} />;
}

function AuthMessage({ message, onRetry, action = "Try again" }: { message: string; onRetry?: () => void; action?: string }) {
  return <Notice title="Sharpner is unavailable" message={message} action={onRetry && <Button onClick={onRetry}>{action}</Button>} />;
}

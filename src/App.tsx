import { ClerkProvider, useAuth, useClerk } from "@clerk/react";
import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { api, HttpError, setApiTokenGetter, type FileSummary, type User, type Workspace } from "./api";
import { Home } from "./Home";
import { useLocation } from "./router";
import { Loading, Notice } from "./states";
import { Button } from "@/components/ui/button";

type EditorModule = typeof import("./Editor");
let editorModule: EditorModule | null = null;
const loadEditor = () => import("./Editor").then((module) => { editorModule = module; return module; });
// Signed-in startup never downloads the introduction.
const Landing = lazy(() => import("./Landing").then((module) => ({ default: module.Landing })));

export type Me = { user: User; workspaces: Workspace[]; activeWorkspaceId: string | null; files: FileSummary[] };
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

export function App() {
  const loc = useLocation();
  // File links download the editor while sign-in initializes, rather than after it.
  useEffect(() => {
    if (/^\/f\/[\w-]+\/?(?:\?|$)/.test(loc)) void loadEditor().catch(() => {});
  }, [loc]);
  // View links need no account, so they never wait on sign-in.
  const shared = loc.match(/^\/s\/([A-Za-z0-9_-]{43})\/?(?:\?|$)/);
  return (
    <DestinationBoundary key={shared ? shared[1] : "signed"}>
      <Suspense fallback={<OpeningLoading />}>
        {shared ? <EditorRoute token={shared[1]!} /> : <SignedApp />}
      </Suspense>
    </DestinationBoundary>
  );
}

/** Keep file bootstrap outside Suspense's fallback delay, including when the editor is already cached. */
function EditorRoute(props: { fileId: string; token?: never } | { token: string; fileId?: never }) {
  const [loaded, setLoaded] = useState(() => editorModule);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (loaded) return;
    let current = true;
    void loadEditor().then((module) => { if (current) setLoaded(module); })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [loaded]);
  if (failed) throw new Error("The editor could not be loaded.");
  if (!loaded) return <OpeningLoading />;
  return props.token !== undefined ? <loaded.SharedEditor token={props.token} /> : <loaded.Editor fileId={props.fileId} />;
}

class DestinationBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <AuthMessage message="Sharpner could not finish loading. Check your connection and try again." onRetry={() => location.reload()} />
      : this.props.children;
  }
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
  if (!config) return <OpeningLoading />;
  if (!config.configured || !config.publishableKey) return <AuthMessage message="Sign-in is not configured for this app yet." />;
  return (
    <ClerkProvider publishableKey={config.publishableKey} appearance={appearance}
      signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/">
      <ClerkApp agentConfig={config} />
    </ClerkProvider>
  );
}

function ClerkApp({ agentConfig }: { agentConfig: AgentConnectionConfig }) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, userId, orgId, getToken } = useAuth();
  const loc = useLocation();
  // Initialize before child effects; replacing the getter cancels requests waiting for an old token.
  useLayoutEffect(() => {
    setApiTokenGetter(isSignedIn ? (options) => getToken(options) : null);
    return () => setApiTokenGetter(null);
  }, [getToken, isSignedIn, userId, orgId]);

  if (!isLoaded) return <OpeningLoading />;
  if (!isSignedIn) {
    // Clerk's hosted sign-in returns to the exact file, page and selection that was opened.
    const returnTo = new URL(loc.startsWith("/") && !loc.startsWith("//") ? loc : "/", location.origin).href;
    return <Landing onSignIn={() => clerk.redirectToSignIn({ signInForceRedirectUrl: returnTo, signUpForceRedirectUrl: returnTo })} />;
  }
  // An identity or workspace change must never retain a previous editor's socket or data.
  return <AuthenticatedApp key={`${userId}:${orgId ?? "none"}`} agentConfig={agentConfig} />;
}

function AuthenticatedApp({ agentConfig }: { agentConfig: AgentConnectionConfig }) {
  const loc = useLocation();
  const path = new URL(loc, location.origin).pathname;
  const file = path.match(/^\/f\/([\w-]+)\/?$/);
  // File metadata includes the verified author; opening a deep link does not need a workspace bootstrap first.
  if (file) return <EditorRoute key={file[1]} fileId={file[1]!} />;
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
  if (!me) return <OpeningLoading />;
  return <Home key={me.activeWorkspaceId ?? "none"} me={me} agentConfig={agentConfig} />;
}

/** Every step before the destination renders keeps its label; a file opens straight onto its canvas. */
function OpeningLoading() {
  const path = new URL(useLocation(), location.origin).pathname;
  if (/^\/s\//.test(path)) return <Loading label="Opening shared file…" canvas />;
  return /^\/f\/[\w-]+\/?$/.test(path) ? <Loading label="Opening file…" canvas /> : <Loading label="Opening Sharpner…" />;
}

function AuthMessage({ message, onRetry, action = "Try again" }: { message: string; onRetry?: () => void; action?: string }) {
  return <Notice title="Sharpner is unavailable" message={message} action={onRetry && <Button onClick={onRetry}>{action}</Button>} />;
}

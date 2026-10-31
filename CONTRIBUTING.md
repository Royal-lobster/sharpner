# Contributing to Sharpner

Small, readable changes are welcome. For a bug, include steps to reproduce it.
For a larger feature, open an issue first so we can agree on the behavior and scope.

## Prerequisites

- Node.js 24 or newer and pnpm 11.17.0 (`packageManager` pins the version).
- Your own Clerk application with Organizations enabled.
- A Cloudflare account for deployment. Local D1, R2, and Durable Objects are emulated.

## Run locally

```sh
git clone https://github.com/Royal-lobster/sharpner.git
cd sharpner
pnpm install --frozen-lockfile
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
```

Fill in the Clerk publishable and secret keys in `.dev.vars`, then run:

```sh
pnpm db:migrate
pnpm dev
```

Vite serves the app and Worker together. The example database ID works for local
emulation; replace it with your own D1 database ID before deploying. The real
`wrangler.jsonc` and `.dev.vars` are ignored, so account configuration stays local.

Browser Rendering downloads a headless browser on first use. To run without it,
remove the `browser` binding from your local `wrangler.jsonc`; screenshots and
thumbnail generation will be unavailable.

### Configure Clerk

Use a dedicated application in the [Clerk Dashboard](https://dashboard.clerk.com):

1. Enable Organizations and disable Personal Accounts. Members choose or create
   a workspace through Clerk's organization flow.
2. Set `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in `.dev.vars`. The app reads
   public configuration from `/auth/config`; no separate Vite key is needed.
3. Send `user.created/updated/deleted`, `organization.created/updated/deleted`,
   `organizationMembership.created/updated/deleted`, and
   `session.ended/removed/revoked` events to `<origin>/auth/webhook`. Set
   `CLERK_WEBHOOK_SIGNING_SECRET`. Local delivery needs a reachable URL or webhook
   forwarder. These events reconcile memberships and revoke open file sockets.
4. To connect an agent with OAuth, follow [the agent setup guide](docs/agents.md).

Each deployment uses its own Clerk application URLs, OAuth clients, and webhook
endpoint. [sharpner.app](https://sharpner.app) uses a production Clerk instance;
use a development instance for local work.

## Verify changes

```sh
pnpm test
pnpm typecheck
pnpm build
```

Tests run in Node and use at most four workers. Type checking regenerates ignored
Worker resource types; `worker/env.d.ts` declares the secrets and optional browser
binding without requiring local credentials. CI runs these same checks from
the example configuration; it does not need Clerk secrets or a Cloudflare token.

`pnpm test:stress` runs the optional canvas-layout stress suite with one worker.
It covers 50,000-node pages, edit bursts, nested sections, 10,000 comments, repeated
page visits and reconnect snapshots. The normal test suite skips these larger
workloads and keeps the cache-invalidation regression tests.

For UI changes, also check the actual app at desktop and narrow mobile widths,
keyboard navigation, focus restoration, and reduced-motion settings. Capture
interaction changes in a short video when useful. Keep verification media outside
the checkout and attach it to the pull request; do not commit recordings or test
screenshots.

For startup changes, measure direct file opens and cached refreshes through the
first rendered canvas preview, as well as the workspace file grid. A successful
metadata response or an error page does not verify canvas loading.

## Code conventions

- Follow the vocabulary in [CONTEXT.md](CONTEXT.md).
- Keep a module's responsibilities together and its caller-facing interface small.
  Prefer direct code over a helper that only renames an expression. Name the
  domain decision when extracting complex logic.
- Keep shared layout in `shared/layout.ts`, so the browser, agent tools, and
  screenshots agree. Auto-height changes must reflow surrounding sections.
- Preserve revision checks, source-cache budgets, request backpressure, and the
  first-camera-fit guard when changing the realtime client or renderer.
- Keep browser sessions and agent credentials on their separate entry points.
  Every operation remains scoped to a current workspace member.
- Use [shadcn/ui's component catalog](https://ui.shadcn.com/docs/components)
  before adding custom app controls. Generated primitives live in
  `src/components/ui`; add missing ones with
  `pnpm dlx shadcn@latest add <component>`.
- The interface uses [Mira preset `b1D6KRrU`](https://ui.shadcn.com/create?preset=b1D6KRrU)
  with Sharpner's amber primary and logo. Theme roles are in `src/styles.css`.
  App CSS owns layout, canvas rendering, touch targets, and glass surfaces.
  Clerk uses the same theme variables. Canvas design documents render in isolated
  frames and have their own tokens and components.
- Add tests at the interface that exercises the behavior. Avoid tests that merely
  restate implementation details or snapshot generated shadcn markup.

See [architecture](docs/architecture.md) for the source map, rendering model,
known limitations, and identity invariants.

## Deploy your own instance

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create sharpner
pnpm exec wrangler r2 bucket create sharpner-files
```

Copy the new D1 database ID into `wrangler.jsonc`. Choose your own Worker,
database, and bucket names if needed; if you rename the database, update the
`db:migrate` and `deploy` scripts in `package.json` too.

Store production credentials in Cloudflare:

```sh
pnpm exec wrangler secret put CLERK_PUBLISHABLE_KEY
pnpm exec wrangler secret put CLERK_SECRET_KEY
pnpm exec wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET
pnpm deploy
```

The deploy command builds the app, applies remote D1 migrations, and deploys the
Worker. Durable Object migrations are managed by Wrangler. Account for Browser
Rendering usage if you keep that optional binding.

Set Clerk's application URLs and webhook destination to the deployed origin.
Put optional public OAuth settings in `wrangler.jsonc`'s `vars`; actual credentials
belong in Worker secrets. Verify sign-in, workspace creation, file creation, and
agent authorization against your own instance.

When moving to a custom domain, set `APP_ORIGIN` to its HTTPS origin in `vars`.
Browser file links on the old host then open the same path on the new domain
before Clerk initializes. Keep the old hostname enabled while those links are in use.

## Pull requests

Explain the trigger, resulting behavior, and relevant verification. Keep unrelated
cleanup out of a bug fix. The latest `main` is the supported version; report
security issues through [private vulnerability reporting](SECURITY.md).

Contributions are distributed under the repository's [MIT license](LICENSE).

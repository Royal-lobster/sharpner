<div align="center">

<img src="public/mark.svg" width="88" height="88" alt="Sharpner logo" />

# Sharpner

**A shared canvas for people and coding agents.**

Give your agent room to design. Browse the result, arrange screens, and explore
ideas together on an infinite canvas. The designs are HTML, the changes are live,
and the whole app runs on Cloudflare.

[Open Sharpner](https://sharpner.app) · [Run locally](CONTRIBUTING.md#run-locally) · [Connect an agent](docs/agents.md) · [Contribute](CONTRIBUTING.md)

</div>

## The design loop

1. Create a file in your workspace and connect a coding agent over MCP.
2. Ask it to explore a screen, a flow, or a design system.
3. Pan around the canvas, compare directions, and pin comments where something needs attention.
4. The agent edits the same file. Your team sees the changes as they happen.

The canvas stays small and focused: pages, navigation, selection, and organization.
Agents write the designs and inspect their rendered screenshots.

## Room to think

- **An infinite canvas.** Pan, pinch, zoom to fit, and organize work across pages.
  Preview navigation stays around the designs, with the fitted overview as its
  zoom-out limit. Controls stay out of the way in a compact floating dock.
- **Sections that breathe.** Screens flow into rows, catalogs and other groups
  tile into balanced columns, and content height changes reflow the layout. Drag to reorder; use free layout
  when positioning matters.
- **A workspace for the team.** Searchable files with preview cards, live cursors,
  an active-member avatar stack, shared selections, and a visible indication of
  what an agent is working on.
- **Feedback that agents can act on.** Pin comments to designs, discuss them in
  threads, then ask an agent to address the feedback and resolve it when fixed.
- **Design systems that carry through.** Define tokens and reusable components
  once. Link another file as a library to share them across designs.
- **A link for the review.** Share a live, view-only canvas without requiring an
  account. File and review links include the current page and selection, so your
  team opens directly on the designs you selected. Revoke the review link when
  the review is done.
- **Built for the overview.** Small designs use cached previews; large designs
  become live HTML. Sources and images load as you need them.

## HTML is the design format

Frames contain HTML styled with Tailwind CSS. Components are HTML fragments with
props and slots. Token sheets hold the design decisions they share.

A component named `Button/Primary` becomes a reusable `<x-button-primary>` tag:

```html
<!-- Component source -->
<button class="rounded-lg bg-primary px-4 py-2 text-primary-foreground">
  {{label|Continue}}
</button>

<!-- Use it in a screen -->
<x-button-primary label="Start a project"></x-button-primary>
```

Agents can read the source, change it precisely, and screenshot the result through
the same MCP connection. See the [Sharpner skill](worker/skills/sharpner/SKILL.md).

Choose **Interact** on any frame or component to try its clicks, typing, scrolling
and scripted motion beside the design. Each viewer plays one design at a time, with
Reset and Stop controls; temporary input stays local. Read about
[interaction playback](docs/interaction-playback.md).

## Bring your agent

Open **Connect an agent**, copy the setup prompt, and paste it into your coding
agent. It configures the connection for its client, guides you through browser
sign-in, and verifies workspace access. **Manual setup** keeps the endpoint and
client commands available.

The public [setup guide](https://sharpner.app/agent-setup.md) covers native remote
MCP and a local bridge for clients that can launch stdio servers.

Clerk handles sign-in and OAuth consent. Every agent acts as a workspace member
and uses that member's access. The [agent guide](docs/agents.md) covers client
setup, discovery, optional agent keys, and the complete tool list.

## One Worker, a few useful parts

| Part | What it does |
| --- | --- |
| React, Vite, shadcn/ui | The workspace and canvas interface |
| Cloudflare Workers + Hono | App delivery, HTTP routes, and remote MCP |
| Durable Objects + SQLite | One realtime room and document store per file |
| D1 + R2 | Workspace metadata, uploads, and previews |
| Browser Rendering | Thumbnails and agent screenshots; optional |
| Clerk | Sign-in, workspace membership, invitations, and OAuth |

Workspaces map to Clerk Organizations. The app has one deployment and no separate
sync server. Read the [architecture](docs/architecture.md) for the source map,
rendering model, access rules, and current limitations.

## Build with it

Sharpner is open source under the [MIT license](LICENSE). Run it locally, host your
own instance, or contribute a change. Self-hosting uses your own Cloudflare and
Clerk accounts.

Start with [Contributing](CONTRIBUTING.md) for setup, verification, and deployment.

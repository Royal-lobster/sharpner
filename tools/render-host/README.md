# Render host

A render host lends a machine's Chromium to a Sharpner deployment. While one is connected, previews and
`screenshot_nodes` for the workspaces it serves run on it and use no Browser Run time. When none is connected, or a
file's workspace is not served, Sharpner uses Browser Run as before, inside its daily budgets.

## How it connects

The host dials out. It opens one WebSocket per idle browser to `/api/render-host/socket` on the deployment and
presents a token. The deployment's ThumbnailQueue parks those sockets and pairs one with a FileRoom for a session;
the DevTools protocol then travels over that socket (`worker/render-host.ts`). Each browser serves one session and
is replaced. The machine opens no port, and nothing connects in to it.

## What protects the machine

Chromium on the host loads HTML and scripts that members' agents wrote. `run.sh` and the image are built so that
this cannot reach the machine or its networks:

| Limit | How |
| --- | --- |
| No way in | The host only makes outbound connections. Chromium is driven over a pipe, so there is no debugging port. |
| Its networks are closed | The entrypoint loads firewall rules that drop every private, link-local and carrier-grade NAT (tailnet) destination and all IPv6, then gives up the right to change them. The rules match addresses, so a public name that resolves to a private address is blocked too. The container uses public DNS resolvers, and the gateway is not mapped to the machine. It refuses to start if the rules did not load. |
| Nothing of the machine inside | The root filesystem is read-only and no directory of the machine is mounted. Profiles live in a memory filesystem and are deleted after each session. The one volume is the container's own, for the cache below; Chromium's user cannot read it. |
| No privileges | Rootless podman: the container's users are unprivileged ids on the machine. Chromium runs as a user of its own with no capabilities and `no-new-privileges`, inside Chromium's own sandbox (`seccomp.py` allows the one call it needs). |
| The token stays out of reach | It is a podman secret readable only by the entrypoint, handed to the host program on an open descriptor. The program runs as a different user from Chromium, so a browser process cannot read its memory or environment. |
| Bounded use | Memory, process and CPU limits on the container, a second memory limit on the systemd unit, and a five-minute limit on any session. |
| Only chosen workspaces | The deployment sends a host only the files of the workspaces named in `RENDER_HOST_WORKSPACES`. |

What it does not do: pages still reach the public internet, as any page does, from this machine's address. A
Chromium flaw that escapes its sandbox would run as an unprivileged user in the container, behind the same rules.
Serve only workspaces you trust until you have decided that is enough for strangers' files.

## Cache

A sprite's documents share megabytes of fonts, component definitions and CSS, and every sprite needs them again.
The deployment sends each such string to a host once: it names a string by the SHA-256 of its text, and the host
keeps what it is given in the `sharpner-render-cache` volume (5 GB by default, `RENDER_HOST_CACHE_GB`; least
recently used strings go first). Later sprites, in any session, carry the name instead of the string, and the host
puts the string back before the browser sees the message. `cache.mjs` describes the three message shapes.

A string is kept only under the hash of its own text and is checked again when read, so nothing can be stored
under another string's name. The cache holds design content (component definitions, token sheets, fonts) of the
workspaces the host serves, unencrypted, on the machine. `podman volume rm sharpner-render-cache` empties it;
everything is sent again as it is needed.

## Set up

On the deployment (see CONTRIBUTING.md, "Deploy your own instance"):

```sh
openssl rand -base64 32 | tr -d '\n' > token          # keep this file private
pnpm exec wrangler secret put RENDER_HOST_TOKEN < token
```

Set `RENDER_HOST_WORKSPACES` in `wrangler.jsonc`'s `vars` to the workspace ids to serve, comma separated, or `*`
for every workspace, and deploy. Without the token the socket route does not exist; without the variable no file
is sent to a host.

On the machine (podman 5 with pasta, rootless):

```sh
podman secret create render_host_token token && rm token
SHARPNER_ORIGIN=https://your.sharpner.example tools/render-host/run.sh
```

`run.sh` builds the image on first use. `sharpner-render-host.service` runs it as a systemd user unit. The log
shows each browser `parked`, then `session started` and `session ended`. On the deployment, `thumbnail-turn` and
`screenshot-browser` log `hosted: true` for work a host did.

Settings: `RENDER_HOST_POOL` (browsers kept ready, default 2), `RENDER_HOST_MEMORY` (default `8g`),
`RENDER_HOST_CPUS` (default 6). Rebuild after an update with `podman build -t localhost/sharpner-render-host:latest
tools/render-host`; rebuild regularly to pick up Chromium security updates.

`render-host.mjs` also runs directly (`SHARPNER_ORIGIN`, `RENDER_HOST_TOKEN_FILE`, `CHROME_BIN`) for development
against a local instance. Without the container none of the limits above apply.

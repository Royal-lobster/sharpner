#!/bin/sh
# Builds and runs the render host container with the limits it relies on. Usage:
#   SHARPNER_ORIGIN=https://your.sharpner.example ./run.sh
# The token is a podman secret, never an argument or an environment variable:
#   podman secret create render_host_token /path/to/token-file
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${SHARPNER_ORIGIN:?Set SHARPNER_ORIGIN to the deployment, for example https://sharpner.example}"
image=${RENDER_HOST_IMAGE:-localhost/sharpner-render-host:latest}
state=${XDG_STATE_HOME:-$HOME/.local/state}/sharpner-render-host
mkdir -p "$state"

podman image exists "$image" || podman build -t "$image" -f "$here/Containerfile" "$here"
# This machine's default profile plus the one call Chromium's own sandbox needs. See seccomp.py.
python3 "$here/seccomp.py" "${RENDER_HOST_SECCOMP_BASE:-/usr/share/containers/seccomp.json}" "$state/seccomp.json"

# - No volume and a read-only root: the container holds nothing of this machine and keeps nothing.
# - pasta without --map-gw, so the gateway address is not a door to this machine's own services; the entrypoint
#   then drops every private, link-local, carrier-grade NAT (tailnet) and IPv6 destination.
# - Public DNS resolvers, so no name is resolved by the home router or the tailnet.
# - Capabilities: only what the entrypoint needs to load the network rules and to run Chromium as another user.
#   It gives up NET_ADMIN before anything else starts, and Chromium gets none.
exec podman run --rm --replace --name "${RENDER_HOST_NAME:-sharpner-render-host}" \
  --read-only --tmpfs /tmp:rw,size=4g,mode=1777 --shm-size 1g \
  --cap-drop=ALL --cap-add=NET_ADMIN --cap-add=SETUID --cap-add=SETGID --cap-add=SETPCAP --cap-add=KILL \
  --security-opt no-new-privileges --security-opt "seccomp=$state/seccomp.json" \
  --network pasta:--no-map-gw --dns 1.1.1.1 --dns 1.0.0.1 \
  --memory "${RENDER_HOST_MEMORY:-8g}" --memory-swap "${RENDER_HOST_MEMORY:-8g}" --pids-limit 4096 --cpus "${RENDER_HOST_CPUS:-6}" \
  --secret render_host_token,mode=0400 \
  -e SHARPNER_ORIGIN -e RENDER_HOST_POOL \
  "$image"

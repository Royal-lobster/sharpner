#!/bin/sh
# Starts the render host inside its container. Runs as the container's root for two steps only: it closes the
# network to everything that is not the public internet, then drops to an unprivileged user for good.
set -eu

# Pages a browser loads here are other people's HTML and scripts. They may reach the internet, as any page does,
# but never this machine, its home or office network, its VPN or tailnet, or cloud metadata addresses. The rules
# match addresses, so a public name that resolves to a private address is blocked too. IPv6 is not needed: off.
nft -f - <<'RULES'
table inet render_host {
  chain output {
    type filter hook output priority 0; policy accept;
    oifname "lo" accept
    meta nfproto ipv6 drop
    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 } drop
  }
}
RULES
# The rules must be in force, or this host does not start.
nft list chain inet render_host output | grep -q "192.168.0.0/16" || { echo "The network rules did not load; refusing to start." >&2; exit 1; }

# The cache volume belongs to the host program alone: Chromium's user can neither read what other files' sprites
# stored nor change it.
chmod 0700 /var/cache/sharpner-render && chown 1000:1000 /var/cache/sharpner-render

[ -r /run/secrets/render_host_token ] || { echo "Mount the token as the secret render_host_token." >&2; exit 1; }
# The token goes to the host program on its standard input, so it is in no environment or file a browser's user
# could read. The program keeps the three capabilities it needs to start, stop and clean up after Chromium as
# another user; Chromium gets none (see asChromeUser in render-host.mjs), and nothing here can change the rules above.
exec setpriv --reuid=1000 --regid=1000 --clear-groups \
  --inh-caps=-all,+setuid,+setgid,+setpcap,+kill --ambient-caps=-all,+setuid,+setgid,+setpcap,+kill \
  --bounding-set=-all,+setuid,+setgid,+setpcap,+kill \
  env RENDER_HOST_TOKEN_FD=0 node /opt/render-host/render-host.mjs < /run/secrets/render_host_token

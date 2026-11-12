#!/usr/bin/env python3
"""Writes the container's seccomp profile: this machine's default profile, with one change.

Chromium's own sandbox puts every renderer in user, PID and network namespaces of its own and then chroots it into
an empty directory. The default profile refuses `chroot` to a process without CAP_SYS_CHROOT in the container, which
also refuses it inside those namespaces, where Chromium holds it. Allowing the call lets the sandbox start; the
kernel still requires the capability, which nothing in the container has outside a namespace Chromium made.
"""
import json, sys

source, target = sys.argv[1], sys.argv[2]
profile = json.load(open(source))
rules = []
for rule in profile["syscalls"]:
    names = [name for name in rule["names"] if name != "chroot"]
    if names:
        rules.append({**rule, "names": names})
rules.append({"names": ["chroot"], "action": "SCMP_ACT_ALLOW"})
profile["syscalls"] = rules
json.dump(profile, open(target, "w"), indent=1)

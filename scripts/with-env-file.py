#!/usr/bin/env python3
"""Run a command with the variables from an env file, plus overrides, without printing any of them.

    python3 scripts/with-env-file.py .env.prod [KEY=VALUE ...] -- <command> [args...]

Reads plain KEY=VALUE lines (values may contain spaces and quotes), which a shell cannot always `source`.
Overrides after the file win over it, so a check can be pointed at another network without editing the file.
"""
import os
import re
import subprocess
import sys

args = sys.argv[1:]
if "--" not in args or len(args) < 3:
    sys.exit("usage: with-env-file.py <env file> [KEY=VALUE ...] -- <command> [args...]")
split = args.index("--")
head, command = args[:split], args[split + 1 :]
path, overrides = head[0], head[1:]

env = dict(os.environ)
for line in open(path).read().splitlines():
    m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
    if m and not line.lstrip().startswith("#"):
        env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
for item in overrides:
    k, _, v = item.partition("=")
    env[k] = v
sys.exit(subprocess.call(command, env=env))

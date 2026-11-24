#!/usr/bin/env python3
"""Run a command with DATABASE_URL taken from .env, without printing it or sourcing the whole file.

    python3 scripts/with-db-url.py <command> [args...]

.env can hold values with spaces that a shell cannot source, so this reads just the one variable.
"""
import os
import re
import subprocess
import sys

text = open(".env").read()
m = re.search(r"^DATABASE_URL=(.*)$", text, re.M)
if not m:
    sys.exit("DATABASE_URL is not set in .env")
env = dict(os.environ, DATABASE_URL=m.group(1).strip().strip('"').strip("'"))
sys.exit(subprocess.call(sys.argv[1:], env=env))

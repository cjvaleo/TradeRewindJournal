#!/usr/bin/env bash
# dev.sh — local dev runner for Rewind.
#
# Why this exists: `vercel dev` auto-links to a Vercel cloud project in
# non-TTY mode (silently creates .vercel/) and then pulls env vars from
# the cloud project, ignoring .env.local. Fresh cloud projects have no
# env vars, so routes fail with 500 "server misconfigured".
#
# Fix: pre-export .env.local into the shell BEFORE spawning vercel dev.
# Node inherits the parent env, so process.env.X resolves to our local
# values even though vercel dev links to an empty cloud project.
#
# Also handles values with spaces (e.g. EMAIL_FROM_NAME=Christian from
# Rewind), which `source .env.local` botches.
#
# Usage:   ./dev.sh         (or)   npm run dev
# Requires: .env.local in the worktree root (gitignored).

set -e

if [[ ! -f .env.local ]]; then
  echo "dev.sh: .env.local not found in $(pwd)" >&2
  exit 1
fi

while IFS='=' read -r k v; do
  [[ "$k" =~ ^[A-Z_][A-Z0-9_]*$ ]] && export "$k=$v"
done < .env.local

exec npx vercel dev

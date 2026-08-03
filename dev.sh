#!/usr/bin/env bash
# dev.sh — local dev runner for Rewind.
#
# Why this exists: `vercel dev` gives serverless functions the linked cloud
# project's DEVELOPMENT environment — and every var on this project is
# scoped to Production only, so functions received empty strings and every
# route 500'd with "server misconfigured" (missing env). Exporting vars
# into the parent shell (the old approach here) doesn't help: the injected
# dev env wins, and the export loop also kept the surrounding quotes that
# `vercel env pull` writes, corrupting any value that did get through.
#
# The one mechanism `vercel dev` honors locally is a root `.env` file
# (dotenv format — quotes are stripped correctly). So: mirror .env.local
# into .env before starting. Both files are gitignored.
#
# Usage:   ./dev.sh [vercel dev args, e.g. --listen 3900]   (or)   npm run dev
# Requires: .env.local in the worktree root (gitignored).

set -e

if [[ ! -f .env.local ]]; then
  echo "dev.sh: .env.local not found in $(pwd)" >&2
  exit 1
fi

cp .env.local .env

exec npx vercel dev "$@"

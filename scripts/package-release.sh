#!/usr/bin/env bash
# Package a built checkout (`npm ci && npm run build`) as
# release/proxdesk-<version>-linux.tar.gz. The archive contains only
# JavaScript, so one archive serves every Linux architecture with Node 24.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

if [[ ! -f dist/proxdesk.js || ! -f .next/BUILD_ID ]]; then
  echo "package-release: run npm run build first" >&2
  exit 1
fi

version=$(node -p 'require("./package.json").version')
name="proxdesk-$version"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
app="$stage/$name"

mkdir -p "$app/deploy"
cp -r package.json package-lock.json next.config.mjs LICENSE .env.example dist .next "$app/"
cp deploy/proxdesk.service "$app/deploy/"
rm -rf "$app/.next/cache" "$app/.next/dev" "$app/.next/types"
# The installed tree is read-only to the service; Next.js caches in the
# unit's CacheDirectory instead.
ln -s /var/cache/proxdesk "$app/.next/cache"

(cd "$app" && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund)

if find "$app/node_modules" -name '*.node' | grep -q .; then
  echo "package-release: production dependencies contain native addons" >&2
  exit 1
fi

mkdir -p release
mtime=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$mtime" \
  -C "$stage" -czf "release/$name-linux.tar.gz" "$name"
echo "release/$name-linux.tar.gz"

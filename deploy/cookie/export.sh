#!/usr/bin/env sh
# Assembles the tree one Cookie app repository receives.
#
#   deploy/cookie/export.sh <app> <destination>
#
# <app> is a directory under deploy/cookie: shelf (the logic tier with the browser applications),
# shelf-player (the Player Shell and content packages) or shelf-lrs (the learning record store).
# The whole workspace is copied — every image installs it, so the dependency graph stays in one
# place — minus what is not source, and the app's own root files (Dockerfile, start script, README)
# are placed at the top. Cookie's own files in the target repository (.cookie.yaml, the CI workflow)
# are never part of an export and must be left as they are.
set -eu
app="${1:?app name (shelf, shelf-player, shelf-lrs)}"
destination="${2:?destination directory}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
source="$here/$app"
[ -d "$source" ] || { echo "no such app: $app" >&2; exit 1; }

mkdir -p "$destination"
tar -C "$root" \
  --exclude='./.git' --exclude='./node_modules' --exclude='*/node_modules' --exclude='*/dist' \
  --exclude='./deploy' --exclude='./.github' --exclude='./railway.*.json' --exclude='./railway.json' \
  --exclude='./Dockerfile' --exclude='./Dockerfile.*' --exclude='./docker-compose.yml' \
  --exclude='./keys' --exclude='./.env' --exclude='./coverage' --exclude='./test-results' \
  --exclude='./playwright-report' --exclude='./packages/ebook-player/public' \
  -cf - . | tar -C "$destination" -xf -
cp "$source"/* "$destination"/
echo "exported $app to $destination"

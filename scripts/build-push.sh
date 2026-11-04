#!/usr/bin/env bash
# Build the gateway image and push it to YOUR registry, then print the pinned reference.
#
#   REGISTRY_IMAGE=ghcr.io/your-account/db-gateway ./scripts/build-push.sh 1.0.0
#
# Log in first (docker login). The printed `name@sha256:...` goes into
# Admin > Databases > Gateway image; pinning by digest means a server only ever runs
# the exact bytes that were reviewed. Nothing here runs automatically.
set -euo pipefail

VERSION="${1:?usage: build-push.sh <version>}"
IMAGE="${REGISTRY_IMAGE:?set REGISTRY_IMAGE, e.g. ghcr.io/your-account/db-gateway}"
cd "$(dirname "$0")/.."

docker build -t "$IMAGE:$VERSION" .
docker push "$IMAGE:$VERSION"

DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE:$VERSION")"
echo
echo "Pinned reference (paste into the admin setting):"
echo "  $DIGEST"

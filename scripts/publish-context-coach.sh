#!/usr/bin/env bash
# Registers the context-routed coach example and sets its launch context.
#
#   export LORB_TOKEN='<access_token from {REGISTRY}/auth/session>'
#   export REPOSITORY_ID='<uuid>'
#   ./scripts/publish-context-coach.sh
#
# Requires the module to be present in the deployed Player Shell image at /modules/context-coach/.

set -euo pipefail

REGISTRY="${REGISTRY:-https://my-pq-registry.cookie.pearsondev.tech}"
PLAYER="${PLAYER:-https://my-pq-registry-player.cookie.pearsondev.tech}"
PLAYER_BASE_PATH="${PLAYER_BASE_PATH:-/api}"
MODULE_PATH="/modules/context-coach/index.html"

COURSE="${COURSE:-maths-gcse}"
THEME="${THEME:-calm}"

: "${LORB_TOKEN:?Set LORB_TOKEN to the access_token from ${REGISTRY}/auth/session}"
: "${REPOSITORY_ID:?Set REPOSITORY_ID to an existing ACTIVE repository}"

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" "${REGISTRY}${path}"
    -H "Authorization: Bearer ${LORB_TOKEN}"
    -H "Idempotency-Key: $(uuidgen)"
    -H "X-Correlation-Id: $(uuidgen)")
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")
  curl "${args[@]}"
}

# Hash what the player actually serves rather than inventing a digest for a field called sha256.
SHA=$(curl -fsS "${PLAYER}${PLAYER_BASE_PATH}${MODULE_PATH}" | sha256sum | cut -d' ' -f1)
echo "==> module digest ${SHA:0:12}…"

echo "==> Registering the learning object"
OBJECT_JSON=$(api POST /api/v1/publisher/learning-objects "$(cat <<JSON
{
  "repository_id": "$REPOSITORY_ID",
  "title": "Context-routed coach",
  "description": "Demonstrates launch context driving styling and relay endpoint selection.",
  "duration": "5 minutes",
  "kind": "coaching-chatbot",
  "module_path": "$MODULE_PATH",
  "semver": "1.0.0",
  "sha256": "$SHA"
}
JSON
)")
echo "$OBJECT_JSON"

OBJECT_ID=$(printf '%s' "$OBJECT_JSON" | sed -n 's/.*"object_id":"\([^"]*\)".*/\1/p')
[ -n "$OBJECT_ID" ] || { echo "No object_id in the response — see above." >&2; exit 1; }
echo "object_id = $OBJECT_ID"

echo "==> Setting the launch context (theme=$THEME course=$COURSE)"
api PUT "/api/v1/publisher/learning-objects/${OBJECT_ID}/launch-context" "$(cat <<JSON
{"launch_context": {"theme": "$THEME", "settings": {"course": "$COURSE", "cohort": "y11", "adaptive": true}}}
JSON
)"
echo
echo "==> Done. The module will request endpoint: coach-${COURSE}"
echo "    Configure RELAY_COACH_ENDPOINTS on the registry app to route it to a real provider;"
echo "    with nothing configured the relay answers from its built-in demo coach."

#!/bin/sh
# Applies any pending migrations, then starts the service host. The setup script is idempotent and
# takes an advisory lock, so two replicas starting together apply each migration once. A failed
# migration stops the start: a process serving against a schema it does not expect is worse than one
# that is not serving.
set -eu
node dist/packages/runtime-api/src/db/setup.js
exec node dist/src/server.js

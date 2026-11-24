#!/usr/bin/env bash
# Test-only launcher: pretends to be BaseMind 0.34.0 and forwards real work.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${1:-}" = "--version" ]; then echo "basemind 0.34.0"; exit 0; fi
if [ "${1:-}" = "serve" ]; then exec node "$here/fake-mcp-server.mjs" "$@"; fi
exec node "$here/fake-basemind-cli.mjs" "$@"

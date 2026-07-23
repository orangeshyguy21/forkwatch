#!/usr/bin/env bash
# Bring up the full Forkwatch regtest demo. Thin wrapper: the chain build lives in
# scripts/regtest.sh, which is also where the tunables are (compose/regtest.env).
#
# Kept because the README and muscle memory point here. Anything you would have tweaked in this
# file — fork height, block spacing, hashrate split — is a parameter there now.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
exec bash "$HERE/../scripts/regtest.sh" reset "$@"

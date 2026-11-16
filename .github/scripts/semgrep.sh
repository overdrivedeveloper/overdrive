#!/usr/bin/env bash
# Semgrep over the contracts, services, SDK and MCP server (CI and .github/scripts/ci-local.sh). Free registry rulesets, no
# login, metrics off. Fails on any WARNING or ERROR finding; INFO (gas style) is not gated.
#
# Excluded rules, each reviewed (add a line here with the reason before adding an --exclude-rule):
#   (none yet)
set -euo pipefail
cd "$(dirname "$0")/../.."

semgrep scan --metrics=off --disable-version-check --error \
  --severity WARNING --severity ERROR \
  --config p/smart-contracts --config p/typescript --config p/javascript --config p/secrets \
  contracts/src app/src app/scripts sdk/src sdk/mcp/src

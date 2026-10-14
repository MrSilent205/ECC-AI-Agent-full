#!/usr/bin/env bash
# Pro Yield free read tier — no account, no key, no payment.
# Every call below is public, read-only data. Safe to run as-is.
set -euo pipefail

BASE="https://pyd.fi"
ADDR="${1:-0x8954a73Bb36D17e4B212137Eb7B2328A1A14D1C1}"

echo "== machine discovery =="
curl -s "$BASE/llms.txt" | head -12

echo
echo "== curated venue rates + vault state (free) =="
curl -s "$BASE/api/yield/strategies" | head -40

echo
echo "== one wallet's vault position (free) =="
curl -s "$BASE/api/yield/positions?address=$ADDR" | head -20

echo
echo "== the 400 contract: missing address is a coded error, not HTML =="
curl -s -o /dev/null -w 'HTTP %{http_code}\n' "$BASE/api/yield/positions"
curl -s "$BASE/api/yield/positions" | head -4

echo
echo "== unsigned deposit calldata (free; your wallet signs) =="
curl -s -X POST "$BASE/api/yield/build-tx" \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"$ADDR\",\"action\":\"deposit\",\"amount_usdc\":1}" | head -30

echo
echo "== aggregate machine-payment tally (free) =="
curl -s "$BASE/api/x402/stats"

echo
echo "== free index of the paid rail (free; costs nothing) =="
curl -s "$BASE/api/agents" | head -30

echo
echo "== a paid resource with no payment header -> 402 challenge =="
curl -s -i "$BASE/api/agents/yields" | head -12

#!/usr/bin/env bash
# Pro Yield free read tier — no account, no key, no payment.
# Every call below is public, read-only data. Safe to run as-is.
# Every call is bounded with --max-time so a stalled read cannot hang the walkthrough.
set -euo pipefail

BASE="https://pyd.fi"
ADDR="${1:-0x8954a73Bb36D17e4B212137Eb7B2328A1A14D1C1}"

echo "== machine discovery =="
curl -fsS --max-time 15 "$BASE/llms.txt" | sed -n '1,12p'

echo
echo "== curated venue rates + vault state (free) =="
curl -fsS --max-time 15 "$BASE/api/yield/strategies" | sed -n '1,40p'

echo
echo "== one wallet's vault position (free) =="
curl -fsS --max-time 15 "$BASE/api/yield/positions?address=$ADDR" | sed -n '1,20p'

echo
echo "== the 400 contract: missing address is a coded error, not HTML =="
curl -s --max-time 15 -o /dev/null -w 'HTTP %{http_code}\n' "$BASE/api/yield/positions"
curl -s --max-time 15 "$BASE/api/yield/positions" | sed -n '1,4p'

echo
echo "== unsigned deposit calldata (free; your wallet signs) =="
# No -f on this demo call: a wallet under the deposit minimum answers 4xx/422 with
# the API's coded error body, and that body is the useful part of the example. With
# -f under `set -euo pipefail` the walkthrough would stop there and hide it. The -f
# reads around this one already prove the API is reachable, so nothing here is fatal.
curl -sS --max-time 15 -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$BASE/api/yield/build-tx" \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"$ADDR\",\"action\":\"deposit\",\"amount_usdc\":1}" || true
curl -sS --max-time 15 -X POST "$BASE/api/yield/build-tx" \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"$ADDR\",\"action\":\"deposit\",\"amount_usdc\":1}" | sed -n '1,30p' || true

echo
echo "== aggregate machine-payment tally (free) =="
curl -fsS --max-time 15 "$BASE/api/x402/stats"

echo
echo "== free index of the paid rail (free; costs nothing) =="
curl -fsS --max-time 15 "$BASE/api/agents" | sed -n '1,30p'

echo
echo "== a paid resource with no payment header -> 402 challenge =="
curl -s --max-time 15 -i "$BASE/api/agents/yields" | sed -n '1,12p'

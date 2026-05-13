#!/usr/bin/env bash
# Verify AgentFi contract deployment on a target chain.
#
# Usage:
#   ./scripts/verify-deployment.sh <rpc_url> <policy_module> <executor> <operator> <fee_wallet> <fee_bps> [escrow_module]
#
# Example (Base):
#   ./scripts/verify-deployment.sh \
#     https://mainnet.base.org \
#     0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d \
#     0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3 \
#     0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646 \
#     0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646 \
#     30 \
#     0x1234567890abcdef1234567890abcdef12345678

set -euo pipefail

if [ $# -lt 6 ] || [ $# -gt 7 ]; then
  echo "Usage: $0 <rpc_url> <policy_module> <executor> <operator> <fee_wallet> <fee_bps> [escrow_module]"
  exit 1
fi

RPC_URL="$1"
POLICY_MODULE="$2"
EXECUTOR="$3"
EXPECTED_OPERATOR="$4"
EXPECTED_FEE_WALLET="$5"
EXPECTED_FEE_BPS="$6"
ESCROW_MODULE="${7:-}"

PASS=0
FAIL=0

check() {
  local label="$1" actual="$2" expected="$3"
  # Normalize to lowercase for address comparison
  actual_lower=$(echo "$actual" | tr '[:upper:]' '[:lower:]' | xargs)
  expected_lower=$(echo "$expected" | tr '[:upper:]' '[:lower:]' | xargs)
  if [ "$actual_lower" = "$expected_lower" ]; then
    echo "  OK: $label = $actual"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label = $actual (expected $expected)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== AgentFi Deployment Verification ==="
echo "RPC: $RPC_URL"
echo ""

echo "--- AgentPolicyModule ($POLICY_MODULE) ---"
ACTUAL_OPERATOR=$(cast call "$POLICY_MODULE" "operator()(address)" --rpc-url "$RPC_URL")
check "operator()" "$ACTUAL_OPERATOR" "$EXPECTED_OPERATOR"

echo ""
echo "--- AgentExecutor ($EXECUTOR) ---"
ACTUAL_FEE_WALLET=$(cast call "$EXECUTOR" "feeWallet()(address)" --rpc-url "$RPC_URL")
check "feeWallet()" "$ACTUAL_FEE_WALLET" "$EXPECTED_FEE_WALLET"

ACTUAL_FEE_BPS=$(cast call "$EXECUTOR" "feeBps()(uint256)" --rpc-url "$RPC_URL")
check "feeBps()" "$ACTUAL_FEE_BPS" "$EXPECTED_FEE_BPS"

ACTUAL_POLICY_MODULE=$(cast call "$EXECUTOR" "policyModule()(address)" --rpc-url "$RPC_URL")
check "policyModule()" "$ACTUAL_POLICY_MODULE" "$POLICY_MODULE"

if [ -n "$ESCROW_MODULE" ]; then
  echo ""
  echo "--- EscrowModule ($ESCROW_MODULE) ---"
  ACTUAL_ESCROW_OPERATOR=$(cast call "$ESCROW_MODULE" "operator()(address)" --rpc-url "$RPC_URL")
  check "operator()" "$ACTUAL_ESCROW_OPERATOR" "$EXPECTED_OPERATOR"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

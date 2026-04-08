#!/bin/bash
# Runs each test individually to avoid LMDB exhaustion.
# Usage: ./scripts/run-tests-one-by-one.sh [linear|clawback]
# Default: runs all tests

set -e

PASSED=0
FAILED=0
FAILED_TESTS=""

run_test() {
  local file="$1"
  local name="$2"
  local idx="$3"
  local total="$4"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[$idx/$total] $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if yarn test:js "$file" -t "$name" 2>&1 | tail -5; then
    PASSED=$((PASSED + 1))
    echo "✅ PASSED"
  else
    FAILED=$((FAILED + 1))
    FAILED_TESTS="$FAILED_TESTS\n  - $name"
    echo "❌ FAILED"
  fi
}

LINEAR_TESTS=(
  "deploys linear vesting escrow with correct constructor params"
  "deploys escrow with correctly derived address"
  "creates linear vesting escrow shares escrow with bob correctly"
  "creates linear vesting escrow should create a correct linearVestingEscrow note"
  "creates linear vesting escrow should emit a nullifier for the escrow"
  "creates linear vesting escrow should nullify and not allow to create another one"
  "creates linear vesting escrow should fail if start .* duration overflows"
  "claim should transfer the tokens to the recipient and emit one note"
  "claim should transfer the tokens partially to the recipient"
  "claim with amount equal to u128 max value should work"
  "claim before the start time should transfer zero tokens"
  "claim executed multiple times should be successful"
  "claim should fail if amount is greater than releasable amount"
  "final claim should not allow further claims"
  "final claim should transfer the tokens to the recipient and emit corresponding notes"
  "final claim with partially funded escrow should claim correctly"
  "final claim should fail if the caller is not the recipient"
  "final claim should fail if amount is greater than releasable amount"
  "claim before start time should transfer zero tokens"
  "claim at start time should transfer full amount immediately"
  "claim after start time should transfer full amount"
  "stop vesting and clawback with duration = 0 should work correctly"
  "stop vesting after start with duration = 0 should vest full amount"
  "stop vesting should stop the vesting and emit correct vesting schedule note"
  "stop vesting should fail if the caller is not the reclaimer"
  "stop vesting should fail if already stopped"
  "stop vesting should fail if stop timestamp is lower than block timestamp"
  "clawback successfully when escrow is fully funded and there's still releasable amount"
  "clawback successfully when escrow was fully funded and there's no releasable amount"
  "clawback successfully when escrow was fully funded and there's still releasable amount .* after final partial claim"
  "clawback should fail if the caller is not the reclaimer"
  "clawback should fail the escrow vesting is still active"
  "clawback should transfer zero tokens if the reclaimer amount is zero"
  "clawback successfully: escrow is not fully funded, releasable amount > 0"
  "clawback successfully: escrow is not fully funded, releasable amount == 0"
  "claiming after clawback should fail"
  "release amount note is correctly created and emitted"
  "reclaimer can split clawback amount across multiple transactions"
  "reclaimer can do multiple clawbacks after recipient has already claimed"
  "releasable and vested amount should be correct with multiple claims"
)

CLAWBACK_TESTS=(
  "creates clawback escrow shares escrow with bob correctly"
  "creates clawback escrow shares escrow with alice correctly"
  "creates clawback escrow should create a correct ClawbackEscrow note"
  "creates clawback escrow should emit a nullifier for the escrow"
  "creates clawback escrow should nullify and not allow to create another one"
  "claim should transfer the tokens to the recipient and emit one note"
  "claim two times in a row should be successful"
  "claim after deadline should fail"
  "claim_nft should transfer the NFT to the recipient"
  "claim_nft after deadline should fail"
  "clawback should transfer the tokens to the recipient and emit one note"
  "clawback two times in a row should be successful"
  "clawback before deadline should fail"
  "clawback_nft should transfer the NFT to the recipient"
  "clawback_nft after deadline should fail"
)

MODE="${1:-all}"

if [[ "$MODE" == "linear" || "$MODE" == "all" ]]; then
  TOTAL=${#LINEAR_TESTS[@]}
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Linear Vesting Escrow Tests ($TOTAL tests)              ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  for i in "${!LINEAR_TESTS[@]}"; do
    run_test "src/ts/linear_vesting_escrow.test.ts" "${LINEAR_TESTS[$i]}" "$((i+1))" "$TOTAL"
  done
fi

if [[ "$MODE" == "clawback" || "$MODE" == "all" ]]; then
  TOTAL=${#CLAWBACK_TESTS[@]}
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  Clawback Escrow Tests ($TOTAL tests)                    ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  for i in "${!CLAWBACK_TESTS[@]}"; do
    run_test "src/ts/clawback_escrow.test.ts" "${CLAWBACK_TESTS[$i]}" "$((i+1))" "$TOTAL"
  done
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Summary                                                ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo "  ✅ Passed: $PASSED"
echo "  ❌ Failed: $FAILED"
if [ -n "$FAILED_TESTS" ]; then
  echo -e "  Failed tests:$FAILED_TESTS"
fi
echo ""

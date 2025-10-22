use crate::LinearVestingEscrowLogic;
use crate::test::utils;
use aztec::test::txe_constants::AZTEC_SLOT_DURATION;
use token::test::utils as token_utils;

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn clawback_success() {
    let duration_blocks = 10;
    let duration = AZTEC_SLOT_DURATION * duration_blocks;
    let amount: u128 = 10000;

    let (env, _, recipient, reclaimer, logic_contract_address, escrow_contract_address, token_contract_address) =
        utils::deploy_and_create_escrow(false, amount, duration);

    token_utils::check_private_balance(token_contract_address, escrow_contract_address, amount);
    token_utils::check_private_balance(token_contract_address, recipient, 0);
    token_utils::check_private_balance(token_contract_address, reclaimer, 0);

    env.advance_timestamp_by(duration / 2);

    let stop_timestamp = env.committed_timestamp();

    let (_, vested_amount) = LinearVestingEscrowLogic::releasable_and_vested_amounts(
        escrow_contract_address,
        stop_timestamp,
    );

    env.impersonate(reclaimer);
    LinearVestingEscrowLogic::at(logic_contract_address)
        .stop_vesting(escrow_contract_address, stop_timestamp)
        .call(&mut env.private());
    env.advance_block_by(1);

    let clawback_amount = amount - vested_amount;

    env.impersonate(reclaimer);
    LinearVestingEscrowLogic::at(logic_contract_address)
        .clawback(escrow_contract_address, clawback_amount)
        .call(&mut env.private());
    env.advance_block_by(1);

    token_utils::check_private_balance(token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(token_contract_address, recipient, vested_amount);
    token_utils::check_private_balance(token_contract_address, reclaimer, clawback_amount);
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn clawback_after_claim_success() {
    let duration_blocks = 10;
    let duration = AZTEC_SLOT_DURATION * duration_blocks;
    let amount: u128 = 10000;

    let (env, _, recipient, reclaimer, logic_contract_address, escrow_contract_address, token_contract_address) =
        utils::deploy_and_create_escrow(false, amount, duration);

    token_utils::check_private_balance(token_contract_address, escrow_contract_address, amount);
    token_utils::check_private_balance(token_contract_address, recipient, 0);
    token_utils::check_private_balance(token_contract_address, reclaimer, 0);

    env.advance_timestamp_by(duration / 2);

    let stop_timestamp = env.committed_timestamp();

    let (releasable_amount, vested_amount) = LinearVestingEscrowLogic::releasable_and_vested_amounts(
        escrow_contract_address,
        stop_timestamp,
    );

    env.impersonate(reclaimer);
    LinearVestingEscrowLogic::at(logic_contract_address)
        .stop_vesting(escrow_contract_address, stop_timestamp)
        .call(&mut env.private());
    env.advance_block_by(1);

    env.impersonate(recipient);
    LinearVestingEscrowLogic::at(logic_contract_address)
        .claim(escrow_contract_address, releasable_amount)
        .call(&mut env.private());
    env.advance_block_by(1);

    let clawback_amount = amount - vested_amount;

    env.impersonate(reclaimer);
    LinearVestingEscrowLogic::at(logic_contract_address)
        .clawback(escrow_contract_address, clawback_amount)
        .call(&mut env.private());
    env.advance_block_by(1);

    token_utils::check_private_balance(token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(token_contract_address, recipient, releasable_amount);
    token_utils::check_private_balance(token_contract_address, reclaimer, clawback_amount);
}

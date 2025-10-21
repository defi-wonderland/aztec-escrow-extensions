use crate::LinearVestingEscrowLogic;
use crate::test::utils;
use aztec::test::txe_constants::AZTEC_SLOT_DURATION;

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn stop_vesting_success() {
    let duration_blocks = 10;
    let duration = AZTEC_SLOT_DURATION * duration_blocks;
    let amount: u128 = 10000;

    let (env, _, _, _, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);
    let stop_timestamp = env.committed_timestamp() + duration;

    LinearVestingEscrowLogic::at(logic_contract_address)
        .stop_vesting(escrow_contract_address, stop_timestamp)
        .call(&mut env.private());
    env.advance_block_by(1);

    let vesting_schedule_note =
        utils::get_vesting_schedule_note(logic_contract_address, escrow_contract_address);

    assert(vesting_schedule_note.stop_timestamp == stop_timestamp, "Note: stop timestamp mismatch");
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test(should_fail_with = "Vesting schedule is not active")]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn stop_vesting_already_stopped() {
    let duration_blocks = 10;
    let duration = AZTEC_SLOT_DURATION * duration_blocks;
    let amount: u128 = 10000;

    let (env, _, _, _, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);
    let stop_timestamp = env.committed_timestamp() + duration;

    LinearVestingEscrowLogic::at(logic_contract_address)
        .stop_vesting(escrow_contract_address, stop_timestamp)
        .call(&mut env.private());
    env.advance_block_by(1);

    LinearVestingEscrowLogic::at(logic_contract_address)
        .stop_vesting(escrow_contract_address, stop_timestamp)
        .call(&mut env.private());
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test(should_fail_with = "caller is not reclaimer")]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn stop_vesting_not_reclaimer() {
    let duration_blocks = 10;
    let duration = AZTEC_SLOT_DURATION * duration_blocks;
    let amount: u128 = 100;

    let (env, _, recipient, _, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);
    let stop_timestamp = env.committed_timestamp() + duration;

    env.impersonate(recipient);
    LinearVestingEscrowLogic::at(logic_contract_address)
        .stop_vesting(escrow_contract_address, stop_timestamp)
        .call(&mut env.private());
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test(should_fail_with = "app_logic_reverted")]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn stop_vesting_invalid_stop_timestamp() {
    let duration_blocks = 10;
    let duration = AZTEC_SLOT_DURATION * duration_blocks;
    let amount: u128 = 100;

    let (env, _, _, _, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);
    let stop_timestamp = 1;

    LinearVestingEscrowLogic::at(logic_contract_address)
        .stop_vesting(escrow_contract_address, stop_timestamp)
        .call(&mut env.private());
    env.advance_block_by(1);
}

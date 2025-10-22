use crate::LinearVestingEscrowLogic;
use crate::test::utils;
use aztec::test::txe_constants::AZTEC_SLOT_DURATION;
use token::test::utils as token_utils;

// TODO: cannot deploy escrow contract with custom salt. This should fail trying to push the same nullifier twice.
// #[test(should_fail_with = "Rejecting tx for emitting duplicate nullifiers")]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn create_linear_vesting_escrow_cannot_use_same_escrow_twice() {
    let (env, owner, recipient, reclaimer) = utils::setup(false);

    let (escrow_contract_address, contract_class_id) = utils::deploy_escrow_with_secret(env, 1);
    let logic_contract_address =
        utils::deploy_linear_vesting_escrow_logic(env, owner, contract_class_id);

    let (_, vector_secret_keys_1, _, _) = utils::get_test_vector();

    let amount: u128 = 1000;
    let token_contract_address =
        token_utils::deploy_token_with_initial_supply(env, owner, amount, owner);

    let start = env.committed_timestamp();
    let duration = AZTEC_SLOT_DURATION * 100;

    env.impersonate(owner);
    LinearVestingEscrowLogic::at(logic_contract_address)
        .setup_linear_vesting_escrow(
            escrow_contract_address,
            recipient,
            reclaimer,
            token_contract_address,
            start,
            duration,
            amount,
            vector_secret_keys_1[0],
            vector_secret_keys_1[1],
            vector_secret_keys_1[2],
            vector_secret_keys_1[3],
        )
        .call(&mut env.private());
    env.advance_block_by(1);

    LinearVestingEscrowLogic::at(logic_contract_address)
        .setup_linear_vesting_escrow(
            escrow_contract_address,
            recipient,
            reclaimer,
            token_contract_address,
            start,
            duration,
            amount,
            vector_secret_keys_1[0],
            vector_secret_keys_1[1],
            vector_secret_keys_1[2],
            vector_secret_keys_1[3],
        )
        .call(&mut env.private());
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn create_linear_vesting_escrow_success() {
    let (env, owner, recipient, reclaimer) = utils::setup(false);

    let (escrow_contract_address, contract_class_id) = utils::deploy_escrow_with_secret(env, 1);
    let logic_contract_address =
        utils::deploy_linear_vesting_escrow_logic(env, owner, contract_class_id);

    let (_, vector_secret_keys_1, _, _) = utils::get_test_vector();

    let amount: u128 = 1000;
    let token_contract_address =
        token_utils::deploy_token_with_initial_supply(env, owner, amount, owner);

    let start = env.committed_timestamp();

    let duration = AZTEC_SLOT_DURATION * 100;

    env.impersonate(owner);
    LinearVestingEscrowLogic::at(logic_contract_address)
        .setup_linear_vesting_escrow(
            escrow_contract_address,
            recipient,
            reclaimer,
            token_contract_address,
            start,
            duration,
            amount,
            vector_secret_keys_1[0],
            vector_secret_keys_1[1],
            vector_secret_keys_1[2],
            vector_secret_keys_1[3],
        )
        .call(&mut env.private());

    let vesting_schedule_note =
        utils::get_vesting_schedule_note(logic_contract_address, escrow_contract_address);
    assert(
        vesting_schedule_note.escrow == escrow_contract_address,
        "Note: escrow address mismatch",
    );
    assert(vesting_schedule_note.recipient == recipient, "Note: recipient address mismatch");
    assert(vesting_schedule_note.token == token_contract_address, "Note: token address mismatch");
    assert(vesting_schedule_note.start == start, "Note: start mismatch");
    assert(vesting_schedule_note.duration == duration, "Note: duration mismatch");
    assert(vesting_schedule_note.total_amount == amount, "Note: amount mismatch");
    assert(vesting_schedule_note.stop_timestamp == 0, "Note: stop timestamp mismatch");

    let released_amount_note =
        utils::get_released_amount_note(logic_contract_address, escrow_contract_address);
    assert(released_amount_note.escrow == escrow_contract_address, "Note: escrow address mismatch");
    assert(released_amount_note.released_amount == 0, "Note: released amount mismatch");
    assert(released_amount_note.claim_completed == false, "Note: claim completed mismatch");
}

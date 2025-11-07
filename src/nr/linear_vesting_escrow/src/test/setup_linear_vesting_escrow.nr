use crate::LinearVestingEscrowLogic;
use crate::test::utils;
use escrow_standard::test::utils as escrow_utils;
use token::test::utils as token_utils;

// TODO: cannot deploy escrow contract with custom salt. This should fail trying to push the same nullifier twice.
// #[test(should_fail_with = "Rejecting tx for emitting duplicate nullifiers")]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn create_linear_vesting_escrow_cannot_use_same_escrow_twice() {
    let (env, owner, recipient, reclaimer) = utils::setup(false);

    let escrow_contract_address = escrow_utils::deploy_escrow_with_secret(env, 1);
    let escrow_class_id = escrow_utils::get_escrow_class_id();
    let logic_contract_address =
        utils::deploy_linear_vesting_escrow_logic(env, owner, escrow_class_id);

    let (_, vector_secret_keys_1, _, _) = utils::get_test_vector();

    let amount: u128 = 1000;
    let token_contract_address =
        token_utils::deploy_token_with_initial_supply(env, owner, amount, owner);

    let start = env.last_block_timestamp();
    let duration = 100;

    env.call_private(
        owner,
        LinearVestingEscrowLogic::at(logic_contract_address).setup_linear_vesting_escrow(
            escrow_contract_address,
            recipient,
            reclaimer,
            token_contract_address,
            start,
            duration,
            amount,
            vector_secret_keys_1,
        ),
    );

    env.call_private(
        owner,
        LinearVestingEscrowLogic::at(logic_contract_address).setup_linear_vesting_escrow(
            escrow_contract_address,
            recipient,
            reclaimer,
            token_contract_address,
            start,
            duration,
            amount,
            vector_secret_keys_1,
        ),
    );
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn create_linear_vesting_escrow_success() {
    let (env, owner, recipient, reclaimer) = utils::setup(false);

    let escrow_contract_address = escrow_utils::deploy_escrow_with_secret(env, 1);
    let escrow_class_id = escrow_utils::get_escrow_class_id();
    let logic_contract_address =
        utils::deploy_linear_vesting_escrow_logic(env, owner, escrow_class_id);

    let (_, vector_secret_keys_1, _, _) = utils::get_test_vector();

    let amount: u128 = 1000;
    let token_contract_address =
        token_utils::deploy_token_with_initial_supply(env, owner, amount, owner);

    let start = env.last_block_timestamp();

    let duration = 100;

    env.call_private(
        owner,
        LinearVestingEscrowLogic::at(logic_contract_address).setup_linear_vesting_escrow(
            escrow_contract_address,
            recipient,
            reclaimer,
            token_contract_address,
            start,
            duration,
            amount,
            vector_secret_keys_1,
        ),
    );

    let vesting_schedule_note =
        utils::get_vesting_schedule_note(*env, logic_contract_address, escrow_contract_address);
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
        utils::get_released_amount_note(*env, logic_contract_address, escrow_contract_address);
    assert(released_amount_note.escrow == escrow_contract_address, "Note: escrow address mismatch");
    assert(released_amount_note.released_amount == 0, "Note: released amount mismatch");
    assert(released_amount_note.claim_completed == false, "Note: claim completed mismatch");
}

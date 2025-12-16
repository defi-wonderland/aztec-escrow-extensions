use crate::ClawbackEscrowLogic;
use crate::test::utils;
use escrow_standard::test::utils as escrow_utils;

// TODO: cannot deploy escrow contract with custom salt. This should fail trying to push the same nullifier twice.
// #[test(should_fail_with = "Rejecting tx for emitting duplicate nullifiers")]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn setup_clawback_escrow_cannot_use_same_escrow_twice() {
    let (env, owner, recipient) = utils::setup(false);

    let escrow_contract_address = escrow_utils::deploy_escrow_with_secret(env, 1);
    let escrow_class_id = escrow_utils::get_escrow_class_id();
    let logic_contract_address = utils::deploy_clawback_logic(env, owner, escrow_class_id);

    let (_, vector_secret_keys_1, _, _) = utils::get_test_vector();

    env.call_private(
        owner,
        ClawbackEscrowLogic::at(logic_contract_address).setup_clawback_escrow(
            escrow_contract_address,
            recipient,
            owner,
            env.last_block_timestamp() + 10,
            vector_secret_keys_1,
        ),
    );

    env.call_private(
        owner,
        ClawbackEscrowLogic::at(logic_contract_address).setup_clawback_escrow(
            escrow_contract_address,
            recipient,
            owner,
            env.last_block_timestamp() + 10,
            vector_secret_keys_1,
        ),
    );
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn setup_clawback_escrow_success() {
    let (env, owner, recipient) = utils::setup(false);

    let escrow_contract_address = escrow_utils::deploy_escrow_with_secret(env, 1);
    let escrow_class_id = escrow_utils::get_escrow_class_id();
    let logic_contract_address = utils::deploy_clawback_logic(env, owner, escrow_class_id);

    let (_, vector_secret_keys_1, _, _) = utils::get_test_vector();

    let deadline = env.last_block_timestamp() + 10;
    env.call_private(
        owner,
        ClawbackEscrowLogic::at(logic_contract_address).setup_clawback_escrow(
            escrow_contract_address,
            recipient,
            owner,
            deadline,
            vector_secret_keys_1,
        ),
    );

    let escrow_note = utils::get_escrow_note(*env, logic_contract_address, escrow_contract_address);
    assert(escrow_note.escrow == escrow_contract_address, "Note: escrow address mismatch");
    assert(escrow_note.recipient == recipient, "Note: recipient address mismatch");
    assert(escrow_note.reclaimer == owner, "Note: reclaimer address mismatch");
    assert(escrow_note.deadline == deadline, "Note: deadline address mismatch");
}

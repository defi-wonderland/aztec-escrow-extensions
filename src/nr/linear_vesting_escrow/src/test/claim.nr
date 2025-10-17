use crate::LinearVestingEscrowLogic;
use crate::test::utils;
use aztec::test::txe_constants::AZTEC_SLOT_DURATION;
use token::test::utils as token_utils;

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn claim_fully_vested_tokens_success() {
    let duration_blocks = 10;
    let duration = AZTEC_SLOT_DURATION * duration_blocks;
    let amount: u128 = 100;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, token_contract_address)
         = utils::deploy_and_create_escrow(false, amount, duration);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, 0);

    env.advance_next_block_timestamp_by(duration);
    let (releasable_amount, _) = env.simulate_utility(LinearVestingEscrowLogic::at(
        logic_contract_address,
    )
        .releasable_and_vested_amounts(escrow_contract_address, env.last_block_timestamp()));

    env.call_private(
        recipient,
        LinearVestingEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            releasable_amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, amount);
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn claim_partially_vested_tokens_success() {
    let duration_blocks = 5;
    let duration = AZTEC_SLOT_DURATION * duration_blocks;
    let half_duration = duration / 2;
    let amount: u128 = 100;
    let half_amount = amount / 2;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, token_contract_address)
         = utils::deploy_and_create_escrow(false, amount, duration);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, 0);

    env.advance_next_block_timestamp_by(half_duration);
    let (releasable_amount, _) = env.simulate_utility(LinearVestingEscrowLogic::at(
        logic_contract_address,
    )
        .releasable_and_vested_amounts(escrow_contract_address, env.last_block_timestamp()));

    env.call_private(
        recipient,
        LinearVestingEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            releasable_amount,
        ),
    );

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        half_amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, half_amount);
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
// #[test(should_fail_with = "Balance too low 'subtracted > 0")]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn claim_before_start_time() {
    let duration_blocks = 10;
    let duration = AZTEC_SLOT_DURATION * duration_blocks;
    let amount: u128 = 100;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, token_contract_address)
         = utils::deploy_and_create_escrow(false, amount, duration);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, 0);

    let (releasable_amount, _) = env.simulate_utility(LinearVestingEscrowLogic::at(
        logic_contract_address,
    )
        .releasable_and_vested_amounts(escrow_contract_address, env.last_block_timestamp()));

    env.call_private(
        recipient,
        LinearVestingEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            releasable_amount,
        ),
    );
}

use crate::LinearVestingEscrowLogic;
use crate::test::utils;
use aztec::test::helpers::test_environment::CallPrivateOptions;
use token::test::utils as token_utils;

#[test]
unconstrained fn claim_fully_vested_tokens_success() {
    let duration = 10;
    let amount: u128 = 10000;
    let (env, _, recipient, _, logic_contract_address, escrow_contract_address, token_contract_address) =
        utils::deploy_and_create_escrow(false, amount, duration);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, 0);

    // Mine a block at the fully-vested timestamp so the utility read and the claim's anchor block agree.
    env.mine_block_at(env.last_block_timestamp() + duration);
    let (releasable_amount, _) = env.execute_utility(LinearVestingEscrowLogic::at(
        logic_contract_address,
    )
        .releasable_and_vested_amounts(escrow_contract_address, env.last_block_timestamp()));

    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            releasable_amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, amount);
}

#[test]
unconstrained fn claim_partially_vested_tokens_success() {
    let duration = 10;
    let half_duration = duration / 2;
    let amount: u128 = 10000;
    let half_amount = amount / 2;

    let (env, _, recipient, _, logic_contract_address, escrow_contract_address, token_contract_address) =
        utils::deploy_and_create_escrow(false, amount, duration);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, 0);

    // Mine a block at the half-vested timestamp so the utility read and the claim's anchor block agree.
    env.mine_block_at(env.last_block_timestamp() + half_duration);
    let (releasable_amount, _) = env.execute_utility(LinearVestingEscrowLogic::at(
        logic_contract_address,
    )
        .releasable_and_vested_amounts(escrow_contract_address, env.last_block_timestamp()));

    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
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

#[test(should_fail_with = "claim amount too high")]
unconstrained fn claim_before_start_time() {
    let duration = 10;
    let amount: u128 = 10000;

    let (env, _, recipient, _, logic_contract_address, escrow_contract_address, token_contract_address) =
        utils::deploy_and_create_escrow(false, amount, duration);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, 0);

    // No time has elapsed since the vesting start, so nothing is releasable yet. Attempting to claim a
    // non-zero amount must revert.
    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).claim(escrow_contract_address, amount),
    );
}

#[test]
unconstrained fn claim_after_stop_vesting_success() {
    let duration = 10;
    let amount: u128 = 10000;

    let (env, _, recipient, reclaimer, logic_contract_address, escrow_contract_address, token_contract_address) =
        utils::deploy_and_create_escrow(false, amount, duration);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, 0);
    token_utils::check_private_balance(*env, token_contract_address, reclaimer, 0);

    let stop_timestamp = env.last_block_timestamp() + duration / 2;
    env.set_next_block_timestamp(stop_timestamp);

    let (releasable_amount, _) = env.execute_utility(LinearVestingEscrowLogic::at(
        logic_contract_address,
    )
        .releasable_and_vested_amounts(escrow_contract_address, stop_timestamp));

    env.call_private_opts(
        reclaimer,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );

    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            releasable_amount,
        ),
    );

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount - releasable_amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, releasable_amount);
    token_utils::check_private_balance(*env, token_contract_address, reclaimer, 0);
}

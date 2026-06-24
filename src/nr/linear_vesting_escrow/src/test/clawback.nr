use crate::LinearVestingEscrowLogic;
use crate::test::utils;
use aztec::test::helpers::test_environment::CallPrivateOptions;
use token::test::utils as token_utils;

#[test]
unconstrained fn clawback_success() {
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

    let (_, vested_amount) = env.execute_utility(LinearVestingEscrowLogic::at(
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

    let clawback_amount = amount - vested_amount;

    env.call_private_opts(
        reclaimer,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).clawback(
            escrow_contract_address,
            clawback_amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, vested_amount);
    token_utils::check_private_balance(*env, token_contract_address, reclaimer, clawback_amount);
}

#[test]
unconstrained fn clawback_after_claim_success() {
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

    let (releasable_amount, vested_amount) = env.execute_utility(LinearVestingEscrowLogic::at(
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

    let clawback_amount = amount - vested_amount;

    env.call_private_opts(
        reclaimer,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).clawback(
            escrow_contract_address,
            clawback_amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, releasable_amount);
    token_utils::check_private_balance(*env, token_contract_address, reclaimer, clawback_amount);
}

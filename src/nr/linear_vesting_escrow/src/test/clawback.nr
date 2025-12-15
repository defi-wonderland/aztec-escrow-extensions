use crate::LinearVestingEscrowLogic;
use crate::test::utils;
use token::test::utils as token_utils;

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Incorrect escrow deployment")]
unconstrained fn clawback_success() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
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

    let (_, vested_amount) = env.simulate_utility(LinearVestingEscrowLogic::at(
        logic_contract_address,
    )
        .releasable_and_vested_amounts(escrow_contract_address, stop_timestamp));

    env.call_private(
        reclaimer,
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );

    let clawback_amount = amount - vested_amount;

    env.call_private(
        reclaimer,
        LinearVestingEscrowLogic::at(logic_contract_address).clawback(
            escrow_contract_address,
            clawback_amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, vested_amount);
    token_utils::check_private_balance(*env, token_contract_address, reclaimer, clawback_amount);
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Incorrect escrow deployment")]
unconstrained fn clawback_after_claim_success() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
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

    let (releasable_amount, vested_amount) = env.simulate_utility(LinearVestingEscrowLogic::at(
        logic_contract_address,
    )
        .releasable_and_vested_amounts(escrow_contract_address, stop_timestamp));

    env.call_private(
        reclaimer,
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );

    env.call_private(
        recipient,
        LinearVestingEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            releasable_amount,
        ),
    );

    let clawback_amount = amount - vested_amount;

    env.call_private(
        reclaimer,
        LinearVestingEscrowLogic::at(logic_contract_address).clawback(
            escrow_contract_address,
            clawback_amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, releasable_amount);
    token_utils::check_private_balance(*env, token_contract_address, reclaimer, clawback_amount);
}

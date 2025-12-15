use crate::LinearVestingEscrowLogic;
use crate::test::utils;

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Incorrect escrow deployment")]
unconstrained fn stop_vesting_success() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let duration = 10;
    let amount: u128 = 10000;

    let (env, owner, _, _, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);

    let stop_timestamp = env.last_block_timestamp() + duration;

    env.call_private(
        owner,
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );

    let vesting_schedule_note =
        utils::get_vesting_schedule_note(*env, logic_contract_address, escrow_contract_address);

    assert(vesting_schedule_note.stop_timestamp == stop_timestamp, "Note: stop timestamp mismatch");
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test(should_fail_with = "Vesting schedule is not active")]
#[test(should_fail_with = "Incorrect escrow deployment")]
unconstrained fn stop_vesting_already_stopped() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let duration = 10;
    let amount: u128 = 10000;

    let (env, owner, _, _, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);

    let stop_timestamp = env.last_block_timestamp() + duration;

    env.call_private(
        owner,
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );

    env.call_private(
        owner,
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test(should_fail_with = "caller is not reclaimer")]
#[test(should_fail_with = "Incorrect escrow deployment")]
unconstrained fn stop_vesting_not_reclaimer() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let duration = 10;
    let amount: u128 = 100;

    let (env, _, recipient, _, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);

    let stop_timestamp = env.last_block_timestamp() + duration;

    env.call_private(
        recipient,
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test(should_fail_with = "app_logic_reverted")]
#[test(should_fail_with = "Incorrect escrow deployment")]
unconstrained fn stop_vesting_invalid_stop_timestamp() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let duration = 10;
    let amount: u128 = 100;

    let (env, owner, _, _, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);

    let stop_timestamp = 1;

    env.call_private(
        owner,
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );
}

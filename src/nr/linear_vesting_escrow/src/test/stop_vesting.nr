use crate::LinearVestingEscrowLogic;
use crate::test::utils;
use aztec::test::helpers::test_environment::CallPrivateOptions;

#[test]
unconstrained fn stop_vesting_success() {
    let duration = 10;
    let amount: u128 = 10000;

    let (env, _, _, reclaimer, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);

    let stop_timestamp = env.last_block_timestamp() + duration;

    env.call_private_opts(
        reclaimer,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );

    let vesting_schedule_note =
        utils::get_vesting_schedule_note(*env, logic_contract_address, escrow_contract_address);

    assert(vesting_schedule_note.stop_timestamp == stop_timestamp, "Note: stop timestamp mismatch");
}

#[test(should_fail_with = "Vesting schedule is not active")]
unconstrained fn stop_vesting_already_stopped() {
    let duration = 10;
    let amount: u128 = 10000;

    let (env, _, _, reclaimer, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);

    let stop_timestamp = env.last_block_timestamp() + duration;

    env.call_private_opts(
        reclaimer,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );

    env.call_private_opts(
        reclaimer,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );
}

#[test(should_fail_with = "caller is not reclaimer")]
unconstrained fn stop_vesting_not_reclaimer() {
    let duration = 10;
    let amount: u128 = 100;

    let (env, _, recipient, _, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);

    let stop_timestamp = env.last_block_timestamp() + duration;

    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );
}

#[test(should_fail_with = "Timestamp mismatch")]
unconstrained fn stop_vesting_invalid_stop_timestamp() {
    let duration = 10;
    let amount: u128 = 100;

    let (env, _, _, reclaimer, logic_contract_address, escrow_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, duration);

    let stop_timestamp = 1;

    env.call_private_opts(
        reclaimer,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        LinearVestingEscrowLogic::at(logic_contract_address).stop_vesting(
            escrow_contract_address,
            stop_timestamp,
        ),
    );
}

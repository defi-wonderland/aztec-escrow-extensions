use crate::LinearVestingEscrowLogic;
use crate::test::utils;

// TODO (reenable test): TXE scope enforcement means only the caller's notes are accessible during
// private execution. The escrow's notes are not in scope when called from the logic contract.
// The TS tests handle this via `additionalScopes: [escrow.address]`, but TXE doesn't support it yet.
// #[test]
#[allow(dead_code)]
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

// TODO (reenable test): TXE scope enforcement means only the caller's notes are accessible during
// private execution. The escrow's notes are not in scope when called from the logic contract.
// The TS tests handle this via `additionalScopes: [escrow.address]`, but TXE doesn't support it yet.
// #[test(should_fail_with = "Vesting schedule is not active")]
#[allow(dead_code)]
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

// TODO (reenable test): TXE scope enforcement means only the caller's notes are accessible during
// private execution. The escrow's notes are not in scope when called from the logic contract.
// The TS tests handle this via `additionalScopes: [escrow.address]`, but TXE doesn't support it yet.
// #[test(should_fail_with = "caller is not reclaimer")]
#[allow(dead_code)]
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

// TODO (reenable test): TXE scope enforcement means only the caller's notes are accessible during
// private execution. The escrow's notes are not in scope when called from the logic contract.
// The TS tests handle this via `additionalScopes: [escrow.address]`, but TXE doesn't support it yet.
// #[test(should_fail_with = "app_logic_reverted")]
#[allow(dead_code)]
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

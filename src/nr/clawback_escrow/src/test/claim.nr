use crate::ClawbackEscrowLogic;
use crate::test::utils;
use token::test::utils as token_utils;

// TODO (reenable test): TXE scope enforcement means only the caller's notes are accessible during
// private execution. The escrow's notes are not in scope when called from the logic contract.
// The TS tests handle this via `additionalScopes: [escrow.address]`, but TXE doesn't support it yet.
// #[test]
#[allow(dead_code)]
unconstrained fn claim_tokens_success() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let timeout = 10;
    let amount: u128 = 100;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, token_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, recipient, 0);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout);
    env.call_private(
        recipient,
        ClawbackEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            token_contract_address,
            amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, amount);
}

// TODO (reenable test): TXE scope enforcement means only the caller's notes are accessible during
// private execution. The escrow's notes are not in scope when called from the logic contract.
// The TS tests handle this via `additionalScopes: [escrow.address]`, but TXE doesn't support it yet.
// #[test(should_fail_with = "Timestamp mismatch")]
#[allow(dead_code)]
unconstrained fn claim_tokens_fails_after_deadline() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let timeout = 10;
    let amount: u128 = 100;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, token_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout + 1);
    env.call_private(
        recipient,
        ClawbackEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            token_contract_address,
            amount,
        ),
    );
}

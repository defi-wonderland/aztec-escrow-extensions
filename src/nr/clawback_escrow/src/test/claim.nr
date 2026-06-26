use crate::ClawbackEscrowLogic;
use crate::test::utils;
use aztec::test::helpers::test_environment::CallPrivateOptions;
use token::test::utils as token_utils;

#[test]
unconstrained fn claim_tokens_success() {
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
    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            token_contract_address,
            amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, amount);
}

#[test(should_fail_with = "Timestamp mismatch")]
unconstrained fn claim_tokens_fails_after_deadline() {
    let timeout = 10;
    let amount: u128 = 100;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, token_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout + 1);
    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            token_contract_address,
            amount,
        ),
    );
}

use crate::ClawbackEscrowLogic;
use crate::test::utils;
use aztec::test::helpers::test_environment::CallPrivateOptions;
use token::test::utils as token_utils;

#[test]
unconstrained fn clawback_tokens_success() {
    let timeout = 10;
    let amount: u128 = 100;
    let (env, owner, _, logic_contract_address, escrow_contract_address, token_contract_address, _)
         = utils::deploy_and_create_escrow(false, amount, timeout);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, owner, 0);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout + 1);
    env.call_private_opts(
        owner,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).clawback(
            escrow_contract_address,
            token_contract_address,
            amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, owner, amount);
}

#[test(should_fail_with = "Timestamp mismatch")]
unconstrained fn clawback_tokens_fails_before_deadline() {
    let timeout = 10;
    let amount: u128 = 100;
    let (env, owner, _, logic_contract_address, escrow_contract_address, token_contract_address, _)
         = utils::deploy_and_create_escrow(false, amount, timeout);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout);
    env.call_private_opts(
        owner,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).clawback(
            escrow_contract_address,
            token_contract_address,
            amount,
        ),
    );
}

#[test]
unconstrained fn clawback_tokens_after_half_claim_success() {
    let timeout = 10;
    let amount: u128 = 100;
    let half_amount: u128 = 50;
    let (env, owner, recipient, logic_contract_address, escrow_contract_address, token_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, owner, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, 0);

    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).claim(
            escrow_contract_address,
            token_contract_address,
            half_amount,
        ),
    );

    token_utils::check_private_balance(
        *env,
        token_contract_address,
        escrow_contract_address,
        half_amount,
    );
    token_utils::check_private_balance(*env, token_contract_address, owner, 0);
    token_utils::check_private_balance(*env, token_contract_address, recipient, half_amount);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout + 1);
    env.call_private_opts(
        owner,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).clawback(
            escrow_contract_address,
            token_contract_address,
            half_amount,
        ),
    );

    token_utils::check_private_balance(*env, token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(*env, token_contract_address, owner, half_amount);
    token_utils::check_private_balance(*env, token_contract_address, recipient, half_amount);
}

use crate::ClawbackEscrowLogic;
use crate::test::utils;
use token::test::utils as token_utils;

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn claim_tokens_success() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let timeout = 10;
    let amount: u128 = 100;
    let (env, owner, recipient, logic_contract_address, escrow_contract_address, token_contract_address, _) =
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

// TODO: cannot deploy escrow contract with custom salt. This should fail trying to claim after deadline.
// #[test(should_fail_with = "Timestamp mismatch")]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn claim_tokens_fails_after_deadline() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let timeout = 10;
    let amount: u128 = 100;
    let (env, owner, recipient, logic_contract_address, escrow_contract_address, token_contract_address, _) =
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

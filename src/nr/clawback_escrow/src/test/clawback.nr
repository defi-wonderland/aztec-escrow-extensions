use crate::ClawbackEscrowLogic;
use crate::test::utils;
use aztec::{
    note::constants::MAX_NOTES_PER_PAGE,
    test::{helpers::authwit as authwit_cheatcodes, txe_constants::AZTEC_SLOT_DURATION},
};
use token::test::utils as token_utils;

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn clawback_tokens_success() {
    let timeout_blocks = 5;
    let timeout = AZTEC_SLOT_DURATION * timeout_blocks;
    let amount: u128 = 100;
    let (env, owner, recipient, logic_contract_address, escrow_contract_address, token_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    token_utils::check_private_balance(token_contract_address, escrow_contract_address, amount);
    token_utils::check_private_balance(token_contract_address, owner, 0);

    // TODO: calculate the exact edge case
    env.advance_timestamp_by(timeout);
    ClawbackEscrowLogic::at(logic_contract_address)
        .clawback(escrow_contract_address, token_contract_address, amount)
        .call(&mut env.private());
    env.advance_block_by(1);

    token_utils::check_private_balance(token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(token_contract_address, owner, amount);
}

// TODO: cannot deploy escrow contract with custom salt. This should fail trying to claim after deadline.
// #[test(should_fail_with = "Timestamp mismatch")]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn clawback_tokens_fails_before_deadline() {
    let timeout_blocks = 5;
    let timeout = AZTEC_SLOT_DURATION * timeout_blocks;
    let amount: u128 = 100;
    let (env, owner, recipient, logic_contract_address, escrow_contract_address, token_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    ClawbackEscrowLogic::at(logic_contract_address)
        .clawback(escrow_contract_address, token_contract_address, amount)
        .call(&mut env.private());
}

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Escrow salt mismatch")]
unconstrained fn clawback_tokens_after_half_claim_success() {
    let timeout_blocks = 5;
    let timeout = AZTEC_SLOT_DURATION * timeout_blocks;
    let amount: u128 = 100;
    let half_amount: u128 = 50;
    let (env, owner, recipient, logic_contract_address, escrow_contract_address, token_contract_address, _) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    token_utils::check_private_balance(token_contract_address, escrow_contract_address, amount);
    token_utils::check_private_balance(token_contract_address, owner, 0);
    token_utils::check_private_balance(token_contract_address, recipient, 0);

    ClawbackEscrowLogic::at(logic_contract_address)
        .claim(escrow_contract_address, token_contract_address, half_amount)
        .call(&mut env.private());
    env.advance_block_by(1);

    token_utils::check_private_balance(
        token_contract_address,
        escrow_contract_address,
        half_amount,
    );
    token_utils::check_private_balance(token_contract_address, owner, 0);
    token_utils::check_private_balance(token_contract_address, recipient, half_amount);

    // TODO: calculate the exact edge case
    env.advance_timestamp_by(timeout);
    ClawbackEscrowLogic::at(logic_contract_address)
        .clawback(escrow_contract_address, token_contract_address, half_amount)
        .call(&mut env.private());
    env.advance_block_by(1);

    token_utils::check_private_balance(token_contract_address, escrow_contract_address, 0);
    token_utils::check_private_balance(token_contract_address, owner, half_amount);
    token_utils::check_private_balance(token_contract_address, recipient, half_amount);
}

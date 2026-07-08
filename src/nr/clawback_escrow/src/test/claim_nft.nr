use crate::ClawbackEscrowLogic;
use crate::test::utils;
use aztec::test::helpers::test_environment::CallPrivateOptions;
use nft::test::utils as nft_utils;

#[test]
unconstrained fn claim_nft_success() {
    let timeout = 10;
    let amount: u128 = 100;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, _, nft_contract_address) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    nft_utils::assert_owns_private_nft(*env, nft_contract_address, escrow_contract_address, 1);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout);
    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).claim_nft(
            escrow_contract_address,
            nft_contract_address,
            1,
        ),
    );

    nft_utils::assert_owns_private_nft(*env, nft_contract_address, recipient, 1);
}

#[test(should_fail_with = "Timestamp mismatch")]
unconstrained fn claim_nft_fails_after_deadline() {
    let timeout = 10;
    let amount: u128 = 100;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, _, nft_contract_address) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout + 1);
    env.advance_next_block_timestamp_by(timeout);
    env.call_private_opts(
        recipient,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).claim_nft(
            escrow_contract_address,
            nft_contract_address,
            1,
        ),
    );
}

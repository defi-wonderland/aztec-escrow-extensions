use crate::ClawbackEscrowLogic;
use crate::test::utils;
use aztec::test::helpers::test_environment::CallPrivateOptions;
use nft::test::utils as nft_utils;

#[test]
unconstrained fn clawback_nft_success() {
    let timeout = 10;
    let amount: u128 = 100;
    let (env, owner, _, logic_contract_address, escrow_contract_address, _, nft_contract_address) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    nft_utils::assert_owns_private_nft(*env, nft_contract_address, escrow_contract_address, 1);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout + 1);
    env.call_private_opts(
        owner,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).clawback_nft(
            escrow_contract_address,
            nft_contract_address,
            1,
        ),
    );

    nft_utils::assert_owns_private_nft(*env, nft_contract_address, owner, 1);
}

#[test(should_fail_with = "Timestamp mismatch")]
unconstrained fn clawback_nft_fails_before_deadline() {
    let timeout = 10;
    let amount: u128 = 100;
    let (env, owner, _, logic_contract_address, escrow_contract_address, _, nft_contract_address) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout);
    env.call_private_opts(
        owner,
        CallPrivateOptions::new().with_additional_scopes([escrow_contract_address]),
        ClawbackEscrowLogic::at(logic_contract_address).clawback_nft(
            escrow_contract_address,
            nft_contract_address,
            1,
        ),
    );
}

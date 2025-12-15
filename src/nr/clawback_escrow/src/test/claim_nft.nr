use crate::ClawbackEscrowLogic;
use crate::test::utils;
use nft::test::utils as nft_utils;

// TODO: cannot deploy escrow contract with custom salt. This should pass.
// #[test]
#[test(should_fail_with = "Incorrect escrow deployment")]
unconstrained fn claim_nft_success() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let timeout = 10;
    let amount: u128 = 100;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, _, nft_contract_address) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    nft_utils::assert_owns_private_nft(*env, nft_contract_address, escrow_contract_address, 1);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout);
    env.call_private(
        recipient,
        ClawbackEscrowLogic::at(logic_contract_address).claim_nft(
            escrow_contract_address,
            nft_contract_address,
            1,
        ),
    );

    nft_utils::assert_owns_private_nft(*env, nft_contract_address, recipient, 1);
}

// TODO: cannot deploy escrow contract with custom salt. This should fail trying to claim_nft after deadline.
// #[test(should_fail_with = "Timestamp mismatch")]
#[test(should_fail_with = "Incorrect escrow deployment")]
unconstrained fn claim_nft_fails_after_deadline() {
    // TODO: Pay attention to upgrades. With each call, blocks get mined but timestamps do not advance.
    let timeout = 10;
    let amount: u128 = 100;
    let (env, _, recipient, logic_contract_address, escrow_contract_address, _, nft_contract_address) =
        utils::deploy_and_create_escrow(false, amount, timeout);

    env.set_next_block_timestamp(env.last_block_timestamp() + timeout + 1);
    env.advance_next_block_timestamp_by(timeout);
    env.call_private(
        recipient,
        ClawbackEscrowLogic::at(logic_contract_address).claim_nft(
            escrow_contract_address,
            nft_contract_address,
            1,
        ),
    );
}

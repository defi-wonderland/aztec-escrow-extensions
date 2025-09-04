use crate::LinearVestingEscrowLogic;
use aztec::{
    prelude::AztecAddress, protocol_types::contract_instance::ContractInstance,
    test::helpers::test_environment::TestEnvironment,
};

pub unconstrained fn setup_contract(
    with_account_contracts: bool,
) -> (&mut TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    // Setup env, generate keys
    let mut env = TestEnvironment::new();
    let (owner, user) = if with_account_contracts {
        let owner = env.create_account_contract(1);
        let user = env.create_account_contract(2);
        (owner, user)
    } else {
        let owner = env.create_account(1);
        let user = env.create_account(2);
        (owner, user)
    };

    let acontract = deploy_contract(&mut env, owner);

    (&mut env, acontract.to_address(), owner, user)
}

pub unconstrained fn deploy_contract(
    env: &mut TestEnvironment,
    owner: AztecAddress,
) -> ContractInstance {
    let contract_class_id = 1;
    let initializer_call_interface = LinearVestingEscrowLogic::interface().constructor(contract_class_id);
    let contract_instance = env
        .deploy("./@linear_vesting_escrow", "LinearVestingEscrowLogic")
        .with_public_void_initializer(contract_class_id, initializer_call_interface);
    env.advance_block_by(1);

    contract_instance
}

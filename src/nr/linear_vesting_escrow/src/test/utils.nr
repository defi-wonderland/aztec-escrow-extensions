use crate::LinearVestingEscrowLogic;
use crate::types::released_amount_note::ReleasedAmountNote;
use crate::types::vesting_schedule_note::VestingScheduleNote;
use aztec::{
    note::{constants::MAX_NOTES_PER_PAGE, note_viewer_options::NoteViewerOptions},
    protocol::{
        address::AztecAddress,
        point::Point,
        public_keys::{IvpkM, NpkM, OvpkM, PublicKeys, TpkM},
    },
    state_vars::{OwnedStateVariable, PrivateSet},
    test::helpers::test_environment::TestEnvironment,
};
use escrow_standard::test::utils as escrow_utils;
use token::test::utils as token_utils;
use token::Token;

pub unconstrained fn setup(
    with_account_contracts: bool,
) -> (&mut TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    // Setup env, generate keys
    let mut env = TestEnvironment::new();
    let (owner, user1, user2) = if with_account_contracts {
        let owner = env.create_contract_account();
        let user1 = env.create_contract_account();
        let user2 = env.create_contract_account();
        (owner, user1, user2)
    } else {
        let owner = env.create_light_account();
        let user1 = env.create_light_account();
        let user2 = env.create_light_account();
        (owner, user1, user2)
    };

    (&mut env, owner, user1, user2)
}

pub unconstrained fn deploy_linear_vesting_escrow_logic(
    env: &mut TestEnvironment,
    owner: AztecAddress,
    contract_class_id: Field,
) -> AztecAddress {
    let initializer_call_interface =
        LinearVestingEscrowLogic::interface().constructor(contract_class_id);
    let logic_instance = env
        .deploy("./@linear_vesting_escrow/LinearVestingEscrowLogic")
        .with_public_initializer(owner, initializer_call_interface);

    logic_instance
}

pub unconstrained fn deploy_and_create_escrow(
    with_account_contracts: bool,
    amount: u128,
    duration: u64,
    ) -> (&mut TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let (env, owner, recipient, reclaimer) = setup(with_account_contracts);

    let escrow_contract_address = escrow_utils::deploy_escrow_with_secret(env, 1);
    let escrow_class_id = escrow_utils::get_escrow_class_id();
    let logic_contract_address = deploy_linear_vesting_escrow_logic(env, owner, escrow_class_id);

    let (_, secret_key_1, _, _) = get_test_vector();

    // Deploy and mint tokens
    let token_contract_address =
        token_utils::deploy_token_with_initial_supply(env, owner, amount, owner);

    env.call_private(
        owner,
        Token::at(token_contract_address).transfer_public_to_private(
            owner,
            escrow_contract_address,
            amount,
            0,
        ),
    );

    let expected_escrow_address = env.view_private(
        owner,
        LinearVestingEscrowLogic::at(logic_contract_address).get_escrow(secret_key_1),
    );
    env.call_private(
        owner,
        LinearVestingEscrowLogic::at(logic_contract_address).setup_linear_vesting_escrow(
            recipient,
            reclaimer,
            token_contract_address,
            env.last_block_timestamp(),
            duration,
            amount,
            secret_key_1,
        ),
    );
    assert_eq(escrow_contract_address, expected_escrow_address, "Incorrect escrow deployment");

    (
        env, owner, recipient, reclaimer, logic_contract_address, escrow_contract_address,
        token_contract_address,
    )
}

pub unconstrained fn get_vesting_schedule_note(
    env: TestEnvironment,
    logic_contract_address: AztecAddress,
    escrow: AztecAddress,
) -> VestingScheduleNote {
    let offset = 0;
    let notes = env.utility_context_at(logic_contract_address, |context| {
        let options = NoteViewerOptions::new().set_limit(1).set_offset(offset);
        let vesting_schedule_slot = LinearVestingEscrowLogic::storage_layout().escrows.slot;
        let set: PrivateSet<VestingScheduleNote, _> =
            OwnedStateVariable::new(context, vesting_schedule_slot, escrow);
        let notes: BoundedVec<VestingScheduleNote, MAX_NOTES_PER_PAGE> = set.view_notes(options);
        notes
    });

    // We revert if there is no note in the filter so we can probably unwrap directly
    notes.get_unchecked(0)
}

pub unconstrained fn get_released_amount_note(
    env: TestEnvironment,
    logic_contract_address: AztecAddress,
    escrow: AztecAddress,
) -> ReleasedAmountNote {
    let offset = 0;
    let notes = env.utility_context_at(logic_contract_address, |context| {
        let options = NoteViewerOptions::new().set_limit(1).set_offset(offset);
        let released_notes_slot = LinearVestingEscrowLogic::storage_layout().released_notes.slot;
        let set: PrivateSet<ReleasedAmountNote, _> =
            OwnedStateVariable::new(context, released_notes_slot, escrow);
        let notes: BoundedVec<ReleasedAmountNote, MAX_NOTES_PER_PAGE> = set.view_notes(options);
        notes
    });

    // We revert if there is no note in the filter so we can probably unwrap directly
    notes.get_unchecked(0)
}

// TODO: import from aztec-standards logic library utils
pub unconstrained fn get_test_vector() -> (PublicKeys, Field, PublicKeys, Field) {
    // Secret key 1: derived using 1 as the seed
    let secret_key_1: Field = 1;

    let npk_x_1: Field = 0x17227b1fff943cb7386368b044855225acea756c7f4bfcc098630fb88de55a35;
    let npk_y_1: Field = 0x14a50cb11d05246965399813fc209b92632cf205c1333bafa343c41e4b29d0b8;
    let ivpk_x_1: Field = 0x1135429dcf9877365a488bd5417bcd2e042b6b79344be675577524610e402dc7;
    let ivpk_y_1: Field = 0x1184a707e50a7b7932b6d15c8daaaf8eda89e62fa44142f78c40c978cefaa5c3;
    let ovpk_x_1: Field = 0x109ff6b46a6f6e236f4f4a19b56ad60c6a5a9684be76edc2d94c4ec856f23b1a;
    let ovpk_y_1: Field = 0x2bf93b572014c0501320f338b72ad5286cdaea06062814e6f12cf3e63b67c0ce;
    let tpk_x_1: Field = 0x0c4ffde4cefc58fa18045ee1249d0d2fc9f65a2308f408c6a5f1feff56778c1a;
    let tpk_y_1: Field = 0x1ef6fce001c800647bb2b7137517181306c713f671c0e65339dd11d57c863ee8;

    let public_keys_1 = PublicKeys {
        npk_m: NpkM { inner: Point { x: npk_x_1, y: npk_y_1, is_infinite: false } },
        ivpk_m: IvpkM { inner: Point { x: ivpk_x_1, y: ivpk_y_1, is_infinite: false } },
        ovpk_m: OvpkM { inner: Point { x: ovpk_x_1, y: ovpk_y_1, is_infinite: false } },
        tpk_m: TpkM { inner: Point { x: tpk_x_1, y: tpk_y_1, is_infinite: false } },
    };

    // Secret key 2: string "RANDOM_SECRET_KEY" left-padded to 32 bytes with spaces
    // 0x20202020202020202020202020202052414e444f4d5f5345435245545f4b4559
    let secret_key_2: Field = 0x20202020202020202020202020202052414e444f4d5f5345435245545f4b4559;

    let npk_x_2: Field = 0x26344cea910770d5e95b7f80c9abddcae5fb34725e880260dc43cdf6a74b5f2f;
    let npk_y_2: Field = 0x1e884cb9a43dd3f40fe4e9d631baad1be5a56392b0ef96b797ca769c14da2578;
    let ivpk_x_2: Field = 0x0fa1458fa21d36ebeaeed4a886b7ead77acce59c743bca9d9205de972593e600;
    let ivpk_y_2: Field = 0x1630b61e635d63c2aaa28afda105410a6f3ca23dc0132e5d0314f93d13c54d09;
    let ovpk_x_2: Field = 0x14757672572bc282a967dda767d0ede9430700f4a9e024e2f9914bbfd9a48651;
    let ovpk_y_2: Field = 0x270a30dbd666fe78c5e54cf5bbc03d6f81a288a24f110b6b72998faca4705294;
    let tpk_x_2: Field = 0x05c9d2066d7aedbad14137c0b34827eda0b300f3808aa221b519a9959facec88;
    let tpk_y_2: Field = 0x0cc1c1631501a99ed1797f4d701df03c9663989fee1fb311266459b47f523e07;

    let public_keys_2 = PublicKeys {
        npk_m: NpkM { inner: Point { x: npk_x_2, y: npk_y_2, is_infinite: false } },
        ivpk_m: IvpkM { inner: Point { x: ivpk_x_2, y: ivpk_y_2, is_infinite: false } },
        ovpk_m: OvpkM { inner: Point { x: ovpk_x_2, y: ovpk_y_2, is_infinite: false } },
        tpk_m: TpkM { inner: Point { x: tpk_x_2, y: tpk_y_2, is_infinite: false } },
    };

    (public_keys_1, secret_key_1, public_keys_2, secret_key_2)
}

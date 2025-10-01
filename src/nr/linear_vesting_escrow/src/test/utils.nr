use crate::LinearVestingEscrowLogic;
use crate::types::released_amount_note::ReleasedAmountNote;
use crate::types::vesting_schedule_note::VestingScheduleNote;
use aztec::{
    note::{constants::MAX_NOTES_PER_PAGE, note_getter::view_notes, note_interface::NoteProperties},
    oracle::execution::get_contract_address,
    prelude::{AztecAddress, NoteViewerOptions},
    protocol_types::{public_keys::{IvpkM, NpkM, OvpkM, Point, PublicKeys, TpkM}, traits::ToField},
    test::helpers::{cheatcodes, test_environment::TestEnvironment},
    utils::comparison::Comparator,
};
use token::test::utils as token_utils;
use token::Token;

pub unconstrained fn setup(
    with_account_contracts: bool,
) -> (&mut TestEnvironment, AztecAddress, AztecAddress) {
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

    (&mut env, owner, user)
}

pub unconstrained fn deploy_linear_vesting_escrow_logic(
    env: &mut TestEnvironment,
    owner: AztecAddress,
    contract_class_id: Field,
) -> AztecAddress {
    let initializer_call_interface =
        LinearVestingEscrowLogic::interface().constructor(contract_class_id);
    let logic_instance = env
        .deploy("./@linear_vesting_escrow", "LinearVestingEscrowLogic")
        .with_public_void_initializer(owner, initializer_call_interface);
    env.advance_block_by(1);

    logic_instance.to_address()
}

pub unconstrained fn deploy_escrow_with_secret(
    env: &mut TestEnvironment,
    escrow_secret: Field,
) -> (AztecAddress, Field) {
    let escrow_instance = env
        .deploy_with_public_keys("./@escrow_contract", "Escrow", escrow_secret)
        .without_initializer();
    env.advance_block_by(1);

    (escrow_instance.to_address(), escrow_instance.contract_class_id.to_field())
}

pub unconstrained fn deploy_and_create_escrow(
    with_account_contracts: bool,
    amount: u128,
    duration: u64,
) -> (&mut TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let (env, owner, recipient) = setup(with_account_contracts);

    let (escrow_contract_address, contract_class_id) = deploy_escrow_with_secret(env, 1);
    let logic_contract_address = deploy_linear_vesting_escrow_logic(env, owner, contract_class_id);

    let (_, vector_secret_keys_1, _, _) = get_test_vector();

    // Deploy and mint tokens
    let token_contract_address =
        token_utils::deploy_token_with_initial_supply(env, owner, amount, owner);

    env.impersonate(owner);
    Token::at(token_contract_address)
        .transfer_public_to_private(owner, escrow_contract_address, amount, 0)
        .call(&mut env.private());
    env.advance_block_by(1);

    env.impersonate(owner);
    LinearVestingEscrowLogic::at(logic_contract_address)
        .setup_linear_vesting_escrow(
            escrow_contract_address,
            recipient,
            token_contract_address,
            env.committed_timestamp(),
            duration,
            amount,
            vector_secret_keys_1[0],
            vector_secret_keys_1[1],
            vector_secret_keys_1[2],
            vector_secret_keys_1[3],
        )
        .call(&mut env.private());
    env.advance_block_by(1);

    (env, owner, recipient, logic_contract_address, escrow_contract_address, token_contract_address)
}

pub unconstrained fn get_vesting_schedule_note(
    logic_contract_address: AztecAddress,
    escrow: AztecAddress,
) -> VestingScheduleNote {
    let current_contract_address = get_contract_address();
    cheatcodes::set_contract_address(logic_contract_address);
    let options = NoteViewerOptions::new()
        .select(VestingScheduleNote::properties().escrow, Comparator.EQ, escrow)
        .set_limit(1);
    let vesting_schedule_slot = LinearVestingEscrowLogic::storage_layout().escrows.slot;
    let notes: BoundedVec<VestingScheduleNote, MAX_NOTES_PER_PAGE> =
        view_notes(vesting_schedule_slot, options);
    cheatcodes::set_contract_address(current_contract_address);
    // We revert if there is no note in the filter so we can probably unwrap directly
    let unwrapped_note = notes.get_unchecked(0);
    unwrapped_note
}

pub unconstrained fn get_released_amount_note(
    logic_contract_address: AztecAddress,
    escrow: AztecAddress,
) -> ReleasedAmountNote {
    let current_contract_address = get_contract_address();
    cheatcodes::set_contract_address(logic_contract_address);
    let options = NoteViewerOptions::new()
        .select(ReleasedAmountNote::properties().escrow, Comparator.EQ, escrow)
        .set_limit(1);
    let released_notes_slot = LinearVestingEscrowLogic::storage_layout().released_notes.slot;
    let notes: BoundedVec<ReleasedAmountNote, MAX_NOTES_PER_PAGE> =
        view_notes(released_notes_slot, options);
    cheatcodes::set_contract_address(current_contract_address);
    // We revert if there is no note in the filter so we can probably unwrap directly
    let unwrapped_note = notes.get_unchecked(0);
    unwrapped_note
}

// TODO: import from aztec-standards logic library utils
pub unconstrained fn get_test_vector() -> (PublicKeys, [Field; 4], PublicKeys, [Field; 4]) {
    // secret keys derived using 1 as the seed
    let nsk_m_1: Field = 0x1c46232974b84af1ea0f3f8e02d68b205fa0fd765839bdd298d270c6f4d87190;
    let ivsk_m_1: Field = 0x23077d282aa597e7a1c6ffb4a1069cffd9743e861451076740cf42cb632fec84;
    let ovsk_m_1: Field = 0x0fd5dc80151e24e20e402fa82437be7483431347ca4aabde674cdb12598d0fc0;
    let tsk_m_1: Field = 0x0d104e3f086a9c3127b4152bac929180c21c06f9539b62843f4971753dd4ecf9;

    let npk_x_1: Field = 0x0b6111daac402252e041933aad127a26c9851acb11ced405d8563435bb33e0b8;
    let npk_y_1: Field = 0x0ecf620002229630f89c4f06638c3155f7e331a98e3304d92f2b7e213250d3f6;
    let ivpk_x_1: Field = 0x228e3645559e65ec052b25919ca2e8e9b610fcc1b61490a2fd7fc335909b018e;
    let ivpk_y_1: Field = 0x01ebaf7375bbeff41e6a41271ba3be92081b188654c773a76205b49265bb423c;
    let ovpk_x_1: Field = 0x1be0ff304b9be7acedfdf137a5e369576a19246f181602f7f53ba3ec319e18c8;
    let ovpk_y_1: Field = 0x19660b865a39e2196cc0ab6c0b901c23a30d275b8ec8f7d327478b24bb8629bc;
    let tpk_x_1: Field = 0x1ec58e51af858e5aca8a6f4ec35016cf3df68154d87d0fc235bedf94d1418e7e;
    let tpk_y_1: Field = 0x0e76360c52a5695c666495a6094032a486c04cf71cc9cf997bf92b916bed1493;

    let public_keys_1 = PublicKeys {
        npk_m: NpkM { inner: Point { x: npk_x_1, y: npk_y_1, is_infinite: false } },
        ivpk_m: IvpkM { inner: Point { x: ivpk_x_1, y: ivpk_y_1, is_infinite: false } },
        ovpk_m: OvpkM { inner: Point { x: ovpk_x_1, y: ovpk_y_1, is_infinite: false } },
        tpk_m: TpkM { inner: Point { x: tpk_x_1, y: tpk_y_1, is_infinite: false } },
    };

    // secret keys derived using 0x1d6b99ffb5bdcb5bdf86334af11362e602b2c245ea0edb5dc60f83ce6f4972f0 as the seed
    let nsk_m_2: Field = 0x12eef6e682b1353f4e4ac2736ff9c5007b89666d89c04c203c7ad99b68a51fea;
    let ivsk_m_2: Field = 0x0add4bb1dc9ec91f8351ba9a308b4760445a53949e1f0de0b186473adf3de4d5;
    let ovsk_m_2: Field = 0x217d4155f818e4237253bc40db9e1cc9b27e9d2509c9f694336a1a9c6bb0416f;
    let tsk_m_2: Field = 0x2731c1bf3d58ae73ef7f36f15ff444964aed6bbba02f36612c0e3c485cff2e49;

    let npk_x_2: Field = 0x19855f74850761f5bd6b831942a1ab014b731fe6ff845f0cdc71b86373cf996c;
    let npk_y_2: Field = 0x27cf95bde2b632c42489c529d70d553280eacb696ebfab6f54f68eeb65614ca1;
    let ivpk_x_2: Field = 0x1156e8a1a21091476403fc021fc8c8c2417010fcc049803608310b4cbd1e0e30;
    let ivpk_y_2: Field = 0x0764e90e1a97f43846017cffc6e638e5b32511e6c27f340a5661a63095afc7c4;
    let ovpk_x_2: Field = 0x06c70892ab6bdac9743aec506692654421f94eac1f3dc487f6bb8de3be4fd01a;
    let ovpk_y_2: Field = 0x11d429b716eb2f88bc928f6a7b8e8b8f27915ad1fa6177ab7d3df6a394dd19dc;
    let tpk_x_2: Field = 0x24bfcc0c8ec358db24627aee83f23a9df244557dacadb96509ba3ded16c8085e;
    let tpk_y_2: Field = 0x2105965ffa2511ef35854bf255c979811f76110191fae7eaf9a2b17d5c422fdd;

    let public_keys_2 = PublicKeys {
        npk_m: NpkM { inner: Point { x: npk_x_2, y: npk_y_2, is_infinite: false } },
        ivpk_m: IvpkM { inner: Point { x: ivpk_x_2, y: ivpk_y_2, is_infinite: false } },
        ovpk_m: OvpkM { inner: Point { x: ovpk_x_2, y: ovpk_y_2, is_infinite: false } },
        tpk_m: TpkM { inner: Point { x: tpk_x_2, y: tpk_y_2, is_infinite: false } },
    };

    (
        public_keys_1, [nsk_m_1, ivsk_m_1, ovsk_m_1, tsk_m_1], public_keys_2,
        [nsk_m_2, ivsk_m_2, ovsk_m_2, tsk_m_2],
    )
}

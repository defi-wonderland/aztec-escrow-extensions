use crate::ClawbackEscrowLogic;
use crate::types::clawback_escrow_note::ClawbackEscrowNote;
use aztec::{
    note::{
        constants::MAX_NOTES_PER_PAGE, note_getter::view_notes, note_interface::NoteProperties,
        note_viewer_options::NoteViewerOptions,
    },
    oracle::{
        execution::{get_block_number, get_contract_address},
        get_contract_instance::get_contract_instance,
        random::random,
        storage::storage_read,
    },
    protocol_types::{
        address::AztecAddress,
        contract_instance::ContractInstance,
        point::Point,
        public_keys::{IvpkM, NpkM, OvpkM, PublicKeys, TpkM},
        storage::map::derive_storage_slot_in_map,
        traits::ToField,
    },
    state_vars::private_set::PrivateSet,
    test::helpers::{test_environment::TestEnvironment, txe_oracles as cheatcodes},
    utils::comparison::Comparator,
};
use escrow_standard::test::utils as escrow_utils;
use escrow_standard::types::escrow_details_event::MasterSecretKeys;
use nft::NFT;
use nft::test::utils as nft_utils;
use token::test::utils as token_utils;
use token::Token;

pub unconstrained fn setup(
    with_account_contracts: bool,
) -> (&mut TestEnvironment, AztecAddress, AztecAddress) {
    // Setup env, generate keys
    let mut env = TestEnvironment::new();
    let (owner, user) = if with_account_contracts {
        let owner = env.create_contract_account();
        let user = env.create_contract_account();
        (owner, user)
    } else {
        let owner = env.create_light_account();
        let user = env.create_light_account();
        (owner, user)
    };

    (&mut env, owner, user)
}

pub unconstrained fn deploy_clawback_logic(
    env: &mut TestEnvironment,
    owner: AztecAddress,
    contract_class_id: Field,
) -> AztecAddress {
    let initializer_call_interface =
        ClawbackEscrowLogic::interface().constructor(contract_class_id);
    let logic_instance = env
        .deploy("./@clawback_escrow/ClawbackEscrowLogic")
        .with_public_initializer(owner, initializer_call_interface);

    logic_instance
}

pub unconstrained fn deploy_and_create_escrow(
    with_account_contracts: bool,
    amount: u128,
    timeout: u64,
    ) -> (&mut TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let (env, owner, recipient) = setup(with_account_contracts);

    let escrow_contract_address = escrow_utils::deploy_escrow_with_secret(env, 1);
    let escrow_instance: ContractInstance = get_contract_instance(escrow_contract_address);
    let contract_class_id = escrow_instance.contract_class_id.to_field();
    let logic_contract_address = deploy_clawback_logic(env, owner, contract_class_id);

    let (vector_public_keys_1, vector_secret_keys_1, vector_public_keys_2, vector_secret_keys_2) =
        get_test_vector();

    env.call_private(
        owner,
        ClawbackEscrowLogic::at(logic_contract_address).setup_clawback_escrow(
            escrow_contract_address,
            recipient,
            owner,
            env.last_block_timestamp() + timeout,
            vector_secret_keys_1,
        ),
    );

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

    // deploy and mint NFT with ID 1
    let nft_contract_address = nft_utils::deploy_nft_with_minter(env, owner, owner);

    env.call_private(
        owner,
        NFT::at(nft_contract_address).mint_to_private(escrow_contract_address, 1),
    );

    (
        env, owner, recipient, logic_contract_address, escrow_contract_address,
        token_contract_address, nft_contract_address,
    )
}

// TODO: import from aztec-standards logic library utils
pub unconstrained fn get_test_vector() -> (PublicKeys, MasterSecretKeys, PublicKeys, MasterSecretKeys) {
    // secret keys derived using 1 as the seed
    let master_secret_keys_1 = MasterSecretKeys {
        nsk_m: 0x1c46232974b84af1ea0f3f8e02d68b205fa0fd765839bdd298d270c6f4d87190,
        ivsk_m: 0x23077d282aa597e7a1c6ffb4a1069cffd9743e861451076740cf42cb632fec84,
        ovsk_m: 0x0fd5dc80151e24e20e402fa82437be7483431347ca4aabde674cdb12598d0fc0,
        tsk_m: 0x0d104e3f086a9c3127b4152bac929180c21c06f9539b62843f4971753dd4ecf9,
    };

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

    // secret keys derived using string "RANDOM_SECRET_KEY" left-padded to 32 bytes with spaces as the seed:
    // 0x20202020202020202020202020202052414e444f4d5f5345435245545f4b4559
    let master_secret_keys_2 = MasterSecretKeys {
        nsk_m: 0x0e9600b209142cfe453ee5082e0eb5916b381f81a1967556afe1049c87cbb2ae,
        ivsk_m: 0x01243994b0481f12305a17f6f12ed689e38c62d116efa1e2ff61718459f1d9b3,
        ovsk_m: 0x14958e327b2cbdfd7c18add0d5fc376e533f9ee47f18f47259c862a0429deaa4,
        tsk_m: 0x23c16c7e7fba57703aaf07ba75076c74d93747f2610e28689350b5e2f9061417,
    };

    let npk_x_2: Field = 0x00ecf1384fa9a5acdaddcf0ca577d12d80309aab813dcf96ea79fad43f3daad9;
    let npk_y_2: Field = 0x24c81884aece11096a3058433339dd0180756c44b4372951f169c939f569f4fb;
    let ivpk_x_2: Field = 0x1d352885fed013e664fecb7cba4b2866f247616160d7b83218dfdba95302c16d;
    let ivpk_y_2: Field = 0x0c99f03d15323e6a59211db9ac5e81027671f8892030f06c9f541876974407ca;
    let ovpk_x_2: Field = 0x022d55fad39b3889ddecf7ab7634030c15da637e86e3ed550c8148076055e31a;
    let ovpk_y_2: Field = 0x27b58d54d8f22b769382eb8753181e3d56b0e2a247af7df7c79c28f01f168cc1;
    let tpk_x_2: Field = 0x2c3a360ec75935a2f3a12761bd764fe6fd97acaec5d085144795a05cbdf0b01b;
    let tpk_y_2: Field = 0x304512f4fad762bccf727a1cb5b1654211a6fdb7c09535faa1a786dd935bff55;

    let public_keys_2 = PublicKeys {
        npk_m: NpkM { inner: Point { x: npk_x_2, y: npk_y_2, is_infinite: false } },
        ivpk_m: IvpkM { inner: Point { x: ivpk_x_2, y: ivpk_y_2, is_infinite: false } },
        ovpk_m: OvpkM { inner: Point { x: ovpk_x_2, y: ovpk_y_2, is_infinite: false } },
        tpk_m: TpkM { inner: Point { x: tpk_x_2, y: tpk_y_2, is_infinite: false } },
    };

    (public_keys_1, master_secret_keys_1, public_keys_2, master_secret_keys_2)
}

pub unconstrained fn get_escrow_note(
    env: TestEnvironment,
    logic_contract_address: AztecAddress,
    escrow: AztecAddress,
) -> ClawbackEscrowNote {
    let offset = 0;
    let notes = env.utility_context_at(logic_contract_address, |context| {
        let options = NoteViewerOptions::new()
            .select(ClawbackEscrowNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);
        let escrows_slot = ClawbackEscrowLogic::storage_layout().escrows.slot;
        let set = PrivateSet::new(context, released_notes_slot);
        let notes: BoundedVec<ClawbackEscrowNote, MAX_NOTES_PER_PAGE> =
            set.view_notes(options.set_offset(offset));
        notes
    });

    // We revert if there is no note in the filter so we can probably unwrap directly
    notes.get_unchecked(0)
}

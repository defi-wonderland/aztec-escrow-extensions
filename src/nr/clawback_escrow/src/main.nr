use aztec::macros::aztec;
mod test;
mod types;

#[aztec]
pub contract ClawbackEscrowLogic {
    // aztec library
    use crate::types::clawback_escrow_note::ClawbackEscrowNote;
    use aztec::{
        context::PrivateContext,
        macros::{
            events::event,
            functions::{initializer, private, public, utility},
            storage::storage,
        },
        messages::logs::note::encode_and_encrypt_note,
        note::{note_getter_options::NoteGetterOptions, note_interface::NoteProperties},
        protocol_types::{address::AztecAddress, public_keys::PublicKeys, traits::ToField},
        state_vars::{private_set::PrivateSet, public_immutable::PublicImmutable},
        utils::comparison::Comparator,
    };
    use escrow_standard::library::logic::{
        _check_escrow, _secret_keys_to_public_keys, _share_escrow, _withdraw, _withdraw_nft,
    };
    use escrow_standard::types::escrow_details_event::MasterSecretKeys;
    use router::utils::privately_check_timestamp;

    // @param escrow_class_id The contract class id of the escrow contract
    #[storage]
    struct Storage<Context> {
        escrow_class_id: PublicImmutable<Field, Context>,
        escrows: PrivateSet<ClawbackEscrowNote, Context>,
    }

    /// @notice Data privately emitted to an account that will use the escrow
    /// @dev We declare the event struct here to expose it in the abi as macro event cannot be used in libraries, only in contracts
    /// @param escrow The address of the escrow
    /// @param master_secret_keys The master secret keys
    #[event]
    struct EscrowDetailsLogContent {
        escrow: AztecAddress,
        master_secret_keys: MasterSecretKeys,
    }

    /// @dev Initialize the contract
    /// @param escrow_class_id The contract class id of the escrow contract
    #[public]
    #[initializer]
    fn constructor(escrow_class_id: Field) {
        storage.escrow_class_id.initialize(escrow_class_id);
    }

    /// @notice Verifies that the keys correspond to the escrow address and that the escrow
    ///         instance data is correct, shares the escrow data with the recipient and the
    ///         reclaimer, and nullifies the escrow address to prevent future reuse.
    /// @dev Reverts if the data is not correct.
    /// @param escrow The address of the escrow
    /// @param recipient The address that can claim tokens before deadline
    /// @param reclaimer The address that can clawback tokens after deadline
    /// @param deadline The timestamp after which owner can clawback
    /// @param master_secret_keys The master secret keys
    #[private]
    fn setup_clawback_escrow(
        escrow: AztecAddress,
        recipient: AztecAddress,
        reclaimer: AztecAddress,
        deadline: u64,
        master_secret_keys: MasterSecretKeys,
    ) {
        _check_escrow(
            &mut context,
            escrow,
            storage.escrow_class_id.read(),
            master_secret_keys,
        );
        _share_escrow(&mut context, reclaimer, escrow, master_secret_keys);
        _share_escrow(&mut context, recipient, escrow, master_secret_keys);

        // Create and emit note with gating logic parameters
        let note = ClawbackEscrowNote::new(escrow, recipient, reclaimer, deadline);
        let note_insertion = storage.escrows.insert(note);
        note_insertion.emit(encode_and_encrypt_note(&mut context, reclaimer));
        note_insertion.emit(encode_and_encrypt_note(&mut context, recipient));

        // Check that a clawback escrow has not been created for the provided escrow
        let nullifier = std::hash::pedersen_hash([escrow.to_field()]);
        context.push_nullifier(nullifier);
    }

    /// @notice Withdraws an amount of tokens from the provided escrow.
    /// @param escrow The address of the escrow
    /// @param token The address of the token
    /// @param amount The amount of tokens to withdraw from the escrow
    #[private]
    fn claim(escrow: AztecAddress, token: AztecAddress, amount: u128) {
        // There should only be one note per escrow
        let note = _find_clawback_note(storage, escrow);
        _withdraw(&mut context, escrow, note.recipient, token, amount);

        privately_check_timestamp(Comparator.LTE, note.deadline, &mut context);
    }

    /// @notice Withdraws an NFT from the provided escrow.
    /// @param escrow The address of the escrow
    /// @param nft The address of the NFT contract
    /// @param token_id The id of the token to withdraw from the escrow
    #[private]
    fn claim_nft(escrow: AztecAddress, nft: AztecAddress, token_id: Field) {
        // There should only be one note per escrow
        let note = _find_clawback_note(storage, escrow);
        _withdraw_nft(&mut context, escrow, note.recipient, nft, token_id);

        privately_check_timestamp(Comparator.LTE, note.deadline, &mut context);
    }

    /// @notice Withdraws an amount of tokens from the provided escrow.
    /// @param escrow The address of the escrow
    /// @param token The address of the token
    /// @param amount The amount of tokens to withdraw from the escrow
    #[private]
    fn clawback(escrow: AztecAddress, token: AztecAddress, amount: u128) {
        // There should only be one note per escrow
        let note = _find_clawback_note(storage, escrow);
        _withdraw(&mut context, escrow, note.reclaimer, token, amount);

        // Alternatively, the clawback method could rely on historical block proofs to check
        // that the deadline has passed. Pros: more efficient and no public execution. Cons:
        // reclaimer would have to wait until the deadline block is mined.
        privately_check_timestamp(Comparator.GT, note.deadline, &mut context);
    }

    /// @notice Withdraws an NFT from the provided escrow.
    /// @param escrow The address of the escrow
    /// @param nft The address of the NFT contract
    /// @param token_id The id of the token to withdraw from the escrow
    #[private]
    fn clawback_nft(escrow: AztecAddress, nft: AztecAddress, token_id: Field) {
        // There should only be one note per escrow
        let note = _find_clawback_note(storage, escrow);
        _withdraw_nft(&mut context, escrow, note.reclaimer, nft, token_id);

        // Alternatively, the clawback method could rely on historical block proofs to check
        // that the deadline has passed. Pros: more efficient and no public execution. Cons:
        // reclaimer would have to wait until the deadline block is mined.
        privately_check_timestamp(Comparator.GT, note.deadline, &mut context);
    }

    /** ==========================================================
     * ======================== UTILITIES ========================
     * ======================================================== */

    /// @notice Derives public keys from secret keys.
    /// @param master_secret_keys The master secret keys
    /// @return PublicKeys containing the derived public keys.
    #[utility]
    unconstrained fn secret_keys_to_public_keys(
        master_secret_keys: MasterSecretKeys,
    ) -> pub PublicKeys {
        _secret_keys_to_public_keys(master_secret_keys)
    }

    /** ==========================================================
     * ======================== LIBRARIES ========================
     * ======================================================== */

    #[contract_library_method]
    fn _find_clawback_note(
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
    ) -> ClawbackEscrowNote {
        let options = NoteGetterOptions::new()
            .select(ClawbackEscrowNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);
        let notes = storage.escrows.get_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        let unwrapped_note = notes.get_unchecked(0);
        unwrapped_note.note
    }
}

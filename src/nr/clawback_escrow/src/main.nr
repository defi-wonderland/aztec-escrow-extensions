use aztec::macros::aztec;
mod test;
mod types;

#[aztec]
pub contract ClawbackEscrowLogic {
    // aztec library
    use crate::types::clawback_escrow_note::ClawbackEscrowNote;
    use aztec::{
        context::PrivateContext,
        macros::{events::event, functions::{external, initializer, view}, storage::storage},
        messages::delivery::MessageDelivery,
        note::{note_getter_options::NoteGetterOptions, note_viewer_options::NoteViewerOptions},
        protocol::{address::AztecAddress, public_keys::PublicKeys, traits::ToField},
        public_checks::privately_check_timestamp,
        state_vars::{Owned, PrivateSet, PublicImmutable},
        utils::comparison::Comparator,
    };
    use escrow_standard::key_derivation;
    use escrow_standard::library::logic::{_get_escrow, _share_escrow, _withdraw, _withdraw_nft};

    // @param escrow_class_id The contract class id of the escrow contract
    #[storage]
    struct Storage<Context> {
        escrow_class_id: PublicImmutable<Field, Context>,
        escrows: Owned<PrivateSet<ClawbackEscrowNote, Context>, Context>,
    }

    /// @notice Data privately emitted to an account that will use the escrow
    /// @dev We declare the event struct here to expose it in the abi as macro event cannot be used in libraries, only in contracts
    /// @dev #[allow(dead_code)] added because is used because EscrowDetailsLogContent is defined for logging but not directly instantiated.
    /// @param escrow The address of the escrow
    /// @param secret_key The secret key used to derive master secret keys and public keys
    #[event]
    #[allow(dead_code)]
    struct EscrowDetailsLogContent {
        escrow: AztecAddress,
        secret_key: Field,
    }

    /// @dev Initialize the contract
    /// @param escrow_class_id The contract class id of the escrow contract
    #[external("public")]
    #[initializer]
    fn constructor(escrow_class_id: Field) {
        self.storage.escrow_class_id.initialize(escrow_class_id);
    }

    /// @notice Computes the escrow address from the given master secret keys and
    ///         shares the escrow data with the recipient and the reclaimer. The
    ///         escrow address is nullified to prevent future reuse.
    /// @dev Reverts if secret_key was already used.
    /// @param recipient The address that can claim tokens before deadline
    /// @param reclaimer The address that can clawback tokens after deadline
    /// @param deadline The timestamp after which owner can clawback
    /// @param secret_key The secret key used to derive master secret keys and public keys
    #[external("private")]
    fn setup_clawback_escrow(
        recipient: AztecAddress,
        reclaimer: AztecAddress,
        deadline: u64,
        secret_key: Field,
    ) {
        let escrow = _get_escrow(
            self.context,
            self.storage.escrow_class_id.read(),
            secret_key,
        );
        _share_escrow(self.context, reclaimer, escrow, secret_key);
        _share_escrow(self.context, recipient, escrow, secret_key);

        // Create and emit note with gating logic parameters
        let note = ClawbackEscrowNote { recipient, reclaimer, deadline };
        self.storage.escrows.at(escrow).insert(note).deliver(MessageDelivery::onchain_constrained());

        // Check that a clawback escrow has not been created for the provided escrow
        let nullifier = std::hash::pedersen_hash([escrow.to_field()]);
        self.context.push_nullifier_unsafe(nullifier);
    }

    /// @notice Withdraws an amount of tokens from the provided escrow.
    /// @param escrow The address of the escrow
    /// @param token The address of the token
    /// @param amount The amount of tokens to withdraw from the escrow
    #[external("private")]
    fn claim(escrow: AztecAddress, token: AztecAddress, amount: u128) {
        // There should only be one note per escrow
        let note = _find_clawback_note(self.storage, escrow);
        _withdraw(self.context, escrow, note.recipient, token, amount);

        privately_check_timestamp(Comparator.LTE, note.deadline, self.context);
    }

    /// @notice Withdraws an NFT from the provided escrow.
    /// @param escrow The address of the escrow
    /// @param nft The address of the NFT contract
    /// @param token_id The id of the token to withdraw from the escrow
    #[external("private")]
    fn claim_nft(escrow: AztecAddress, nft: AztecAddress, token_id: Field) {
        // There should only be one note per escrow
        let note = _find_clawback_note(self.storage, escrow);
        _withdraw_nft(self.context, escrow, note.recipient, nft, token_id);

        privately_check_timestamp(Comparator.LTE, note.deadline, self.context);
    }

    /// @notice Withdraws an amount of tokens from the provided escrow.
    /// @param escrow The address of the escrow
    /// @param token The address of the token
    /// @param amount The amount of tokens to withdraw from the escrow
    #[external("private")]
    fn clawback(escrow: AztecAddress, token: AztecAddress, amount: u128) {
        // There should only be one note per escrow
        let note = _find_clawback_note(self.storage, escrow);
        _withdraw(self.context, escrow, note.reclaimer, token, amount);

        // Alternatively, the clawback method could rely on historical block proofs to check
        // that the deadline has passed. Pros: more efficient and no public execution. Cons:
        // reclaimer would have to wait until the deadline block is mined.
        privately_check_timestamp(Comparator.GT, note.deadline, self.context);
    }

    /// @notice Withdraws an NFT from the provided escrow.
    /// @param escrow The address of the escrow
    /// @param nft The address of the NFT contract
    /// @param token_id The id of the token to withdraw from the escrow
    #[external("private")]
    fn clawback_nft(escrow: AztecAddress, nft: AztecAddress, token_id: Field) {
        // There should only be one note per escrow
        let note = _find_clawback_note(self.storage, escrow);
        _withdraw_nft(self.context, escrow, note.reclaimer, nft, token_id);

        // Alternatively, the clawback method could rely on historical block proofs to check
        // that the deadline has passed. Pros: more efficient and no public execution. Cons:
        // reclaimer would have to wait until the deadline block is mined.
        privately_check_timestamp(Comparator.GT, note.deadline, self.context);
    }

    /// @notice Returns the escrow address that corresponds to the given secret key and class ID.
    /// @param secret_key The secret key used to derive master secret keys and public keys
    /// @return AztecAddress of the escrow.
    #[external("private")]
    #[view]
    fn get_escrow(secret_key: Field) -> pub AztecAddress {
        _get_escrow(
            self.context,
            self.storage.escrow_class_id.read(),
            secret_key,
        )
    }

    /** ==========================================================
     * ======================== UTILITIES ========================
     * ======================================================== */

    /// @notice Derives public keys from a secret key.
    /// @param secret_key The secret key used to derive master secret keys and public keys
    /// @return PublicKeys containing the derived public keys.
    #[external("utility")]
    unconstrained fn secret_key_to_public_keys(secret_key: Field) -> pub PublicKeys {
        key_derivation::secret_key_to_public_keys(secret_key)
    }

    /// @notice Returns the clawback escrow note stored for the given escrow.
    /// @param escrow The address of the escrow
    /// @return The clawback escrow note
    #[external("utility")]
    unconstrained fn view_escrow_note(escrow: AztecAddress) -> pub ClawbackEscrowNote {
        let options = NoteViewerOptions::new().set_limit(1);
        let notes = self.storage.escrows.at(escrow).view_notes(options);
        notes.get_unchecked(0)
    }

    /** ==========================================================
     * ======================== LIBRARIES ========================
     * ======================================================== */

    #[contract_library_method]
    fn _find_clawback_note(
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
    ) -> ClawbackEscrowNote {
        let options = NoteGetterOptions::new().set_limit(1);
        let notes = storage.escrows.at(escrow).get_notes(options);
        assert(notes.len() == 1, "clawback escrow note not found");

        // We revert if there is no note in the filter so we can probably unwrap directly
        let unwrapped_note = notes.get_unchecked(0);
        unwrapped_note.note
    }
}

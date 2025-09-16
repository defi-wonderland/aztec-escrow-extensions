use aztec::macros::aztec;
mod types;

#[aztec]
contract LinearVestingEscrowLogic {
    // aztec library
    use crate::types::linear_vesting_escrow_note::LinearVestingEscrowNote;
    use aztec::{
        context::PrivateContext,
        macros::{events::event, functions::{initializer, private, public, utility}, storage::storage},
        messages::logs::note::encode_and_encrypt_note,
        note::note_interface::NoteProperties,
        prelude::{AztecAddress, NoteGetterOptions, PrivateSet, PublicImmutable},
        protocol_types::{public_keys::PublicKeys, traits::ToField},
        utils::comparison::Comparator,
    };
    use escrow_standard::library::logic::{
        _check_escrow, _secret_keys_to_public_keys, _share_escrow, _withdraw,
    };

    /// @notice Data privately emitted to an account that will use the escrow
    /// @dev We declare the event struct here to expose it in the abi as macro event cannot be used in libraries, only in contracts
    /// @param escrow The address of the escrow
    /// @param nsk_m Master Nullifier Secret Key
    /// @param ivsk_m Incoming Viewing Key
    /// @param ovsk_m Outgoing Viewing Key
    /// @param tsk_m Tagging Secret Key
    #[event]
    struct EscrowDetailsLogContent {
        escrow: AztecAddress,
        nsk_m: Field,
        ivsk_m: Field,
        ovsk_m: Field,
        tsk_m: Field,
    }

    // @param escrow_class_id The contract class id of the escrow contract
    // @param escrows The storage for the linear vesting escrows
    #[storage]
    struct Storage<Context> {
        escrow_class_id: PublicImmutable<Field, Context>,
        escrows: PrivateSet<LinearVestingEscrowNote, Context>,
    }

    /// @dev Initialize the contract
    /// @param escrow_class_id The contract class id of the escrow contract
    #[public]
    #[initializer]
    fn constructor(escrow_class_id: Field) {
        storage.escrow_class_id.initialize(escrow_class_id);
    }

    /// @notice Creates a linear vesting escrow for the provided recipient.
    /// @param escrow The address of the escrow
    /// @param recipient The address of the recipient
    /// @param token The address of the token
    /// @param start The start time of the vesting
    /// @param duration The duration of the vesting
    /// @param amount The total amount of tokens to vest
    /// @param nsk_m Master Nullifier Secret Key
    /// @param ivsk_m Incoming Viewing Key
    /// @param ovsk_m Outgoing Viewing Key
    /// @param tsk_m Tagging Secret Key
    #[private]
    fn create_linear_vesting_escrow(
        escrow: AztecAddress,
        recipient: AztecAddress,
        token: AztecAddress,
        start: u64,
        duration: u64,
        amount: u128,
        nsk_m: Field,
        ivsk_m: Field,
        ovsk_m: Field,
        tsk_m: Field,
    ) {
        _check_escrow(
            &mut context,
            escrow,
            storage.escrow_class_id.read(),
            nsk_m,
            ivsk_m,
            ovsk_m,
            tsk_m,
        );
        _share_escrow(
            &mut context,
            recipient,
            escrow,
            nsk_m,
            ivsk_m,
            ovsk_m,
            tsk_m,
        );

        // Create and emit the note with the released amount set to zero
        _create_insert_emit_linear_vesting_note(
            &mut context,
            storage,
            escrow,
            recipient,
            token,
            start,
            duration,
            amount,
            0,
        );

        // Check that a linear vesting escrow has not been created for the provided escrow and token
        // This allows to create multiple linear vesting escrows for the same escrow but with different tokens
        let nullifier = std::hash::pedersen_hash([escrow.to_field()]);
        context.push_nullifier(nullifier);
    }

    /// @notice Claims what's available from the provided escrow
    /// @param escrow The address of the escrow
    /// @param amount The amount of tokens to claim from the escrow
    #[private]
    fn claim(escrow: AztecAddress) {
        let note = _find_linear_vesting_note(storage, escrow);

        // Remove the note from the storage
        _remove_linear_vesting_note(storage, escrow);

        // Get claimable amount and vested amount
        let (claimable_amount, vested_amount) = _get_claimable_and_vested_amounts(&mut context, note);

        // We create and emit a new note to the recipient if the vested amount is less than the total amount
        if vested_amount < note.total_amount {
            _create_insert_emit_linear_vesting_note(
                &mut context,
                storage,
                escrow,
                note.recipient,
                note.token,
                note.start,
                note.duration,
                note.total_amount,
                vested_amount,
            );
        }

        // Withdraw the tokens
        _withdraw(&mut context, escrow, note.recipient, note.token, claimable_amount);
    }

    /// @notice Derives public keys from secret keys.
    /// @param nsk_m Master Nullifier Secret Key
    /// @param ivsk_m Incoming Viewing Key
    /// @param ovsk_m Outgoing Viewing Key
    /// @param tsk_m Tagging Secret Key
    /// @return PublicKeys containing the derived public keys.
    #[utility]
    pub unconstrained fn secret_keys_to_public_keys(
        nsk_m: Field,
        ivsk_m: Field,
        ovsk_m: Field,
        tsk_m: Field,
    ) -> PublicKeys {
        _secret_keys_to_public_keys(nsk_m, ivsk_m, ovsk_m, tsk_m)
    }

    /** ==========================================================
     * ======================== LIBRARIES ========================
     * ======================================================== */

    /// @notice Creates and inserts a new linear vesting note into the storage and emits it to the recipient
    /// @param context The private context
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @param recipient The address of the recipient
    /// @param token The address of the token
    /// @param start The start time of the vesting
    /// @param duration The duration of the vesting
    /// @param total_amount The total amount of tokens to vest
    /// @param released_amount The released amount of tokens
    #[contract_library_method]
    fn _create_insert_emit_linear_vesting_note(
        context: &mut PrivateContext,
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
        recipient: AztecAddress,
        token: AztecAddress,
        start: u64,
        duration: u64,
        total_amount: u128,
        released_amount: u128,
    ) {
        let note = LinearVestingEscrowNote::new(
            escrow,
            recipient,
            token,
            start,
            duration,
            total_amount,
            released_amount,
        );
        let note_insertion = storage.escrows.insert(note);
        note_insertion.emit(encode_and_encrypt_note(context, recipient, context.msg_sender()));
    }

    /// @notice Finds a linear vesting note in the storage
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The linear vesting note
    #[contract_library_method]
    fn _find_linear_vesting_note(
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
    ) -> LinearVestingEscrowNote {
        let options = NoteGetterOptions::new()
            .select(LinearVestingEscrowNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);
        let notes = storage.escrows.get_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        let unwrapped_note = notes.get_unchecked(0);
        unwrapped_note.note
    }

    /// @notice Removes a linear vesting note from the storage
    /// @param storage The storage
    /// @param escrow The address of the escrow
    #[contract_library_method]
    fn _remove_linear_vesting_note(storage: Storage<&mut PrivateContext>, escrow: AztecAddress) {
        let options = NoteGetterOptions::new()
            .select(LinearVestingEscrowNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);
        let notes = storage.escrows.get_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        let note = notes.get_unchecked(0);
        storage.escrows.remove(note);
    }

    /// @notice Gets the claimable and vested amounts for a linear vesting note
    /// @param context The private context
    /// @param note The linear vesting note
    /// @return The claimable and vested amounts
    #[contract_library_method]
    fn _get_claimable_and_vested_amounts(
        context: &mut PrivateContext,
        note: LinearVestingEscrowNote,
    ) -> (u128, u128) {
        let block_header = context.get_block_header();  
        let last_timestamp = block_header.global_variables.timestamp;
        let vested_amount = (note.total_amount * (last_timestamp - note.start) as u128 / note.duration as u128);
        let claimable_amount = vested_amount - note.released_amount;
        (claimable_amount, vested_amount)
    }
}

use aztec::macros::aztec;
mod test;
mod types;

#[aztec]
contract LinearVestingEscrowLogic {
    // aztec library
    use aztec::{
        context::{PrivateContext, UtilityContext},
        macros::{events::event, functions::{initializer, private, public, utility}, storage::storage},
        messages::logs::note::encode_and_encrypt_note,
        note::{note_interface::NoteProperties, note_viewer_options::NoteViewerOptions},
        prelude::{AztecAddress, NoteGetterOptions, PrivateSet, PublicImmutable},
        protocol_types::{public_keys::PublicKeys, traits::ToField},
        utils::comparison::Comparator,
    };
    // escrow standard library
    use escrow_standard::library::logic::{
        _check_escrow, _secret_keys_to_public_keys, _share_escrow, _withdraw,
    };
    // linear vesting escrow note type
    use crate::types::linear_vesting_escrow_note::LinearVestingEscrowNote;

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

    /// @param escrow_class_id The contract class id of the escrow contract
    /// @param escrows The storage for the linear vesting escrows
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
        _create_linear_vesting_note(
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
    #[private]
    fn claim(escrow: AztecAddress) {
        // Fetch and remove a linear vesting note from the storage
        let note = _pop_linear_vesting_note(storage, escrow);

        // Get releasable amount and vested amount
        let (releasable_amount, vested_amount) = _calculate_releasable_and_vested_amounts(&mut context, note);

        // We create and emit a new note to the recipient if the vested amount is less than the total amount
        if vested_amount < note.total_amount {
            _create_linear_vesting_note(
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
        _withdraw(&mut context, escrow, note.recipient, note.token, releasable_amount);
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

    /// @notice Calculates the releasable amount for a linear vesting note
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The releasable amount
    #[utility]
    pub unconstrained fn releasable(escrow: AztecAddress, timestamp: u64) -> u128 {
        let note = _find_linear_vesting_note_unconstrained(storage, escrow);
        let (releasable_amount, _) = _calculate_releasable_and_vested_amounts_unconstrained(note, timestamp);
        releasable_amount
    }

    /// @notice Calculates the vested amount for a linear vesting note
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The vested amount
    #[utility]
    pub unconstrained fn vestedAmount(escrow: AztecAddress, timestamp: u64) -> u128 {
        let note = _find_linear_vesting_note_unconstrained(storage, escrow);
        let (_, vested_amount) = _calculate_releasable_and_vested_amounts_unconstrained(note, timestamp);
        vested_amount
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
    fn _create_linear_vesting_note(
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

    /// @notice Pops a linear vesting note from the storage (removes and returns it)
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The linear vesting note
    #[contract_library_method]
    fn _pop_linear_vesting_note(
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
    ) -> LinearVestingEscrowNote {
        let options = NoteGetterOptions::new()
            .select(LinearVestingEscrowNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);
        
        let notes = storage.escrows.pop_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        notes.get_unchecked(0)
    }

    /// @notice Calculates the releasable and vested amounts for a linear vesting note
    /// @param context The private context
    /// @param note The linear vesting note
    /// @return The releasable and vested amounts
    #[contract_library_method]
    fn _calculate_releasable_and_vested_amounts(
        context: &mut PrivateContext,
        note: LinearVestingEscrowNote,
    ) -> (u128, u128) {
        let mut releasable_amount = 0;
        let mut vested_amount = 0;

        let block_header = context.get_block_header();  
        let timestamp = block_header.global_variables.timestamp;

        // We only calculate the amounts if the last timestamp is greater than the start time, otherwise both amounts are zero
        if timestamp >= note.start + note.duration {
            vested_amount = note.total_amount;
        } else if timestamp > note.start {
            let elapsed = timestamp - note.start;
            // Safety: 'vested_amount' is properly constrained below
            vested_amount = unsafe { calculate_vested_amount_unconstrained(note.total_amount, elapsed, note.duration) };
            assert(note.total_amount as Field * elapsed as Field == vested_amount as Field * note.duration as Field);
        }

        // Before start time, both released and vested amounts are zero
        // During and after the vesting period, vested is always greater than or equal to released
        releasable_amount = vested_amount - note.released_amount;

        (releasable_amount, vested_amount)
    }

    /// @notice Calculates the vested amount for a linear vesting note
    /// @param total_amount The total amount of tokens to vest
    /// @param elapsed The elapsed time
    /// @param duration The duration of the vesting
    /// @return The vested amount
    #[contract_library_method]
    unconstrained fn calculate_vested_amount_unconstrained(
        total_amount: u128,
        elapsed: u64, 
        duration: u64
    ) -> u128 {        
        let vested_amount_field = (total_amount as Field * elapsed as Field) / duration as Field;
        
        vested_amount_field as u128
    }

    /// @notice Finds a linear vesting note in the storage (unconstrained version for utility functions)
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The linear vesting note
    #[contract_library_method]
    unconstrained fn _find_linear_vesting_note_unconstrained(
        storage: Storage<UtilityContext>,
        escrow: AztecAddress,
    ) -> LinearVestingEscrowNote {
        let options = NoteViewerOptions::new()
            .select(LinearVestingEscrowNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);
        
        let notes = storage.escrows.view_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        notes.get_unchecked(0)
    }

    /// @notice Calculates the releasable and vested amounts for a linear vesting note (unconstrained version for utility functions)
    /// @param note The linear vesting note
    /// @param timestamp The timestamp
    /// @return The releasable and vested amounts
    #[contract_library_method]
    unconstrained fn _calculate_releasable_and_vested_amounts_unconstrained(
        note: LinearVestingEscrowNote,
        timestamp: u64,
    ) -> (u128, u128) {
        let mut releasable_amount = 0;
        let mut vested_amount = 0;

        if timestamp >= note.start + note.duration {
            vested_amount = note.total_amount;
            releasable_amount = vested_amount - note.released_amount;
        } else if timestamp > note.start {
            let elapsed = timestamp - note.start;
            // Safety: 'vested_amount' is properly constrained below
            vested_amount = unsafe { calculate_vested_amount_unconstrained(note.total_amount, elapsed, note.duration) };
            assert(note.total_amount as Field * elapsed as Field == vested_amount as Field * note.duration as Field);
            releasable_amount = vested_amount - note.released_amount;
        }

        (releasable_amount, vested_amount)
    }
}

use aztec::macros::aztec;
mod test;
mod types;

#[aztec]
contract LinearVestingEscrowLogic {
    // aztec library
    use aztec::{
        context::{PrivateContext, UtilityContext},
        macros::{
            events::event,
            functions::{initializer, private, public, utility},
            storage::storage,
        },
        messages::logs::note::encode_and_encrypt_note,
        note::{note_interface::NoteProperties, note_viewer_options::NoteViewerOptions},
        prelude::{AztecAddress, NoteGetterOptions, PrivateSet, PublicImmutable},
        protocol_types::{public_keys::PublicKeys, traits::ToField},
        utils::comparison::Comparator,
    };
    // std library
    use std::field::bn254::assert_lt;
    // escrow standard library
    use escrow_standard::library::logic::{
        _check_escrow, _secret_keys_to_public_keys, _share_escrow, _withdraw,
    };
    // vesting schedule note types
    use crate::types::vesting_schedule_note::VestingScheduleNote;
    // released amount note types
    use crate::types::released_amount_note::ReleasedAmountNote;
    // bignum library
    use bignum::{BigNum, bignum::to_field, U256};

    /// @notice Data privately emitted to an account that will use the escrow
    /// @dev We declare the event struct here to expose it in the abi as macro event cannot be used in libraries, only in contracts
    /// @param escrow The address of the escrow
    /// @param nsk_m Master Nullifier Secret Key
    /// @param ivsk_m Incoming Viewing Key
    /// @param ovsk_m Outgoing Viewing Key
    /// @param tsk_m Tagging Secret Key
    #[event]
    #[allow(dead_code)]
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
        escrows: PrivateSet<VestingScheduleNote, Context>,
        released_notes: PrivateSet<ReleasedAmountNote, Context>,
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

        // Create and emit linear vesting schedule note
        _create_vesting_schedule_note(
            &mut context,
            storage,
            escrow,
            recipient,
            token,
            start,
            duration,
            amount,
        );

        // Create and emit released amount note with zero released amount
        _create_released_amount_note(&mut context, storage, recipient, escrow, 0);

        // Check that a linear vesting escrow has not been created for the provided escrow
        let nullifier = std::hash::pedersen_hash([escrow.to_field()]);
        context.push_nullifier(nullifier);
    }

    /// @notice Claims what's available from the provided escrow
    /// @param escrow The address of the escrow
    #[private]
    fn claim(escrow: AztecAddress) {
        // Fetch a linear vesting schedule note
        let vesting_schedule_note = _get_vesting_schedule_note(storage, escrow);

        // Fetch and remove a released amount note
        let released_amount_note = _pop_released_amount_note(storage, escrow);

        // Get the current timestamp
        let block_header = context.get_block_header();
        let timestamp = block_header.global_variables.timestamp;

        // Get releasable amount and vested amount
        let (releasable_amount, vested_amount) = _calculate_releasable_and_vested_amounts(
            vesting_schedule_note.start,
            vesting_schedule_note.duration,
            vesting_schedule_note.total_amount,
            released_amount_note.released_amount,
            timestamp,
        );

        // We create and emit a new released amount note if the vested amount is less than the total amount
        if vested_amount < vesting_schedule_note.total_amount {
            _create_released_amount_note(
                &mut context,
                storage,
                vesting_schedule_note.recipient,
                escrow,
                vested_amount,
            );
        }

        // Withdraw the tokens
        _withdraw(
            &mut context,
            escrow,
            vesting_schedule_note.recipient,
            vesting_schedule_note.token,
            releasable_amount,
        );
    }

    /** ==========================================================
     * ======================== UTILITIES ========================
     * ======================================================== */

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

    /// @notice Calculates the releasable and vested amounts for a linear vesting note
    /// @param escrow The address of the escrow
    /// @param timestamp The timestamp
    /// @return The releasable and vested amounts
    #[utility]
    pub unconstrained fn releasable_and_vested_amounts(escrow: AztecAddress, timestamp: u64) -> (u128, u128) {
        let vesting_schedule_note = _view_vesting_schedule_note(storage, escrow);
        let released_amount_note = _view_released_amount_note(storage, escrow);
        let (releasable_amount, vested_amount) = _calculate_releasable_and_vested_amounts(
            vesting_schedule_note.start,
            vesting_schedule_note.duration,
            vesting_schedule_note.total_amount,
            released_amount_note.released_amount,
            timestamp,
        );
        (releasable_amount, vested_amount)
    }

    /** ==========================================================
     * ======================== LIBRARIES ========================
     * ======================================================== */

    /// @notice Creates and inserts a new linear vesting schedule note into the storage and emits it to the recipient
    /// @param context The private context
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @param recipient The address of the recipient
    /// @param token The address of the token
    /// @param start The start time of the vesting
    /// @param duration The duration of the vesting
    /// @param total_amount The total amount of tokens to vest
    #[contract_library_method]
    fn _create_vesting_schedule_note(
        context: &mut PrivateContext,
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
        recipient: AztecAddress,
        token: AztecAddress,
        start: u64,
        duration: u64,
        total_amount: u128,
    ) {
        let note =
            VestingScheduleNote::new(escrow, recipient, token, start, duration, total_amount);
        let note_insertion = storage.escrows.insert(note);
        note_insertion.emit(encode_and_encrypt_note(context, recipient, context.msg_sender()));
    }

    /// @notice Creates and inserts a new released amount note into the storage and emits it to the recipient
    /// @param context The private context
    /// @param storage The storage
    /// @param recipient The address of the recipient
    /// @param escrow The address of the escrow
    /// @param released_amount The released amount of tokens
    #[contract_library_method]
    fn _create_released_amount_note(
        context: &mut PrivateContext,
        storage: Storage<&mut PrivateContext>,
        recipient: AztecAddress,
        escrow: AztecAddress,
        released_amount: u128,
    ) {
        let note = ReleasedAmountNote::new(escrow, released_amount);
        let note_insertion = storage.released_notes.insert(note);
        note_insertion.emit(encode_and_encrypt_note(context, recipient, context.msg_sender()));
    }

    /// @notice Finds a vesting schedule note in the storage
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The vesting schedule note
    #[contract_library_method]
    fn _get_vesting_schedule_note(
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
    ) -> VestingScheduleNote {
        let options = NoteGetterOptions::new()
            .select(VestingScheduleNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);

        let notes = storage.escrows.get_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        let unwrapped_note = notes.get_unchecked(0);
        unwrapped_note.note
    }

    /// @notice Pops a released amount note from the storage
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The released amount note
    #[contract_library_method]
    fn _pop_released_amount_note(
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
    ) -> ReleasedAmountNote {
        let options = NoteGetterOptions::new()
            .select(ReleasedAmountNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);

        let notes = storage.released_notes.pop_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        notes.get_unchecked(0)
    }

    /// @notice Calculates the releasable and vested amounts
    /// @param start The start time of the vesting
    /// @param duration The duration of the vesting
    /// @param total_amount The total amount of tokens to vest
    /// @param released_amount The released amount of tokens
    /// @param timestamp The timestamp
    /// @return The releasable and vested amounts
    #[contract_library_method]
    fn _calculate_releasable_and_vested_amounts(
        start: u64,
        duration: u64,
        total_amount: u128,
        released_amount: u128,
        timestamp: u64,
    ) -> (u128, u128) {
        let mut releasable_amount = 0;
        let mut vested_amount = 0;

        // We only calculate the amounts if the last timestamp is greater than the start time, otherwise both amounts are zero
        if timestamp >= start + duration {
            vested_amount = total_amount;
        } else if timestamp > start {
            let elapsed = timestamp - start;

            // Operate on BigNum to avoid overflow of total_amount * elapsed
            // vested_amount fits in u128 because elapsed < duration, and total_amount < u128
            let vested_amount_field = u256_muldiv(total_amount, elapsed, duration);
            vested_amount = vested_amount_field as u128;
        }

        // Before start time, both released and vested amounts are zero
        // During and after the vesting period, vested is always greater than or equal to released
        releasable_amount = vested_amount - released_amount;

        (releasable_amount, vested_amount)
    }

    /// @notice Performs safe multiplication and division: (a * b) / c
    /// @param a First operand (u128)
    /// @param b Second operand (u64)
    /// @param c Divisor (u64)
    /// @return Result as Field
    #[contract_library_method]
    fn u256_muldiv(a: u128, b: u64, divisor: u64) -> Field {
        let divisor_field = divisor as Field;
        let numerator = (a as Field) * (b as Field);
        let numerator_u256 = U256::from(numerator);
        let divisor_u256 = U256::from(divisor as Field);

        // Safety: __udiv_mod is unconstrained, we then constrain the quotient and remainder to be less than a and divisor, respectively
        let (quotient, remainder) = unsafe { numerator_u256.__udiv_mod(divisor_u256) };

        let quotient_field = to_field(quotient);
        let remainder_field = to_field(remainder);

        assert_lt(remainder_field, divisor_field);
        // b < divisor always, then quotient < a
        assert_lt(quotient_field, a as Field);

        assert(quotient_field * divisor_field + remainder_field == numerator);

        quotient_field
    }

    /// @notice Finds a vesting schedule note in the storage (unconstrained version for utility functions)
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The vesting schedule note
    #[contract_library_method]
    unconstrained fn _view_vesting_schedule_note(
        storage: Storage<UtilityContext>,
        escrow: AztecAddress,
    ) -> VestingScheduleNote {
        let options = NoteViewerOptions::new()
            .select(VestingScheduleNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);

        let notes = storage.escrows.view_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        notes.get_unchecked(0)
    }

    /// @notice Finds a released amount note in the storage (unconstrained version for utility functions)
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The released amount note
    #[contract_library_method]
    unconstrained fn _view_released_amount_note(
        storage: Storage<UtilityContext>,
        escrow: AztecAddress,
    ) -> ReleasedAmountNote {
        let options = NoteViewerOptions::new()
            .select(ReleasedAmountNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);

        let notes = storage.released_notes.view_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        notes.get_unchecked(0)
    }
}

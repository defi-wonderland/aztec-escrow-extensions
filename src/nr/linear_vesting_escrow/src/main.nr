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
    // vesting schedule, released amount, final claim note types
    use crate::types::{
        released_amount_note::ReleasedAmountNote,
        vesting_schedule_note::VestingScheduleNote,
    };
    // bignum library
    use bignum::{BigNum, bignum::to_field, U256};
    // router contract
    use router::utils::privately_check_timestamp;

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
    fn setup_linear_vesting_escrow(
        escrow: AztecAddress,
        recipient: AztecAddress,
        reclaimer: AztecAddress,
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
            reclaimer,
            token,
            start,
            duration,
            amount,
            0,
        );

        // Create and emit released amount note with zero released amount
        _create_released_amount_note(&mut context, storage, recipient, reclaimer, escrow, 0);

        // Check that a linear vesting escrow has not been created for the provided escrow
        let nullifier = std::hash::pedersen_hash([escrow.to_field()]);
        context.push_nullifier(nullifier);
    }

    /// @notice Claims what's available from the provided escrow
    /// @param escrow The address of the escrow
    /// @param claim_amount The amount of tokens to claim from the escrow (enables claiming even if escrow is not fully funded)
    #[private]
    fn claim(escrow: AztecAddress, claim_amount: u128) {
        // Assert that the claim amount is greater than 0 to ensure the released amount note is strictly increasing.
        assert(claim_amount > 0);

        // Fetch a linear vesting schedule note
        let vesting_schedule_note = _get_vesting_schedule_note(storage, escrow);

        let mut claim_timestamp: u64 = 0;
        // Check if the vesting is still active
        if (vesting_schedule_note.stop_timestamp == 0) {
            // Get the anchor block's timestamp (historical reference point for private execution)
            let block_header = context.get_block_header();
            claim_timestamp = block_header.global_variables.timestamp;
        } else {
            // Get the stop timestamp from the vesting schedule note
            claim_timestamp = vesting_schedule_note.stop_timestamp;
        }

        // Fetch and remove a released amount note
        let released_amount_note = _pop_released_amount_note(storage, escrow);

        // Get releasable amount and vested amount
        let (releasable_amount, _) = _calculate_releasable_and_vested_amounts(
            vesting_schedule_note.start,
            vesting_schedule_note.duration,
            vesting_schedule_note.total_amount,
            released_amount_note.released_amount,
            claim_timestamp,
        );

        // Assert that the claim amount is less than or equal to the releasable amount
        assert(claim_amount <= releasable_amount);

        // Update the released amount note by adding the claim amount
        let updated_released_amount = released_amount_note.released_amount + claim_amount;

        // We create and emit a new released amount note
        _create_released_amount_note(
            &mut context,
            storage,
            vesting_schedule_note.recipient,
            vesting_schedule_note.reclaimer,
            escrow,
            updated_released_amount,
        );

        // Withdraw claim_amount tokens
        _withdraw(
            &mut context,
            escrow,
            vesting_schedule_note.recipient,
            vesting_schedule_note.token,
            claim_amount,
        );
    }

    /// @notice Deactivates the linear vesting
    /// @dev The deactivated note is also emitted to the recipient to notify them that the vesting is deactivated
    /// @param escrow The address of the escrow
    /// @param stop_timestamp The timestamp at which the vesting will stop (at least the timestamp of the block in which this transaction is included)
    #[private]
    fn stop_vesting(escrow: AztecAddress, stop_timestamp: u64) {
        // Pop the vesting schedule note
        let vesting_schedule_note: VestingScheduleNote =
            _pop_vesting_schedule_note(storage, escrow);

        // Assert that the message sender is the reclaimer
        assert(context.msg_sender() == vesting_schedule_note.reclaimer);

        // We assert that the vesting schedule is still active
        assert(vesting_schedule_note.stop_timestamp == 0);

        // Create a new one that is not active
        _create_vesting_schedule_note(
            &mut context,
            storage,
            escrow,
            vesting_schedule_note.recipient,
            vesting_schedule_note.reclaimer,
            vesting_schedule_note.token,
            vesting_schedule_note.start,
            vesting_schedule_note.duration,
            vesting_schedule_note.total_amount,
            stop_timestamp,
        );

        // Check timestamp through the router contract
        privately_check_timestamp(Comparator.LTE, stop_timestamp, &mut context);
    }

    /// @notice Clawbacks the escrow
    /// @notice It only makes sense to call this method if the reclaimer has something to claim
    /// in which case the recipient should receive what's left for him first
    /// @dev The clawback is only possible if the vesting schedule is not active
    /// @param escrow The address of the escrow
    /// @param reclaimer_amount The amount of tokens to clawback from the escrow
    #[private]
    fn clawback(escrow: AztecAddress, reclaimer_amount: u128) {
        // Fetch a linear vesting schedule note
        let vesting_schedule_note = _get_vesting_schedule_note(storage, escrow);

        // Assert that the message sender is the reclaimer
        assert(context.msg_sender() == vesting_schedule_note.reclaimer);

        // We assert that the vesting schedule is not active
        assert(vesting_schedule_note.stop_timestamp > 0);

        // Fetch and remove a released amount note (prevents any future claims or clawbacks)
        let released_amount_note = _pop_released_amount_note(storage, escrow);

        // Get releasable amount and vested amount
        let (releasable_amount, _) = _calculate_releasable_and_vested_amounts(
            vesting_schedule_note.start,
            vesting_schedule_note.duration,
            vesting_schedule_note.total_amount,
            released_amount_note.released_amount,
            vesting_schedule_note.stop_timestamp,
        );

        // releasable_amount can be 0 if the recipient already claimed the total amount
        if releasable_amount > 0 {
            // Withdraw the tokens for recipient
            _withdraw(
                &mut context,
                escrow,
                vesting_schedule_note.recipient,
                vesting_schedule_note.token,
                releasable_amount,
            );
        }

        // Withdraw the tokens for reclaimer
        _withdraw(
            &mut context,
            escrow,
            context.msg_sender(),
            vesting_schedule_note.token,
            reclaimer_amount,
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
    pub unconstrained fn releasable_and_vested_amounts(
        escrow: AztecAddress,
        timestamp: u64,
    ) -> (u128, u128) {
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
    /// @param reclaimer The address of the reclaimer
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
        reclaimer: AztecAddress,
        token: AztecAddress,
        start: u64,
        duration: u64,
        total_amount: u128,
        stop_timestamp: u64,
    ) {
        let note = VestingScheduleNote::new(
            escrow,
            recipient,
            reclaimer,
            token,
            start,
            duration,
            total_amount,
            stop_timestamp,
        );
        let note_insertion = storage.escrows.insert(note);
        note_insertion.emit(encode_and_encrypt_note(context, recipient, context.msg_sender()));
        note_insertion.emit(encode_and_encrypt_note(context, reclaimer, context.msg_sender()));
    }

    /// @notice Creates and inserts a new released amount note into the storage and emits it to the recipient
    /// @param context The private context
    /// @param storage The storage
    /// @param recipient The address of the recipient
    /// @param reclaimer The address of the reclaimer
    /// @param escrow The address of the escrow
    /// @param released_amount The released amount of tokens
    #[contract_library_method]
    fn _create_released_amount_note(
        context: &mut PrivateContext,
        storage: Storage<&mut PrivateContext>,
        recipient: AztecAddress,
        reclaimer: AztecAddress,
        escrow: AztecAddress,
        released_amount: u128,
    ) {
        let note = ReleasedAmountNote::new(escrow, released_amount);
        let note_insertion = storage.released_notes.insert(note);
        note_insertion.emit(encode_and_encrypt_note(context, recipient, context.msg_sender()));
        note_insertion.emit(encode_and_encrypt_note(context, reclaimer, context.msg_sender()));
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

    /// @notice Pops a vesting schedule note from the storage
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @return The vesting schedule note
    #[contract_library_method]
    fn _pop_vesting_schedule_note(
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
    ) -> VestingScheduleNote {
        let options = NoteGetterOptions::new()
            .select(VestingScheduleNote::properties().escrow, Comparator.EQ, escrow)
            .set_limit(1);

        let notes = storage.escrows.pop_notes(options);

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
        // Amount of tokens that can be released (vested amount - released amount)
        let mut releasable_amount = 0;
        // Amount of tokens that have vested linearly since the start time (total_amount * elapsed / duration)
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
    /// @param divisor Divisor (u64)
    /// @return Result as Field
    #[contract_library_method]
    fn u256_muldiv(a: u128, b: u64, divisor: u64) -> Field {
        let divisor_field = divisor as Field;
        let a_field = a as Field;
        let numerator = a_field * (b as Field);
        let numerator_u256 = U256::from(numerator);
        let divisor_u256 = U256::from(divisor_field);

        // Safety: __udiv_mod is unconstrained, we then constrain the quotient and remainder to be less than a and divisor, respectively
        let (quotient, remainder) = unsafe { numerator_u256.__udiv_mod(divisor_u256) };

        let quotient_field = to_field(quotient);
        let remainder_field = to_field(remainder);

        assert_lt(remainder_field, divisor_field);
        // b < divisor always, then quotient < a
        assert_lt(quotient_field, a_field);

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

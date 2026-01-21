use aztec::macros::aztec;
mod test;
mod types;

#[aztec]
pub contract LinearVestingEscrowLogic {
    // aztec library
    use aztec::{
        context::{PrivateContext, UtilityContext},
        macros::{events::event, functions::{external, initializer, view}, storage::storage},
        messages::message_delivery::MessageDelivery,
        note::{
            note_getter_options::NoteGetterOptions, note_interface::NoteProperties,
            note_viewer_options::NoteViewerOptions,
        },
        protocol_types::{address::AztecAddress, public_keys::PublicKeys, traits::ToField},
        state_vars::{Owned, private_set::PrivateSet, public_immutable::PublicImmutable},
        utils::comparison::Comparator,
    };
    // std library
    use std::field::bn254::assert_lt;
    // escrow standard library
    use escrow_standard::library::logic::{
        _get_escrow, _secret_keys_to_public_keys, _share_escrow, _withdraw,
    };
    use escrow_standard::types::escrow_details_event::MasterSecretKeys;
    // vesting schedule, released amount, final claim note types
    use crate::types::{
        released_amount_note::ReleasedAmountNote, vesting_schedule_note::VestingScheduleNote,
    };
    // bignum library
    use bignum::{BigNum, bignum::to_field, U256};
    // router contract
    use router::utils::privately_check_timestamp;

    /// @notice Data privately emitted to an account that will use the escrow
    /// @dev We declare the event struct here to expose it in the abi as macro event cannot be used in libraries, only in contracts
    /// @dev #[allow(dead_code)] added because is used because EscrowDetailsLogContent is defined for logging but not directly instantiated.
    /// @param escrow The address of the escrow
    /// @param master_secret_keys The master secret keys
    #[event]
    #[allow(dead_code)]
    struct EscrowDetailsLogContent {
        escrow: AztecAddress,
        master_secret_keys: MasterSecretKeys,
    }

    /// @notice Storage for the LinearVestingEscrowLogic contract
    /// @param escrow_class_id The contract class id of the escrow contract
    /// @param escrows The storage for the linear vesting escrows
    /// @param released_notes The storage for the released amount notes
    #[storage]
    struct Storage<Context> {
        escrow_class_id: PublicImmutable<Field, Context>,
        escrows: Owned<PrivateSet<VestingScheduleNote, Context>, Context>,
        released_notes: Owned<PrivateSet<ReleasedAmountNote, Context>, Context>,
    }

    /// @dev Initialize the contract
    /// @param escrow_class_id The contract class id of the escrow contract
    #[external("public")]
    #[initializer]
    fn constructor(escrow_class_id: Field) {
        self.storage.escrow_class_id.initialize(escrow_class_id);
    }

    /// @notice Creates a linear vesting escrow for the provided recipient.
    /// @param recipient The address of the recipient
    /// @param reclaimer The address of the reclaimer
    /// @param token The address of the token
    /// @param start The start time of the vesting
    /// @param duration The duration of the vesting
    /// @param amount The total amount of tokens to vest
    /// @param master_secret_keys The master secret keys
    #[external("private")]
    fn setup_linear_vesting_escrow(
        recipient: AztecAddress,
        reclaimer: AztecAddress,
        token: AztecAddress,
        start: u64,
        duration: u64,
        amount: u128,
        master_secret_keys: MasterSecretKeys,
    ) {
        // We check that start + duration does not overflow
        let _ = start + duration;

        let escrow = _get_escrow(
            self.context,
            self.storage.escrow_class_id.read(),
            master_secret_keys,
        );
        // Share the escrow with the recipient
        _share_escrow(self.context, recipient, escrow, master_secret_keys);
        // Share the escrow with the reclaimer
        _share_escrow(self.context, reclaimer, escrow, master_secret_keys);

        // Create and emit linear vesting schedule note
        _create_vesting_schedule_note(
            self.storage,
            escrow,
            recipient,
            reclaimer,
            token,
            start,
            duration,
            amount,
            0,
        );

        // Create and emit released amount note with zero released amount and claim completed set to false
        _create_released_amount_note(self.storage, escrow, 0, false);

        // Check that a linear vesting escrow has not been created for the provided escrow
        let nullifier = std::hash::pedersen_hash([escrow.to_field()]);
        self.context.push_nullifier(nullifier);
    }

    /// @notice Claims what's available from the provided escrow
    /// @dev The claim is only possible if the vesting is still active or is stopped but not completed
    /// @dev Prevents claims after claim_completed is set to true in the released amount note
    /// @param escrow The address of the escrow
    /// @param claim_amount The amount of tokens to claim from the escrow (enables claiming even if escrow is not fully funded)
    #[external("private")]
    fn claim(escrow: AztecAddress, claim_amount: u128) {
        // Fetch and remove a released amount note
        let released_amount_note = _pop_released_amount_note(self.storage, escrow);

        // Assert that the claim is not completed
        assert(!released_amount_note.claim_completed, "Claim already completed");

        // Fetch a linear vesting schedule note
        let vesting_schedule_note = _get_vesting_schedule_note(self.storage, escrow);

        let mut claim_timestamp: u64 = 0;
        let mut claim_completed: bool = false;

        // Check if the vesting is still active
        if (vesting_schedule_note.stop_timestamp == 0) {
            // Get the anchor block's timestamp (historical reference point for private execution)
            let block_header = self.context.get_anchor_block_header();
            claim_timestamp = block_header.global_variables.timestamp;
        } else {
            // Assert that the message sender is the recipient (final claim only possible for recipient)
            assert(
                self.msg_sender().unwrap() == vesting_schedule_note.recipient,
                "caller is not recipient",
            );
            // Get the stop timestamp from the vesting schedule note
            claim_timestamp = vesting_schedule_note.stop_timestamp;
            // This is the final claim since the vesting is stopped
            claim_completed = true;
        }

        // Get releasable amount and vested amount
        let (releasable_amount, _) = _calculate_releasable_and_vested_amounts(
            vesting_schedule_note.start,
            vesting_schedule_note.duration,
            vesting_schedule_note.total_amount,
            released_amount_note.released_amount,
            claim_timestamp,
        );

        // Assert that the claim amount is less than or equal to the releasable amount
        assert(claim_amount <= releasable_amount, "claim amount too high");

        // Update the released amount note by adding the claim amount
        let updated_released_amount = released_amount_note.released_amount + claim_amount;

        // We create and emit a new released amount note
        _create_released_amount_note(
            self.storage,
            escrow,
            updated_released_amount,
            claim_completed,
        );

        // Withdraw claim_amount tokens
        _withdraw(
            self.context,
            escrow,
            vesting_schedule_note.recipient,
            vesting_schedule_note.token,
            claim_amount,
        );
    }

    /// @notice Deactivates the linear vesting
    /// @dev Warning: recipient will be able to immediately claim tokens up until stop_timestamp even if that's in the future
    /// @dev The deactivated note is also emitted to the recipient to notify them that the vesting is deactivated
    /// @param escrow The address of the escrow
    /// @param stop_timestamp The timestamp at which the vesting will stop (at least the timestamp of the block in which this transaction is included)
    #[external("private")]
    fn stop_vesting(escrow: AztecAddress, stop_timestamp: u64) {
        // Pop the vesting schedule note
        let vesting_schedule_note: VestingScheduleNote =
            _pop_vesting_schedule_note(self.storage, escrow);

        // Assert that the message sender is the reclaimer
        assert(
            self.msg_sender().unwrap() == vesting_schedule_note.reclaimer,
            "caller is not reclaimer",
        );

        // We assert that the vesting schedule is still active
        assert(vesting_schedule_note.stop_timestamp == 0, "Vesting schedule is not active");

        // Create a new one that is not active
        _create_vesting_schedule_note(
            self.storage,
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
        privately_check_timestamp(Comparator.LTE, stop_timestamp, self.context);
    }

    /// @notice Clawbacks the escrow
    /// @notice It only makes sense to call this method if the reclaimer has something to claim
    /// in which case the recipient should receive what's left for him first
    /// @dev The clawback is only possible if the vesting schedule is not active
    /// @dev On first clawback, any releasable amount is sent to the recipient and claim_completed is set to true
    /// @dev The reclaimer can call clawback multiple times to recover funds incrementally
    /// @param escrow The address of the escrow
    /// @param reclaimer_amount The amount of tokens to clawback from the escrow
    #[external("private")]
    fn clawback(escrow: AztecAddress, reclaimer_amount: u128) {
        // Fetch a linear vesting schedule note
        let vesting_schedule_note = _get_vesting_schedule_note(self.storage, escrow);

        // Assert that the message sender is the reclaimer
        assert(
            self.msg_sender().unwrap() == vesting_schedule_note.reclaimer,
            "caller is not reclaimer",
        );

        // We assert that the vesting schedule is not active
        assert(vesting_schedule_note.stop_timestamp > 0, "Vesting schedule is active");

        // Fetch and remove a released amount note
        let released_amount_note = _pop_released_amount_note(self.storage, escrow);

        // Get releasable amount and vested amount
        let (releasable_amount, vested_amount) = _calculate_releasable_and_vested_amounts(
            vesting_schedule_note.start,
            vesting_schedule_note.duration,
            vesting_schedule_note.total_amount,
            released_amount_note.released_amount,
            vesting_schedule_note.stop_timestamp,
        );

        // The total released amount at stop timestamp is vested amount and the claim is completed (the recipient cannot claim anymore)
        _create_released_amount_note(self.storage, escrow, vested_amount, true);

        // releasable_amount can be 0 if the recipient already claimed the total amount
        if releasable_amount > 0 {
            // Withdraw the tokens for recipient
            _withdraw(
                self.context,
                escrow,
                vesting_schedule_note.recipient,
                vesting_schedule_note.token,
                releasable_amount,
            );
        }

        // Withdraw the tokens for reclaimer
        _withdraw(
            self.context,
            escrow,
            self.msg_sender().unwrap(),
            vesting_schedule_note.token,
            reclaimer_amount,
        );
    }

    /// @notice Returns the escrow address that corresponds to the given master secret keys and class ID.
    /// @param master_secret_keys The master secret keys
    /// @return AztecAddress of the escrow.
    #[external("private")]
    #[view]
    fn get_escrow(master_secret_keys: MasterSecretKeys) -> pub AztecAddress {
        _get_escrow(
            self.context,
            self.storage.escrow_class_id.read(),
            master_secret_keys,
        )
    }

    /** ==========================================================
     * ======================== UTILITIES ========================
     * ======================================================== */

    /// @notice Derives public keys from secret keys.
    /// @param master_secret_keys The master secret keys
    /// @return PublicKeys containing the derived public keys.
    #[external("utility")]
    unconstrained fn secret_keys_to_public_keys(
        master_secret_keys: MasterSecretKeys,
    ) -> pub PublicKeys {
        _secret_keys_to_public_keys(master_secret_keys)
    }

    /// @notice Calculates the releasable and vested amounts for a linear vesting note
    /// @param escrow The address of the escrow
    /// @param timestamp The timestamp
    /// @return The releasable and vested amounts
    #[external("utility")]
    unconstrained fn releasable_and_vested_amounts(
        escrow: AztecAddress,
        timestamp: u64,
    ) -> (u128, u128) {
        let vesting_schedule_note = _view_vesting_schedule_note(self.storage, escrow);
        let released_amount_note = _view_released_amount_note(self.storage, escrow);
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

    /// @notice Creates and inserts a new linear vesting schedule note into the storage and emits it to the escrow
    /// @param context The private context
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @param recipient The address of the recipient
    /// @param reclaimer The address of the reclaimer
    /// @param token The address of the token
    /// @param start The start time of the vesting
    /// @param duration The duration of the vesting
    /// @param total_amount The total amount of tokens to vest
    /// @param stop_timestamp The timestamp at which the vesting will stop (zero if not stopped)
    #[contract_library_method]
    fn _create_vesting_schedule_note(
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
        let note = VestingScheduleNote {
            escrow,
            recipient,
            reclaimer,
            token,
            start,
            duration,
            total_amount,
            stop_timestamp,
        };
        let note_insertion = storage.escrows.at(escrow).insert(note);
        note_insertion.deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
    }

    /// @notice Creates and inserts a new released amount note into the storage and emits it to the escrow
    /// @param context The private context
    /// @param storage The storage
    /// @param escrow The address of the escrow
    /// @param released_amount The released amount of tokens
    /// @param claim_completed Whether the final claim is done
    #[contract_library_method]
    fn _create_released_amount_note(
        storage: Storage<&mut PrivateContext>,
        escrow: AztecAddress,
        released_amount: u128,
        claim_completed: bool,
    ) {
        let note = ReleasedAmountNote { escrow, released_amount, claim_completed };
        let note_insertion = storage.released_notes.at(escrow).insert(note);
        note_insertion.deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
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

        let notes = storage.escrows.at(escrow).get_notes(options);
        assert(notes.len() == 1, "vesting schedule note not found");

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

        let notes = storage.released_notes.at(escrow).pop_notes(options);
        assert(notes.len() == 1, "released amount note not found");

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

        let notes = storage.escrows.at(escrow).pop_notes(options);
        assert(notes.len() == 1, "vesting schedule note not found");

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
            let vested_amount_field = _calculate_vested_amount(total_amount, elapsed, duration);
            vested_amount = vested_amount_field as u128;
        }

        // Before start time, both released and vested amounts are zero
        // During and after the vesting period, vested is always greater than or equal to released
        releasable_amount = vested_amount - released_amount;

        (releasable_amount, vested_amount)
    }

    /// @notice Performs safe multiplication and division for vested amount: (total_amount * elapsed) / duration
    /// @dev We operate on BigNum to avoid overflow of total_amount * elapsed
    /// @dev This function is specifically designed for this contract and is not a general purpose multiplication and division function
    /// @param total_amount First operand (u128)
    /// @param elapsed Second operand (u64)
    /// @param duration Divisor (u64)
    /// @return Result as Field
    #[contract_library_method]
    fn _calculate_vested_amount(total_amount: u128, elapsed: u64, duration: u64) -> Field {
        // (total_amount * elapsed) / duration <-> numerator / divisor
        let duration_field = duration as Field;
        let total_amount_field = total_amount as Field;
        let numerator = total_amount_field * (elapsed as Field);
        let numerator_u256 = U256::from(numerator);
        let divisor_u256 = U256::from(duration_field);

        // Safety: __udiv_mod is unconstrained, we then constrain the quotient and remainder to be less than a and divisor, respectively
        let (quotient, remainder) = unsafe { numerator_u256.__udiv_mod(divisor_u256) };

        let quotient_field = to_field(quotient);
        let remainder_field = to_field(remainder);

        assert_lt(remainder_field, duration_field);
        // elapsed < duration always, then quotient < total_amount
        assert_lt(quotient_field, total_amount_field);

        assert(quotient_field * duration_field + remainder_field == numerator);

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

        let notes = storage.escrows.at(escrow).view_notes(options);

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

        let notes = storage.released_notes.at(escrow).view_notes(options);

        // We revert if there is no note in the filter so we can probably unwrap directly
        notes.get_unchecked(0)
    }
}

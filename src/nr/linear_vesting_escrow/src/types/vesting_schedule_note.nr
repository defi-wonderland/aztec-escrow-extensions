use aztec::{
    context::PrivateContext,
    macros::notes::custom_note,
    note::note_interface::NoteHash,
    oracle::random::random,
    protocol_types::{
        address::AztecAddress,
        constants::{GENERATOR_INDEX__NOTE_HASH, GENERATOR_INDEX__NOTE_NULLIFIER},
        hash::poseidon2_hash_with_separator,
        traits::{Packable, Serialize, ToField},
    },
};

/// @param escrow The address of the escrow
/// @param recipient The address of the recipient
/// @param reclaimer The address of the reclaimer
/// @param token The address of the token
/// @param start The start time of the vesting
/// @param duration The duration of the vesting
/// @param total_amount The total amount of tokens to vest
/// @param stop_timestamp The timestamp at which the vesting stopped (if stopped by the reclaimer)
/// @param randomness The randomness used to create the note
#[derive(Packable)]
#[custom_note]
#[derive(Serialize, Eq)]
pub struct VestingScheduleNote {
    pub escrow: AztecAddress,
    pub recipient: AztecAddress,
    pub reclaimer: AztecAddress,
    pub token: AztecAddress,
    pub start: u64,
    pub duration: u64,
    pub total_amount: u128,
    pub stop_timestamp: u64,
    randomness: Field,
}

impl NoteHash for VestingScheduleNote {
    fn compute_nullifier(self, _: &mut PrivateContext, note_hash_for_nullify: Field) -> Field {
        poseidon2_hash_with_separator(
            [note_hash_for_nullify, self.escrow.to_field()],
            GENERATOR_INDEX__NOTE_NULLIFIER as Field,
        )
    }

    unconstrained fn compute_nullifier_unconstrained(self, note_hash_for_nullify: Field) -> Field {
        poseidon2_hash_with_separator(
            [note_hash_for_nullify, self.escrow.to_field()],
            GENERATOR_INDEX__NOTE_NULLIFIER as Field,
        )
    }

    fn compute_note_hash(self, storage_slot: Field) -> Field {
        poseidon2_hash_with_separator(
            self.pack().concat([storage_slot]),
            GENERATOR_INDEX__NOTE_HASH,
        )
    }
}

impl VestingScheduleNote {
    pub fn new(
        escrow: AztecAddress,
        recipient: AztecAddress,
        reclaimer: AztecAddress,
        token: AztecAddress,
        start: u64,
        duration: u64,
        total_amount: u128,
        stop_timestamp: u64,
    ) -> Self {
        // Safety: random() is safe to call here as it generates cryptographically secure randomness
        // for note creation, which is the intended use case
        let randomness = unsafe { random() };
        VestingScheduleNote {
            escrow,
            recipient,
            reclaimer,
            token,
            start,
            duration,
            total_amount,
            stop_timestamp,
            randomness,
        }
    }
}

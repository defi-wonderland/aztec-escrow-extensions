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
/// @param deadline The timestamp at which claims get disabled and clawbacks enabled
/// @param randomness The randomness used to create the note
#[derive(Packable)]
#[custom_note]
#[derive(Serialize, Eq)]
pub struct ClawbackEscrowNote {
    pub escrow: AztecAddress,
    pub recipient: AztecAddress,
    pub reclaimer: AztecAddress,
    pub deadline: u64,
    randomness: Field,
}

impl NoteHash for ClawbackEscrowNote {
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

impl ClawbackEscrowNote {
    pub fn new(
        escrow: AztecAddress,
        recipient: AztecAddress,
        reclaimer: AztecAddress,
        deadline: u64,
    ) -> Self {
        let randomness = unsafe { random() };
        ClawbackEscrowNote { escrow, recipient, reclaimer, deadline, randomness }
    }
}

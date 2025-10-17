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
/// @param released_amount The released amount of tokens
/// @param claim_completed Whether the final claim is done
/// @param randomness The randomness used to create the note
#[custom_note]
#[derive(Packable, Serialize, Eq)]
pub struct ReleasedAmountNote {
    escrow: AztecAddress,
    pub released_amount: u128,
    pub claim_completed: bool,
    randomness: Field,
}

impl NoteHash for ReleasedAmountNote {
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

impl ReleasedAmountNote {
    pub fn new(escrow: AztecAddress, released_amount: u128, claim_completed: bool) -> Self {
        // Safety: random() is safe to call here as it generates cryptographically secure randomness
        // for note creation, which is the intended use case
        let randomness = unsafe { random() };
        ReleasedAmountNote { escrow, released_amount, claim_completed, randomness }
    }
}

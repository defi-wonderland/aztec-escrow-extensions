use aztec::{
    context::PrivateContext,
    macros::notes::custom_note,
    note::note_interface::NoteHash,
    oracle::random::random,
    prelude::AztecAddress,
    protocol_types::{
        constants::{GENERATOR_INDEX__NOTE_HASH, GENERATOR_INDEX__NOTE_NULLIFIER},
        hash::poseidon2_hash_with_separator,
        traits::{Packable, Serialize, ToField},
        utils::arrays::array_concat,
    },
};

#[custom_note]
#[derive(Serialize, Eq)]
pub struct LinearVestingEscrowNote {
    escrow: AztecAddress,
    recipient: AztecAddress,
    token: AztecAddress,
    start: u64,
    duration: u64,
    total_amount: u128,
    released_amount: u128,
    randomness: Field,
}

impl NoteHash for LinearVestingEscrowNote {
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
            array_concat(self.pack(), [storage_slot]),
            GENERATOR_INDEX__NOTE_HASH,
        )
    }
}

impl LinearVestingEscrowNote {
    pub fn new(
        escrow: AztecAddress,
        recipient: AztecAddress,
        token: AztecAddress,
        start: u64,
        duration: u64,
        total_amount: u128,
        released_amount: u128,
    ) -> Self {
        // Safety: random() is safe to call here as it generates cryptographically secure randomness
        // for note creation, which is the intended use case
        let randomness = unsafe { random() };
        LinearVestingEscrowNote {
            escrow,
            recipient,
            token,
            start,
            duration,
            total_amount,
            released_amount,
            randomness,
        }
    }

    pub fn escrow(self) -> AztecAddress {
        self.escrow
    }

    pub fn recipient(self) -> AztecAddress {
        self.recipient
    }

    pub fn token(self) -> AztecAddress {
        self.token
    }

    pub fn start(self) -> u64 {
        self.start
    }

    pub fn duration(self) -> u64 {
        self.duration
    }

    pub fn total_amount(self) -> u128 {
        self.total_amount
    }

    pub fn released_amount(self) -> u128 {
        self.released_amount
    }
}

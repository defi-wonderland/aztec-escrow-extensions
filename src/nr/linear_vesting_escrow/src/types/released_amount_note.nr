use aztec::{macros::notes::note, protocol::traits::{Packable, Serialize}};

/// @param escrow The address of the escrow
/// @param released_amount The released amount of tokens
/// @param claim_completed Whether the final claim is done
#[derive(Eq, Packable, Serialize)]
#[note]
pub struct ReleasedAmountNote {
    pub released_amount: u128,
    pub claim_completed: bool,
}

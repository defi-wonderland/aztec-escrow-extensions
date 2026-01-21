use aztec::{
    macros::notes::note,
    protocol_types::{address::AztecAddress, traits::{Packable, Serialize}},
};

/// @param escrow The address of the escrow
/// @param recipient The address of the recipient
/// @param reclaimer The address of the reclaimer
/// @param deadline The timestamp at which claims get disabled and clawbacks enabled
#[derive(Eq, Packable, Serialize)]
#[note]
pub struct ClawbackEscrowNote {
    pub escrow: AztecAddress,
    pub recipient: AztecAddress,
    pub reclaimer: AztecAddress,
    pub deadline: u64,
}

use aztec::{
    macros::notes::note,
    protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
};

/// @param escrow The address of the escrow
/// @param recipient The address of the recipient
/// @param reclaimer The address of the reclaimer
/// @param deadline The timestamp at which claims get disabled and clawbacks enabled
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct ClawbackEscrowNote {
    pub recipient: AztecAddress,
    pub reclaimer: AztecAddress,
    pub deadline: u64,
}

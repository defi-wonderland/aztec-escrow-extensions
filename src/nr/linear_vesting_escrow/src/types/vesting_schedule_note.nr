use aztec::{macros::notes::note, protocol::{address::AztecAddress, traits::{Packable, Serialize}}};

/// @param escrow The address of the escrow
/// @param recipient The address of the recipient
/// @param reclaimer The address of the reclaimer
/// @param token The address of the token
/// @param start The start time of the vesting
/// @param duration The duration of the vesting
/// @param total_amount The total amount of tokens to vest
/// @param stop_timestamp The timestamp at which the vesting stopped (if stopped by the reclaimer)
#[derive(Eq, Packable, Serialize)]
#[note]
pub struct VestingScheduleNote {
    pub recipient: AztecAddress,
    pub reclaimer: AztecAddress,
    pub token: AztecAddress,
    pub start: u64,
    pub duration: u64,
    pub total_amount: u128,
    pub stop_timestamp: u64,
}

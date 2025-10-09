# Linear Vesting Escrow Logic Contract

The `LinearVestingEscrowLogic` contract supports privacy-preserving linear vesting schedules of escrowed tokens compliant with the [AIP-20 Aztec Token Standard](https://forum.aztec.network/t/request-for-comments-aip-20-aztec-token-standard/7737). The total amount to be vested must be defined at each escrow's setup, but the escrow itself can be funded at any point. It is the responsibility of the user to fund the escrow with the desired amount of tokens. Tokens sent the to the escrow that exceed the amount predefined at setup will be lost.  

The `LinearVestingEscrowLogic` address can be publicly known and multiple independent linear vesting escrows can be setup with it without leaking any information.

The `LinearVestingEscrowLogic` should be used with escrow instances of the [standardized escrow implementation]( https://github.com/defi-wonderland/aztec-standards/tree/dev).

## Storage Fields
- `escrow_class_id: Field`: Contract Class ID of the escrow contract that the logic contract supports.
- `escrows: PrivateSet<VestingScheduleNote, Context>`: Note containing vesting schedule information for each escrow.
- `released_notes: PrivateSet<ReleasedAmountNote, Context>`: Note the tracks the amount of tokens already released for each escrow.

## Initializer Functions

### constructor_with_initial_supply
```rust
/// @dev Initialize the contract
/// @param escrow_class_id The contract class id of the escrow contract
#[public]
#[initializer]
fn constructor(escrow_class_id: Field) { /* ... */ }
```

## Private Functions

### create_clawback_escrow
```rust
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
    token: AztecAddress,
    start: u64,
    duration: u64,
    amount: u128,
    nsk_m: Field,
    ivsk_m: Field,
    ovsk_m: Field,
    tsk_m: Field,
) { /* ... */ }
```

### claim
```rust
/// @notice Claims what's available from the provided escrow
/// @param escrow The address of the escrow
#[private]
fn claim(escrow: AztecAddress) { /* ... */ }
```

# Clawback Escrow Logic Contract

The `ClawbackEscrowLogic` contract supports privacy-preserving claims of escrowed NFTs and tokens, compliant with the [AIP-20 Aztec Token Standard](https://forum.aztec.network/t/request-for-comments-aip-20-aztec-token-standard/7737), with a clawback feature that get activated after a predefined deadline. Recipients may claim any asset (NFT or AIP-20 tokens) up until the deadline, inclusive, defined at setup, while reclaimers may claim any asset after the deadline.

The `ClawbackEscrowLogic` address can be publicly known and multiple independent escrows can be setup with it without leaking any information. Deadline timestamps are checked in Aztec's public execution environment, but this is done through the router contract so that the contracts addresses and function calls are not revealed.

The `ClawbackEscrowLogic` should be used with escrow instances of the [standardized escrow implementation]( https://github.com/defi-wonderland/aztec-standards/tree/dev).

> ⚠️ **WARNING — Private Balance Loss**
>
> any tokens transferred to the Clawback Escrow Logic's private balance will be lost forever, as the contract doesn't have keys to spend a private balance nor any recovery mechanism. Tokens must be sent to the Escrow contract private balance. Tokens sent to the Escrow's public balance will be lost as well.

## Storage Fields

- `escrow_class_id: Field`: Contract Class ID of the escrow contract that the logic contract supports.
- `escrows: PrivateSet<ClawbackEscrowNote>`: Note containing relevant information for each escrow.

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

### setup_clawback_escrow
```rust
/// @notice Verifies that the keys correspond to the escrow address and that the escrow
///         instance data is correct, shares the escrow data with the recipient and the
///         reclaimer, and nullifies the escrow address to prevent future reuse.
/// @dev Reverts if the data is not correct.
/// @param escrow The address of the escrow
/// @param recipient The address that can claim tokens before deadline
/// @param reclaimer The address that can clawback tokens after deadline
/// @param deadline The timestamp after which owner can clawback
/// @param nsk_m Master Nullifier Secret Key
/// @param ivsk_m Incoming Viewing Key
/// @param ovsk_m Outgoing Viewing Key
/// @param tsk_m Tagging Secret Key
#[private]
fn setup_clawback_escrow(
    escrow: AztecAddress,
    recipient: AztecAddress,
    reclaimer: AztecAddress,
    deadline: u64,
    nsk_m: Field,
    ivsk_m: Field,
    ovsk_m: Field,
    tsk_m: Field,
) { /* ... */ }
```

### claim
```rust
/// @notice Withdraws an amount of tokens from the provided escrow.
/// @param escrow The address of the escrow
/// @param token The address of the token
/// @param amount The amount of tokens to withdraw from the escrow
#[private]
fn claim(escrow: AztecAddress, token: AztecAddress, amount: u128) { /* ... */ }
```

### claim_nft
```rust
/// @notice Withdraws an NFT from the provided escrow.
/// @param escrow The address of the escrow
/// @param nft The address of the NFT contract
/// @param token_id The id of the token to withdraw from the escrow
#[private]
fn claim_nft(escrow: AztecAddress, nft: AztecAddress, amount: u128) { /* ... */ }
```

### clawback
```rust
/// @notice Withdraws an amount of tokens from the provided escrow.
/// @param escrow The address of the escrow
/// @param token The address of the token
/// @param amount The amount of tokens to withdraw from the escrow
#[private]
fn clawback(escrow: AztecAddress, token: AztecAddress, amount: u128) { /* ... */ }
```

### clawback_nft
```rust
/// @notice Withdraws an NFT from the provided escrow.
/// @param escrow The address of the escrow
/// @param nft The address of the NFT contract
/// @param token_id The id of the token to withdraw from the escrow
#[private]
fn clawback_nft(escrow: AztecAddress, nft: AztecAddress, amount: u128) { /* ... */ }
```
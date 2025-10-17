import {
  type AccountWallet,
  type ContractFunctionInteraction,
  type PXE,
  getContractClassFromArtifact,
  Fr,
} from "@aztec/aztec.js";
import { getInitialTestAccountsManagers } from "@aztec/accounts/testing";
import { deriveKeys } from "@aztec/stdlib/keys";

// Import the new Benchmark base class and context
import { Benchmark, BenchmarkContext } from "@defi-wonderland/aztec-benchmark";
import type { NamedBenchmarkedInteraction } from "@defi-wonderland/aztec-benchmark/dist/types.js";

import { TokenContract } from "../src/artifacts/Token.js";
import {
  AMOUNT,
  deployEscrowWithPublicKeysAndSalt,
  deployLinearVestingEscrow,
  deployTokenWithMinter,
  setupPXE,
  grumpkinScalarToFr,
} from "../src/ts/utils.js";

import { LinearVestingEscrowLogicContract } from "../src/artifacts/LinearVestingEscrowLogic.js";
import {
  EscrowContractArtifact,
  EscrowContract,
} from "../src/artifacts/Escrow.js";

// Escrow key counter starting at 1000 (no overlap with clawback escrow key counter), incremented on each deployment
let escrowKeyCounter = 1000n;
const AZTEC_SLOT_TIME = 36n;

async function deployEscrow(
  pxe: PXE,
  deployer: AccountWallet,
  linearVestingEscrowContract: LinearVestingEscrowLogicContract,
) {
  const escrowSk = new Fr(escrowKeyCounter);
  escrowKeyCounter += 1n;
  const escrowKeys = await deriveKeys(escrowSk);
  const escrowSalt = new Fr(linearVestingEscrowContract.address.toBigInt());

  const escrowContract = (await deployEscrowWithPublicKeysAndSalt(
    escrowKeys.publicKeys,
    deployer,
    escrowSalt,
  )) as EscrowContract;

  const partialAddressEscrow = await escrowContract.partialAddress;
  await pxe.registerAccount(escrowSk, partialAddressEscrow);

  const secretKeys = [
    grumpkinScalarToFr(escrowKeys.masterNullifierSecretKey),
    grumpkinScalarToFr(escrowKeys.masterIncomingViewingSecretKey),
    grumpkinScalarToFr(escrowKeys.masterOutgoingViewingSecretKey),
    grumpkinScalarToFr(escrowKeys.masterTaggingSecretKey),
  ];

  return { escrowContract, secretKeys };
}

// Extend the BenchmarkContext from the new package
interface LinearVestingEscrowBenchmarkContext extends BenchmarkContext {
  pxe: PXE;
  deployer: AccountWallet;
  accounts: AccountWallet[];
  linearVestingEscrowContract: LinearVestingEscrowLogicContract;
  escrows: { contract: EscrowContract; secretKeys: Fr[] }[];
  tokenContract: TokenContract;
  additionalData: {
    start_1: bigint;
    duration_1: bigint;
    stop_timestamp_2: bigint;
    clawbackAmount_2: bigint;
    stop_timestamp_3: bigint;
    clawbackAmount_3: bigint;
    releasableAmount_3: bigint;
  };
}

// Use export default class extending Benchmark
export default class LinearVestingEscrowContractBenchmark extends Benchmark {
  /**
   * Sets up the benchmark environment for the LinearVestingEscrowContract.
   * Creates PXE client, gets accounts, and deploys the contract.
   */

  async setup(): Promise<LinearVestingEscrowBenchmarkContext> {
    const { pxe, store } = await setupPXE("bench-linear-vesting");
    const managers = await getInitialTestAccountsManagers(pxe);
    const accounts = await Promise.all(managers.map((acc) => acc.register()));
    const [deployer] = accounts;

    const escrowClassId = (
      await getContractClassFromArtifact(EscrowContractArtifact)
    ).id;
    const linearVestingEscrowContract = await deployLinearVestingEscrow(
      deployer,
      escrowClassId,
    );

    // Escrows benchmarks:
    // 0 - Create, partial and full claim
    // 1 - [Create] Stop vesting and clawback (withdraw to recipient)
    // 3 - [Create and stop vesting] Final claim and clawback (no withdraw to recipient)
    const { escrowContract: escrowContract_1, secretKeys: secretKeys_1 } =
      await deployEscrow(pxe, deployer, linearVestingEscrowContract);
    const { escrowContract: escrowContract_2, secretKeys: secretKeys_2 } =
      await deployEscrow(pxe, deployer, linearVestingEscrowContract);
    const { escrowContract: escrowContract_3, secretKeys: secretKeys_3 } =
      await deployEscrow(pxe, deployer, linearVestingEscrowContract);

    const escrows = [
      { contract: escrowContract_1, secretKeys: secretKeys_1 },
      { contract: escrowContract_2, secretKeys: secretKeys_2 },
      { contract: escrowContract_3, secretKeys: secretKeys_3 },
    ];

    // Deploy a token contract and fund the escrows
    const tokenContract = (await deployTokenWithMinter(
      deployer,
      {},
    )) as TokenContract;
    await tokenContract
      .withWallet(deployer)
      .methods.mint_to_private(
        escrowContract_1.address,
        escrowContract_1.address,
        AMOUNT,
      )
      .send()
      .wait();
    await tokenContract
      .withWallet(deployer)
      .methods.mint_to_private(
        escrowContract_2.address,
        escrowContract_2.address,
        AMOUNT,
      )
      .send()
      .wait();
    await tokenContract
      .withWallet(deployer)
      .methods.mint_to_private(
        escrowContract_3.address,
        escrowContract_3.address,
        AMOUNT,
      )
      .send()
      .wait();

    const currentBlockNumber = await pxe.getBlockNumber();
    const currentBlock = await pxe.getBlock(currentBlockNumber);
    const currentTimestamp = currentBlock!.header.globalVariables.timestamp;

    // Second escrow: Stop vesting and clawback (withdraw to recipient)
    const [alice, bob] = accounts;

    // Set the start timestamp equal to the start 1 slot before it is stopped
    const start_2 = currentTimestamp + AZTEC_SLOT_TIME * 6n;
    // We choose a 4 slots duration be able to clawback the remaining amount
    const duration_2 = AZTEC_SLOT_TIME * 4n;
    // Stop timestamp (1 slot after starting)
    const stopTimestamp_2 = start_2 + AZTEC_SLOT_TIME;
    // Setup the second escrow
    await linearVestingEscrowContract
      .withWallet(alice)
      .methods.setup_linear_vesting_escrow(
        escrows[1].contract.address,
        bob.getAddress(),
        alice.getAddress(),
        tokenContract.address,
        start_2,
        duration_2,
        AMOUNT,
        escrows[1].secretKeys[0],
        escrows[1].secretKeys[1],
        escrows[1].secretKeys[2],
        escrows[1].secretKeys[3],
      )
      .send()
      .wait();

    // Get the releasable amount of the second escrow
    const [_, vestedAmount_2] = await linearVestingEscrowContract
      .withWallet(alice)
      .methods.releasable_and_vested_amounts(
        escrows[1].contract.address,
        stopTimestamp_2,
      )
      .simulate();

    const clawbackAmount_2 = AMOUNT - vestedAmount_2;

    // Set the start timestamp equal to one previous to the stop
    const start_3 = currentTimestamp + AZTEC_SLOT_TIME * 8n;
    // We choose a 4 slots duration be able to claim the remaining amount and then clawback the rest
    const duration_3 = AZTEC_SLOT_TIME * 4n;
    // Stop timestamp (1 slot after starting)
    const stopTimestamp_3 = start_3 + AZTEC_SLOT_TIME;

    // Third escrow: Create and stop vesting
    await linearVestingEscrowContract
      .withWallet(alice)
      .methods.setup_linear_vesting_escrow(
        escrows[2].contract.address,
        bob.getAddress(),
        alice.getAddress(),
        tokenContract.address,
        start_3,
        duration_3,
        AMOUNT,
        escrows[2].secretKeys[0],
        escrows[2].secretKeys[1],
        escrows[2].secretKeys[2],
        escrows[2].secretKeys[3],
      )
      .send()
      .wait();

    // Get the releasable amount of the third escrow
    const [releasableAmount_3, vestedAmount_3] =
      await linearVestingEscrowContract
        .withWallet(alice)
        .methods.releasable_and_vested_amounts(
          escrows[2].contract.address,
          stopTimestamp_3,
        )
        .simulate();
    const clawbackAmount_3 = AMOUNT - vestedAmount_3;

    // Sync to get linear vesting escrow note
    await linearVestingEscrowContract
      .withWallet(alice)
      .methods.sync_private_state()
      .simulate({});

    await linearVestingEscrowContract
      .withWallet(alice)
      .methods.stop_vesting(escrows[2].contract.address, stopTimestamp_3)
      .send()
      .wait();

    // Get the start timestamp of the first escrow
    const blockNumber = await pxe.getBlockNumber();
    const block = await pxe.getBlock(blockNumber);
    const start_1 = block!.header.globalVariables.timestamp;
    // We set the duration so that the first claim is one AZTEC_SLOT_TIME after the start, hence partially claimable
    // The second claim is fully claimable because is exactly two AZTEC_SLOT_TIME after the start, it claims the remaining amount
    const duration_1 = AZTEC_SLOT_TIME * 2n;

    const additionalData = {
      start_1: start_1,
      duration_1: duration_1,
      stop_timestamp_2: stopTimestamp_2,
      clawbackAmount_2: clawbackAmount_2,
      stop_timestamp_3: stopTimestamp_3,
      clawbackAmount_3: clawbackAmount_3,
      releasableAmount_3: releasableAmount_3,
    };

    return {
      pxe,
      deployer,
      accounts,
      linearVestingEscrowContract,
      escrows,
      tokenContract,
      additionalData,
    };
  }

  /**
   * Returns the list of LinearVestingEscrowContract methods to be benchmarked.
   */
  getMethods(
    context: LinearVestingEscrowBenchmarkContext,
  ): Array<NamedBenchmarkedInteraction | ContractFunctionInteraction> {
    const {
      linearVestingEscrowContract,
      accounts,
      escrows,
      tokenContract,
      additionalData,
    } = context;

    const [alice, bob] = accounts;

    // The order of the methods is important because some of them depend on the previous ones and timestamps are involved.
    const methods: Array<
      NamedBenchmarkedInteraction | ContractFunctionInteraction
    > = [
      // Setup linear vesting escrow
      linearVestingEscrowContract
        .withWallet(alice)
        .methods.setup_linear_vesting_escrow(
          escrows[0].contract.address,
          bob.getAddress(),
          alice.getAddress(),
          tokenContract.address,
          additionalData.start_1,
          additionalData.duration_1,
          AMOUNT,
          escrows[0].secretKeys[0],
          escrows[0].secretKeys[1],
          escrows[0].secretKeys[2],
          escrows[0].secretKeys[3],
        ),
      // Partial claim (emits released amount note)
      {
        interaction: linearVestingEscrowContract
          .withWallet(bob)
          .methods.claim(escrows[0].contract.address, AMOUNT / 2n),
        name: "(partial) claim",
      },
      // Claim the remaining amount (does not emit released amount note)
      {
        interaction: linearVestingEscrowContract
          .withWallet(bob)
          .methods.claim(escrows[0].contract.address, AMOUNT / 2n),
        name: "(full) claim",
      },
      // Stop vesting
      linearVestingEscrowContract
        .withWallet(alice)
        .methods.stop_vesting(
          escrows[1].contract.address,
          additionalData.stop_timestamp_2,
        ),
      // Clawback the second escrow
      linearVestingEscrowContract
        .withWallet(alice)
        .methods.clawback(
          escrows[1].contract.address,
          additionalData.clawbackAmount_2,
        ),
      // Claim after stop vesting
      {
        interaction: linearVestingEscrowContract
          .withWallet(bob)
          .methods.claim(
            escrows[2].contract.address,
            additionalData.releasableAmount_3,
          ),
        name: "(final) claim",
      },
      // Clawback without withdrawing to recipient
      {
        interaction: linearVestingEscrowContract
          .withWallet(alice)
          .methods.clawback(
            escrows[2].contract.address,
            additionalData.clawbackAmount_3,
          ),
        name: "(no withdraw to recipient) clawback",
      },
    ];

    return methods.filter(Boolean);
  }
}

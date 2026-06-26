import { Fr } from "@aztec/aztec.js/fields";
import { deriveKeys } from "@aztec/stdlib/keys";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { AztecNode } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";
import type { ContractInstanceWithAddress } from "@aztec/aztec.js/contracts";
import type { ContractFunctionInteractionCallIntent } from "@aztec/aztec.js/authorization";

// Import the new Benchmark base class and context
import { Benchmark, BenchmarkContext } from "@defi-wonderland/aztec-benchmark";
import type { NamedBenchmarkedInteraction } from "@defi-wonderland/aztec-benchmark/dist/types.js";

import { TokenContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";
import {
  AMOUNT,
  deployEscrowWithPublicKeysAndSalt,
  deployLinearVestingEscrow,
  deployTokenWithMinter,
  setupTestSuite,
  syncPXE,
} from "../src/ts/utils.js";

import { LinearVestingEscrowLogicContract } from "../src/artifacts/LinearVestingEscrowLogic.js";
import {
  EscrowContractArtifact,
  EscrowContract,
} from "@defi-wonderland/aztec-standards/dist/src/artifacts/Escrow.js";

// Escrow key counter starting at 1000 (no overlap with clawback escrow key counter), incremented on each deployment
let escrowKeyCounter = 1000n;
const AZTEC_SLOT_TIME = 36n;

async function deployEscrow(
  wallet: Wallet,
  node: AztecNode,
  deployer: AztecAddress,
  linearVestingEscrowContract: LinearVestingEscrowLogicContract,
) {
  const escrowSk = new Fr(escrowKeyCounter);
  escrowKeyCounter += 1n;
  const escrowKeys = await deriveKeys(escrowSk);
  const escrowSalt = new Fr(linearVestingEscrowContract.address.toBigInt());

  const escrowContract = (await deployEscrowWithPublicKeysAndSalt(
    escrowKeys.publicKeys,
    wallet,
    deployer,
    escrowSalt,
  )) as EscrowContract;

  const escrowInstance = (await node.getContract(
    escrowContract.address,
  )) as ContractInstanceWithAddress;
  if (escrowInstance) {
    await wallet.registerContract(
      escrowInstance,
      EscrowContractArtifact,
      escrowSk,
    );
  }

  const secretKey = escrowSk;

  return { escrowContract, secretKey };
}

// Extend the BenchmarkContext from the new package
interface LinearVestingEscrowBenchmarkContext extends BenchmarkContext {
  cleanup: () => Promise<void>;
  deployer: AztecAddress;
  wallet: EmbeddedWallet;
  accounts: AztecAddress[];
  linearVestingEscrowContract: LinearVestingEscrowLogicContract;
  escrows: {
    contract: EscrowContract;
    secretKey: Fr;
  }[];
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
   * Gets accounts, and deploys the contract.
   */

  async setup(): Promise<LinearVestingEscrowBenchmarkContext> {
    const { node, wallet, accounts, cleanup } = await setupTestSuite(
      "bench-linear-vesting",
      true,
    );
    const [deployer] = accounts;

    const escrowClassId = (
      await getContractClassFromArtifact(EscrowContractArtifact)
    ).id;
    const linearVestingEscrowContract = await deployLinearVestingEscrow(
      wallet,
      deployer,
      escrowClassId,
    );

    // Escrows benchmarks:
    // 0 - Create, partial and full claim
    // 1 - [Create] Stop vesting and clawback (withdraw to recipient)
    // 3 - [Create and stop vesting] Final claim and clawback (no withdraw to recipient)
    const { escrowContract: escrowContract_1, secretKey: secretKey_1 } =
      await deployEscrow(wallet, node, deployer, linearVestingEscrowContract);
    const { escrowContract: escrowContract_2, secretKey: secretKey_2 } =
      await deployEscrow(wallet, node, deployer, linearVestingEscrowContract);
    const { escrowContract: escrowContract_3, secretKey: secretKey_3 } =
      await deployEscrow(wallet, node, deployer, linearVestingEscrowContract);

    const escrows = [
      { contract: escrowContract_1, secretKey: secretKey_1 },
      { contract: escrowContract_2, secretKey: secretKey_2 },
      { contract: escrowContract_3, secretKey: secretKey_3 },
    ];

    // Deploy a token contract and fund the escrows
    const tokenContract = (await deployTokenWithMinter(
      wallet,
      deployer,
    )) as TokenContract;
    await tokenContract
      .withWallet(wallet)
      .methods.mint_to_private(escrowContract_1.address, AMOUNT)
      .send({ from: deployer });
    await tokenContract
      .withWallet(wallet)
      .methods.mint_to_private(escrowContract_2.address, AMOUNT)
      .send({ from: deployer });
    await tokenContract
      .withWallet(wallet)
      .methods.mint_to_private(escrowContract_3.address, AMOUNT)
      .send({ from: deployer });

    const currentBlockNumber = await node.getBlockNumber();
    const currentBlock = await node.getBlock(currentBlockNumber);
    const currentTimestamp = currentBlock!.header.globalVariables.timestamp;

    // Second escrow: Stop vesting and clawback (withdraw to recipient)
    const [alice, bob] = accounts;

    // Set the start timestamp equal to the start 1 slot before it is stopped
    const start_2 = currentTimestamp + AZTEC_SLOT_TIME * 6n;
    // We choose a 30 slots duration be able to clawback the remaining amount
    const duration_2 = AZTEC_SLOT_TIME * 30n;
    // Stop timestamp (1 slot after starting)
    const stopTimestamp_2 = start_2 + AZTEC_SLOT_TIME * 5n;
    // Setup the second escrow
    await linearVestingEscrowContract
      .withWallet(wallet)
      .methods.setup_linear_vesting_escrow(
        bob,
        alice,
        tokenContract.address,
        start_2,
        duration_2,
        AMOUNT,
        escrows[1].secretKey,
      )
      .send({ from: alice, additionalScopes: [escrows[1].contract.address] });

    // Get the releasable amount of the second escrow
    const {
      result: [, vestedAmount_2],
    } = await linearVestingEscrowContract
      .withWallet(wallet)
      .methods.releasable_and_vested_amounts(
        escrows[1].contract.address,
        stopTimestamp_2,
      )
      .simulate({
        from: alice,
        additionalScopes: [escrows[1].contract.address],
      });

    const clawbackAmount_2 = AMOUNT - vestedAmount_2;

    // Set the start timestamp equal to one previous to the stop
    const start_3 = currentTimestamp + AZTEC_SLOT_TIME * 8n;
    // We choose a 4 slots duration be able to claim the remaining amount and then clawback the rest
    const duration_3 = AZTEC_SLOT_TIME * 30n;
    // Stop timestamp (1 slot after starting)
    const stopTimestamp_3 = start_3 + AZTEC_SLOT_TIME * 5n;

    // Third escrow: Create and stop vesting
    await linearVestingEscrowContract
      .withWallet(wallet)
      .methods.setup_linear_vesting_escrow(
        bob,
        alice,
        tokenContract.address,
        start_3,
        duration_3,
        AMOUNT,
        escrows[2].secretKey,
      )
      .send({ from: alice, additionalScopes: [escrows[2].contract.address] });

    // Get the releasable amount of the third escrow
    const {
      result: [releasableAmount_3, vestedAmount_3],
    } = await linearVestingEscrowContract
      .withWallet(wallet)
      .methods.releasable_and_vested_amounts(
        escrows[2].contract.address,
        stopTimestamp_3,
      )
      .simulate({
        from: alice,
        additionalScopes: [escrows[2].contract.address],
      });
    const clawbackAmount_3 = AMOUNT - vestedAmount_3;

    // Sync to get linear vesting escrow note
    await syncPXE(wallet);

    await linearVestingEscrowContract
      .withWallet(wallet)
      .methods.stop_vesting(escrows[2].contract.address, stopTimestamp_3)
      .send({ from: alice, additionalScopes: [escrows[2].contract.address] });

    // Get the start timestamp of the first escrow
    const blockNumber = await node.getBlockNumber();
    const block = await node.getBlock(blockNumber);
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
      cleanup,
      deployer,
      wallet,
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
  ): Array<
    NamedBenchmarkedInteraction | ContractFunctionInteractionCallIntent
  > {
    const {
      linearVestingEscrowContract,
      wallet,
      accounts,
      escrows,
      tokenContract,
      additionalData,
    } = context;

    const [alice, bob] = accounts;

    // The order of the methods is important because some of them depend on the previous ones and timestamps are involved.
    const methods: Array<
      NamedBenchmarkedInteraction | ContractFunctionInteractionCallIntent
    > = [
      // Setup linear vesting escrow
      {
        name: "setup_linear_vesting_escrow",
        additionalScopes: [escrows[0].contract.address],
        interaction: {
          caller: alice,
          action: linearVestingEscrowContract
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              tokenContract.address,
              additionalData.start_1,
              additionalData.duration_1,
              AMOUNT,
              escrows[0].secretKey,
            ),
        },
      },
      // Partial claim (emits released amount note)
      {
        name: "claim (partial)",
        additionalScopes: [escrows[0].contract.address],
        interaction: {
          caller: bob,
          action: linearVestingEscrowContract
            .withWallet(wallet)
            .methods.claim(escrows[0].contract.address, AMOUNT / 2n),
        },
      },
      // Claim the remaining amount (does not emit released amount note)
      {
        name: "claim (full)",
        additionalScopes: [escrows[0].contract.address],
        interaction: {
          caller: bob,
          action: linearVestingEscrowContract
            .withWallet(wallet)
            .methods.claim(escrows[0].contract.address, AMOUNT / 2n),
        },
      },
      // Stop vesting
      {
        name: "stop_vesting",
        additionalScopes: [escrows[1].contract.address],
        interaction: {
          caller: alice,
          action: linearVestingEscrowContract
            .withWallet(wallet)
            .methods.stop_vesting(
              escrows[1].contract.address,
              additionalData.stop_timestamp_2,
            ),
        },
      },
      // Clawback the second escrow
      {
        name: "clawback",
        additionalScopes: [escrows[1].contract.address],
        interaction: {
          caller: alice,
          action: linearVestingEscrowContract
            .withWallet(wallet)
            .methods.clawback(
              escrows[1].contract.address,
              additionalData.clawbackAmount_2,
            ),
        },
      },
      // Claim after stop vesting
      {
        name: "claim (final)",
        additionalScopes: [escrows[2].contract.address],
        interaction: {
          caller: bob,
          action: linearVestingEscrowContract
            .withWallet(wallet)
            .methods.claim(
              escrows[2].contract.address,
              additionalData.releasableAmount_3,
            ),
        },
      },
      // Clawback without withdrawing to recipient
      {
        name: "clawback (only to reclaimer)",
        additionalScopes: [escrows[2].contract.address],
        interaction: {
          caller: alice,
          action: linearVestingEscrowContract
            .withWallet(wallet)
            .methods.clawback(
              escrows[2].contract.address,
              additionalData.clawbackAmount_3,
            ),
        },
      },
    ];

    return methods.filter(Boolean);
  }

  /**
   * Cleans up the benchmark environment for the LinearVestingEscrowContract.
   * Cleans up the wallet and data directory.
   */
  async teardown(context: LinearVestingEscrowBenchmarkContext): Promise<void> {
    await context.cleanup();
  }
}

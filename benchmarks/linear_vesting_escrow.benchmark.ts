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

// Extend the BenchmarkContext from the new package
interface LinearVestingEscrowBenchmarkContext extends BenchmarkContext {
  pxe: PXE;
  deployer: AccountWallet;
  accounts: AccountWallet[];
  linearVestingEscrowContract: LinearVestingEscrowLogicContract;
  escrowContract: EscrowContract;
  tokenContract: TokenContract;
  secretKeys: Fr[];
  start: bigint;
  duration: bigint;
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
    const deployedLinearVestingEscrow = await deployLinearVestingEscrow(
      deployer,
      escrowClassId,
    );
    const linearVestingEscrowContract =
      await LinearVestingEscrowLogicContract.at(
        deployedLinearVestingEscrow.address,
        deployer,
      );

    const escrowSk = Fr.ONE;
    const escrowKeys = await deriveKeys(escrowSk);
    const escrowSalt = new Fr(linearVestingEscrowContract.address.toBigInt());
    const escrowContract = (await deployEscrowWithPublicKeysAndSalt(
      escrowKeys.publicKeys,
      deployer,
      escrowSalt,
    )) as EscrowContract;
    const partialAddressEscrow = await escrowContract.partialAddress;
    await pxe.registerAccount(escrowSk, partialAddressEscrow);

    const tokenContract = (await deployTokenWithMinter(
      deployer,
      {},
    )) as TokenContract;
    await tokenContract
      .withWallet(deployer)
      .methods.mint_to_private(
        escrowContract.address,
        escrowContract.address,
        AMOUNT,
      )
      .send()
      .wait();

    const secretKeys = [
      grumpkinScalarToFr(escrowKeys.masterNullifierSecretKey),
      grumpkinScalarToFr(escrowKeys.masterIncomingViewingSecretKey),
      grumpkinScalarToFr(escrowKeys.masterOutgoingViewingSecretKey),
      grumpkinScalarToFr(escrowKeys.masterTaggingSecretKey),
    ];

    const blockNumber = await pxe.getBlockNumber();
    const block = await pxe.getBlock(blockNumber);
    const start = block!.header.globalVariables.timestamp;
    const AZTEC_SLOT_TIME = 36n;
    // We set the duration so that the first claim is one AZTEC_SLOT_TIME after the start, hence partially claimable
    // The second claim is fully claimable because is exactly two AZTEC_SLOT_TIME after the start, it claims the remaining amount
    const duration = AZTEC_SLOT_TIME * 2n;

    return {
      pxe,
      deployer,
      accounts,
      linearVestingEscrowContract,
      escrowContract,
      tokenContract,
      secretKeys,
      start,
      duration,
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
      escrowContract,
      tokenContract,
      secretKeys,
      start,
      duration,
    } = context;

    const [alice, bob] = accounts;

    const methods: Array<
      NamedBenchmarkedInteraction | ContractFunctionInteraction
    > = [
      // Setup linear vesting escrow
      linearVestingEscrowContract
        .withWallet(alice)
        .methods.setup_linear_vesting_escrow(
          escrowContract.address,
          bob.getAddress(),
          alice.getAddress(),
          tokenContract.address,
          start,
          duration,
          AMOUNT,
          secretKeys[0],
          secretKeys[1],
          secretKeys[2],
          secretKeys[3],
        ),
      // Partial claim (emits released amount note)
      {
        interaction: linearVestingEscrowContract
          .withWallet(bob)
          .methods.claim(escrowContract.address, AMOUNT / 2n),
        name: "(partial) claim",
      },
      // Claim the remaining amount (does not emit released amount note)
      {
        interaction: linearVestingEscrowContract
          .withWallet(bob)
          .methods.claim(escrowContract.address, AMOUNT / 2n),
        name: "(full) claim",
      },
    ];

    return methods.filter(Boolean);
  }
}

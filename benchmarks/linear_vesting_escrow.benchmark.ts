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
export default class TokenContractBenchmark extends Benchmark {
  /**
   * Sets up the benchmark environment for the TokenContract.
   * Creates PXE client, gets accounts, and deploys the contract.
   */

  async setup(): Promise<LinearVestingEscrowBenchmarkContext> {
    const { pxe, store } = await setupPXE();
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

    const escrowSk = Fr.ONE.add(Fr.ONE);
    const escrowKeys = await deriveKeys(escrowSk);
    const escrowSalt = new Fr(
      linearVestingEscrowContract.instance.address.toBigInt(),
    );
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
        escrowContract.instance.address,
        escrowContract.instance.address,
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
    const duration = 1n;

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
   * Returns the list of TokenContract methods to be benchmarked.
   */
  getMethods(
    context: LinearVestingEscrowBenchmarkContext,
  ): ContractFunctionInteraction[] {
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

    const methods: ContractFunctionInteraction[] = [
      // Setup linear vesting escrow
      linearVestingEscrowContract
        .withWallet(alice)
        .methods.setup_linear_vesting_escrow(
          escrowContract.instance.address,
          bob.getAddress(),
          tokenContract.instance.address,
          start,
          duration,
          AMOUNT,
          secretKeys[0],
          secretKeys[1],
          secretKeys[2],
          secretKeys[3],
        ),
      // Full claim linear vesting escrow
      linearVestingEscrowContract
        .withWallet(bob)
        .methods.claim(escrowContract.instance.address),
    ];

    return methods.filter(Boolean);
  }
}

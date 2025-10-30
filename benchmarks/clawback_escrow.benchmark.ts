import {
  type AccountWallet,
  type ContractFunctionInteraction,
  type PXE,
  getContractClassFromArtifact,
  Fr,
} from "@aztec/aztec.js";
import { getInitialTestAccountsManagers } from "@aztec/accounts/testing";
import { deriveKeys } from "@aztec/stdlib/keys";
import { type AztecLmdbStore } from "@aztec/kv-store/lmdb";

// Import the new Benchmark base class and context
import { Benchmark, BenchmarkContext } from "@defi-wonderland/aztec-benchmark";

import {
  AMOUNT,
  deployEscrowWithPublicKeysAndSalt,
  deployClawbackEscrow,
  deployTokenWithMinter,
  deployNFTWithMinter,
  setupPXE,
  grumpkinScalarToFr,
} from "../src/ts/utils.js";
import { ClawbackEscrowLogicContract } from "../src/artifacts/ClawbackEscrowLogic.js";
import {
  EscrowContractArtifact,
  EscrowContract,
} from "../src/artifacts/Escrow.js";
import { TokenContract } from "../src/artifacts/Token.js";
import { NFTContract } from "../src/artifacts/NFT.js";

// Escrow key counter starting at 2, incremented on each deployment
let escrowKeyCounter = 2n;

async function deployEscrow(
  pxe: PXE,
  deployer: AccountWallet,
  clawbackEscrowContract: ClawbackEscrowLogicContract,
) {
  const escrowSk = new Fr(escrowKeyCounter);
  escrowKeyCounter += 1n;
  const escrowKeys = await deriveKeys(escrowSk);
  const escrowSalt = new Fr(clawbackEscrowContract.address.toBigInt());

  const escrowContract = (await deployEscrowWithPublicKeysAndSalt(
    escrowKeys.publicKeys,
    deployer,
    escrowSalt,
  )) as EscrowContract;

  const partialAddressEscrow = await escrowContract.partialAddress;
  await pxe.registerAccount(escrowSk, partialAddressEscrow);

  const secretKeys = {
    nsk_m: grumpkinScalarToFr(escrowKeys.masterNullifierSecretKey),
    ivsk_m: grumpkinScalarToFr(escrowKeys.masterIncomingViewingSecretKey),
    ovsk_m: grumpkinScalarToFr(escrowKeys.masterOutgoingViewingSecretKey),
    tsk_m: grumpkinScalarToFr(escrowKeys.masterTaggingSecretKey),
  };

  return { escrowContract, secretKeys };
}

// Extend the BenchmarkContext from the new package
interface ClawbackEscrowBenchmarkContext extends BenchmarkContext {
  pxe: PXE;
  store: AztecLmdbStore;
  deployer: AccountWallet;
  accounts: AccountWallet[];
  clawbackEscrowContract: ClawbackEscrowLogicContract;
  escrows: {
    contract: EscrowContract;
    secretKeys: { nsk_m: Fr; ivsk_m: Fr; ovsk_m: Fr; tsk_m: Fr };
  }[];
  tokenContract: TokenContract;
  nftContract: NFTContract;
  timestamp: bigint;
}

// Use export default class extending Benchmark
export default class ClawbackEscrowContractBenchmark extends Benchmark {
  /**
   * Sets up the benchmark environment for the ClawbackEscrowLogic.
   * Creates PXE client, gets accounts, and deploys the contract.
   */

  async setup(): Promise<ClawbackEscrowBenchmarkContext> {
    const { pxe, store } = await setupPXE("bench-clawback");
    const managers = await getInitialTestAccountsManagers(pxe);
    const accounts = await Promise.all(managers.map((acc) => acc.register()));
    const [deployer] = accounts;

    const escrowClassId = (
      await getContractClassFromArtifact(EscrowContractArtifact)
    ).id;
    const clawbackEscrowContract = await deployClawbackEscrow(
      deployer,
      escrowClassId,
    );

    const { escrowContract: escrowContract_1, secretKeys: secretKeys_1 } =
      await deployEscrow(pxe, deployer, clawbackEscrowContract);
    const { escrowContract: escrowContract_2, secretKeys: secretKeys_2 } =
      await deployEscrow(pxe, deployer, clawbackEscrowContract);

    const escrows = [
      { contract: escrowContract_1, secretKeys: secretKeys_1 },
      { contract: escrowContract_2, secretKeys: secretKeys_2 },
    ];

    // Deploy a token contract
    const tokenContract = (await deployTokenWithMinter(
      deployer,
    )) as TokenContract;
    await tokenContract
      .withWallet(deployer)
      .methods.mint_to_private(escrows[0].contract.address, AMOUNT)
      .send({ from: deployer.getAddress() })
      .wait();
    await tokenContract
      .withWallet(deployer)
      .methods.mint_to_private(escrows[1].contract.address, AMOUNT)
      .send({ from: deployer.getAddress() })
      .wait();

    // Deploy a nft contract
    const nftContract = (await deployNFTWithMinter(deployer)) as NFTContract;
    await nftContract
      .withWallet(deployer)
      .methods.mint_to_private(escrows[0].contract.address, 1) // token ID: 1
      .send({ from: deployer.getAddress() })
      .wait();
    await nftContract
      .withWallet(deployer)
      .methods.mint_to_private(escrows[1].contract.address, 2) // token ID: 2
      .send({ from: deployer.getAddress() })
      .wait();

    const blockNumber = await pxe.getBlockNumber();
    const block = await pxe.getBlock(blockNumber);
    const timestamp = block!.header.globalVariables.timestamp;
    const pastDeadline = timestamp;

    const [alice, bob] = accounts;
    await clawbackEscrowContract
      .withWallet(deployer)
      .methods.setup_clawback_escrow(
        escrows[0].contract.address,
        bob.getAddress(),
        alice.getAddress(),
        pastDeadline,
        escrows[0].secretKeys,
      )
      .send({ from: deployer.getAddress() })
      .wait();

    return {
      pxe,
      store,
      deployer,
      accounts,
      clawbackEscrowContract,
      escrows,
      tokenContract,
      nftContract,
      timestamp,
    };
  }

  /**
   * Returns the list of ClawbackEscrowLogic methods to be benchmarked.
   */
  getMethods(
    context: ClawbackEscrowBenchmarkContext,
  ): ContractFunctionInteraction[] {
    const {
      clawbackEscrowContract,
      accounts,
      escrows,
      tokenContract,
      nftContract,
      timestamp,
    } = context;

    const [alice, bob] = accounts;
    const futureDeadline = timestamp + 10000n;

    const methods: ContractFunctionInteraction[] = [
      // Setup clawback escrow
      clawbackEscrowContract
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrows[1].contract.address,
          bob.getAddress(),
          alice.getAddress(),
          futureDeadline,
          escrows[1].secretKeys,
        ),
      // Full token claim escrow
      clawbackEscrowContract
        .withWallet(bob)
        .methods.claim(
          escrows[1].contract.address,
          tokenContract.address,
          AMOUNT,
        ),
      // NFT claim escrow
      clawbackEscrowContract
        .withWallet(bob)
        .methods.claim_nft(escrows[1].contract.address, nftContract.address, 2),
      // Full token clawback escrow
      clawbackEscrowContract
        .withWallet(alice)
        .methods.clawback(
          escrows[0].contract.address,
          tokenContract.address,
          AMOUNT,
        ),
      // NFT clawback escrow
      clawbackEscrowContract
        .withWallet(alice)
        .methods.clawback_nft(
          escrows[0].contract.address,
          nftContract.address,
          1,
        ),
    ];

    return methods.filter(Boolean);
  }

  /**
   * Cleans up the benchmark environment for the LinearVestingEscrowContract.
   * Deletes the store.
   */
  async teardown(context: ClawbackEscrowBenchmarkContext): Promise<void> {
    await context.store.delete();
  }
}

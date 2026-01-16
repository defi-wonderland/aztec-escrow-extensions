import { Fr } from "@aztec/aztec.js/fields";
import { deriveKeys } from "@aztec/stdlib/keys";
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { AztecNode } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";
import type { ContractInstanceWithAddress } from "@aztec/aztec.js/contracts";
import type { ContractFunctionInteractionCallIntent } from "@aztec/aztec.js/authorization";

// Import the new Benchmark base class and context
import { Benchmark, BenchmarkContext } from "@defi-wonderland/aztec-benchmark";
import type { NamedBenchmarkedInteraction } from "@defi-wonderland/aztec-benchmark/dist/types.js";

import {
  AMOUNT,
  deployEscrowWithPublicKeysAndSalt,
  deployClawbackEscrow,
  deployTokenWithMinter,
  deployNFTWithMinter,
  setupTestSuite,
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
  wallet: Wallet,
  node: AztecNode,
  deployer: AztecAddress,
  clawbackEscrowContract: ClawbackEscrowLogicContract,
) {
  const escrowSk = new Fr(escrowKeyCounter);
  escrowKeyCounter += 1n;
  const escrowKeys = await deriveKeys(escrowSk);
  const escrowSalt = new Fr(clawbackEscrowContract.address.toBigInt());

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
  store: AztecLMDBStoreV2;
  deployer: AztecAddress;
  wallet: Wallet;
  accounts: AztecAddress[];
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
   * Gets accounts, and deploys the contract.
   */

  async setup(): Promise<ClawbackEscrowBenchmarkContext> {
    const { store, node, wallet, accounts } =
      await setupTestSuite("bench-clawback");
    const [deployer] = accounts;

    const escrowClassId = (
      await getContractClassFromArtifact(EscrowContractArtifact)
    ).id;
    const clawbackEscrowContract = await deployClawbackEscrow(
      wallet,
      deployer,
      escrowClassId,
    );

    const { escrowContract: escrowContract_1, secretKeys: secretKeys_1 } =
      await deployEscrow(wallet, node, deployer, clawbackEscrowContract);
    const { escrowContract: escrowContract_2, secretKeys: secretKeys_2 } =
      await deployEscrow(wallet, node, deployer, clawbackEscrowContract);

    const escrows = [
      { contract: escrowContract_1, secretKeys: secretKeys_1 },
      { contract: escrowContract_2, secretKeys: secretKeys_2 },
    ];

    // Deploy a token contract
    const tokenContract = (await deployTokenWithMinter(
      wallet,
      deployer,
    )) as TokenContract;
    await tokenContract
      .withWallet(wallet)
      .methods.mint_to_private(escrows[0].contract.address, AMOUNT)
      .send({ from: deployer })
      .wait();
    await tokenContract
      .withWallet(wallet)
      .methods.mint_to_private(escrows[1].contract.address, AMOUNT)
      .send({ from: deployer })
      .wait();

    // Deploy a nft contract
    const nftContract = (await deployNFTWithMinter(
      wallet,
      deployer,
    )) as NFTContract;
    await nftContract
      .withWallet(wallet)
      .methods.mint_to_private(escrows[0].contract.address, 1) // token ID: 1
      .send({ from: deployer })
      .wait();
    await nftContract
      .withWallet(wallet)
      .methods.mint_to_private(escrows[1].contract.address, 2) // token ID: 2
      .send({ from: deployer })
      .wait();

    const blockNumber = await node.getBlockNumber();
    const block = await node.getBlock(blockNumber);
    const timestamp = block!.header.globalVariables.timestamp;
    const pastDeadline = timestamp;

    const [alice, bob] = accounts;
    await clawbackEscrowContract
      .withWallet(wallet)
      .methods.setup_clawback_escrow(
        bob,
        alice,
        pastDeadline,
        escrows[0].secretKeys,
      )
      .send({ from: deployer })
      .wait();

    return {
      store,
      wallet,
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
  ): Array<
    NamedBenchmarkedInteraction | ContractFunctionInteractionCallIntent
  > {
    const {
      clawbackEscrowContract,
      wallet,
      accounts,
      escrows,
      tokenContract,
      nftContract,
      timestamp,
    } = context;

    const [alice, bob] = accounts;
    const futureDeadline = timestamp + 10000n;

    const methods: Array<
      NamedBenchmarkedInteraction | ContractFunctionInteractionCallIntent
    > = [
      // Setup clawback escrow
      {
        name: "setup_clawback_escrow",
        interaction: {
          caller: alice,
          action: clawbackEscrowContract
            .withWallet(wallet)
            .methods.setup_clawback_escrow(
              bob,
              alice,
              futureDeadline,
              escrows[1].secretKeys,
            ),
        },
      },
      // Full token claim escrow
      {
        name: "claim",
        interaction: {
          caller: bob,
          action: clawbackEscrowContract
            .withWallet(wallet)
            .methods.claim(
              escrows[1].contract.address,
              tokenContract.address,
              AMOUNT,
            ),
        },
      },
      // NFT claim escrow
      {
        name: "claim_nft",
        interaction: {
          caller: bob,
          action: clawbackEscrowContract
            .withWallet(wallet)
            .methods.claim_nft(
              escrows[1].contract.address,
              nftContract.address,
              2,
            ),
        },
      },
      // Full token clawback escrow
      {
        name: "clawback",
        interaction: {
          caller: alice,
          action: clawbackEscrowContract
            .withWallet(wallet)
            .methods.clawback(
              escrows[0].contract.address,
              tokenContract.address,
              AMOUNT,
            ),
        },
      },
      // NFT clawback escrow
      {
        name: "clawback_nft",
        interaction: {
          caller: alice,
          action: clawbackEscrowContract
            .withWallet(wallet)
            .methods.clawback_nft(
              escrows[0].contract.address,
              nftContract.address,
              1,
            ),
        },
      },
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

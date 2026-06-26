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

import {
  AMOUNT,
  deployEscrowWithPublicKeysAndSalt,
  deployClawbackEscrow,
  deployTokenWithMinter,
  deployNFTWithMinter,
  setupTestSuite,
} from "../src/ts/utils.js";
import { ClawbackEscrowLogicContract } from "../src/artifacts/ClawbackEscrowLogic.js";
import {
  EscrowContractArtifact,
  EscrowContract,
} from "@defi-wonderland/aztec-standards/dist/src/artifacts/Escrow.js";
import { TokenContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";
import { NFTContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/NFT.js";

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

  const secretKey = escrowSk;

  return { escrowContract, secretKey };
}

// Extend the BenchmarkContext from the new package
interface ClawbackEscrowBenchmarkContext extends BenchmarkContext {
  cleanup: () => Promise<void>;
  deployer: AztecAddress;
  wallet: EmbeddedWallet;
  accounts: AztecAddress[];
  clawbackEscrowContract: ClawbackEscrowLogicContract;
  escrows: {
    contract: EscrowContract;
    secretKey: Fr;
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
    const { node, wallet, accounts, cleanup } = await setupTestSuite(
      "bench-clawback",
      true,
    );
    const [deployer] = accounts;

    const escrowClassId = (
      await getContractClassFromArtifact(EscrowContractArtifact)
    ).id;
    const clawbackEscrowContract = await deployClawbackEscrow(
      wallet,
      deployer,
      escrowClassId,
    );

    const { escrowContract: escrowContract_1, secretKey: secretKey_1 } =
      await deployEscrow(wallet, node, deployer, clawbackEscrowContract);
    const { escrowContract: escrowContract_2, secretKey: secretKey_2 } =
      await deployEscrow(wallet, node, deployer, clawbackEscrowContract);

    const escrows = [
      { contract: escrowContract_1, secretKey: secretKey_1 },
      { contract: escrowContract_2, secretKey: secretKey_2 },
    ];

    // Deploy a token contract
    const tokenContract = (await deployTokenWithMinter(
      wallet,
      deployer,
    )) as TokenContract;
    await tokenContract
      .withWallet(wallet)
      .methods.mint_to_private(escrows[0].contract.address, AMOUNT)
      .send({ from: deployer });
    await tokenContract
      .withWallet(wallet)
      .methods.mint_to_private(escrows[1].contract.address, AMOUNT)
      .send({ from: deployer });

    // Deploy a nft contract
    const nftContract = (await deployNFTWithMinter(
      wallet,
      deployer,
    )) as NFTContract;
    await nftContract
      .withWallet(wallet)
      .methods.mint_to_private(escrows[0].contract.address, 1) // token ID: 1
      .send({ from: deployer });
    await nftContract
      .withWallet(wallet)
      .methods.mint_to_private(escrows[1].contract.address, 2) // token ID: 2
      .send({ from: deployer });

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
        escrows[0].secretKey,
      )
      .send({
        from: deployer,
        additionalScopes: [escrows[0].contract.address],
      });

    return {
      cleanup,
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
        additionalScopes: [escrows[1].contract.address],
        interaction: {
          caller: alice,
          action: clawbackEscrowContract
            .withWallet(wallet)
            .methods.setup_clawback_escrow(
              bob,
              alice,
              futureDeadline,
              escrows[1].secretKey,
            ),
        },
      },
      // Full token claim escrow
      {
        name: "claim",
        additionalScopes: [escrows[1].contract.address],
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
        additionalScopes: [escrows[1].contract.address],
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
        additionalScopes: [escrows[0].contract.address],
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
        additionalScopes: [escrows[0].contract.address],
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
   * Cleans up the benchmark environment for the ClawbackEscrowContract.
   * Cleans up the wallet and data directory.
   */
  async teardown(context: ClawbackEscrowBenchmarkContext): Promise<void> {
    await context.cleanup();
  }
}

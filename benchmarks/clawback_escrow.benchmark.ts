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

// Extend the BenchmarkContext from the new package
interface EscrowEscrowBenchmarkContext extends BenchmarkContext {
  pxe: PXE;
  deployer: AccountWallet;
  accounts: AccountWallet[];
  clawbackEscrowContract: ClawbackEscrowLogicContract;
  escrowContract: EscrowContract;
  tokenContract: TokenContract;
  nftContract: NFTContract;
  secretKeys: Fr[];
  deadline: bigint;
}

// Use export default class extending Benchmark
export default class TokenContractBenchmark extends Benchmark {
  /**
   * Sets up the benchmark environment for the TokenContract.
   * Creates PXE client, gets accounts, and deploys the contract.
   */

  async setup(): Promise<EscrowEscrowBenchmarkContext> {
    const { pxe, store } = await setupPXE();
    const managers = await getInitialTestAccountsManagers(pxe);
    const accounts = await Promise.all(managers.map((acc) => acc.register()));
    const [deployer] = accounts;

    const escrowClassId = (
      await getContractClassFromArtifact(EscrowContractArtifact)
    ).id;
    const deployedEscrowEscrow = await deployClawbackEscrow(
      deployer,
      escrowClassId,
    );
    const clawbackEscrowContract = await ClawbackEscrowLogicContract.at(
      deployedEscrowEscrow.address,
      deployer,
    );

    const escrowSk = Fr.ONE.add(Fr.ONE);
    const escrowKeys = await deriveKeys(escrowSk);
    const escrowSalt = new Fr(clawbackEscrowContract.address.toBigInt());
    const escrowContract = (await deployEscrowWithPublicKeysAndSalt(
      escrowKeys.publicKeys,
      deployer,
      escrowSalt,
    )) as EscrowContract;
    const partialAddressEscrow = await escrowContract.partialAddress;
    await pxe.registerAccount(escrowSk, partialAddressEscrow);

    // Deploy a token contract
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

    // Deploy a nft contract
    const nftContract = (await deployNFTWithMinter(
      deployer,
      {},
    )) as NFTContract;
    await nftContract
      .withWallet(deployer)
      .methods.mint_to_private(escrowContract.address, 1) // token ID: 1
      .send()
      .wait();
    await nftContract
      .withWallet(deployer)
      .methods.mint_to_private(escrowContract.address, 2) // token ID: 2
      .send()
      .wait();

    const secretKeys = [
      grumpkinScalarToFr(escrowKeys.masterNullifierSecretKey),
      grumpkinScalarToFr(escrowKeys.masterIncomingViewingSecretKey),
      grumpkinScalarToFr(escrowKeys.masterOutgoingViewingSecretKey),
      grumpkinScalarToFr(escrowKeys.masterTaggingSecretKey),
    ];

    const AZTEC_SLOT_TIME = 36n; // seconds
    const blockNumber = await pxe.getBlockNumber();
    const block = await pxe.getBlock(blockNumber);
    // Accept 3 tx (creation, claim and claim_nft) before deadline
    const deadline =
      block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 4n - 1n;

    return {
      pxe,
      deployer,
      accounts,
      clawbackEscrowContract,
      escrowContract,
      tokenContract,
      nftContract,
      secretKeys,
      deadline,
    };
  }

  /**
   * Returns the list of ClawbackEscrowLogic methods to be benchmarked.
   */
  getMethods(
    context: EscrowEscrowBenchmarkContext,
  ): ContractFunctionInteraction[] {
    const {
      clawbackEscrowContract,
      accounts,
      escrowContract,
      tokenContract,
      nftContract,
      secretKeys,
      deadline,
    } = context;

    const [alice, bob] = accounts;
    const halfAmount = AMOUNT / 2n;

    const methods: ContractFunctionInteraction[] = [
      // Setup clawback escrow
      clawbackEscrowContract
        .withWallet(alice)
        .methods.create_clawback_escrow(
          escrowContract.address,
          bob.getAddress(),
          alice.getAddress(),
          deadline,
          secretKeys[0],
          secretKeys[1],
          secretKeys[2],
          secretKeys[3],
        ),
      // Partial token claim escrow
      clawbackEscrowContract
        .withWallet(bob)
        .methods.claim(
          escrowContract.address,
          tokenContract.address,
          halfAmount,
        ),
      // NFT claim escrow
      clawbackEscrowContract
        .withWallet(bob)
        .methods.claim_nft(escrowContract.address, nftContract.address, 1),
      // Full token clawback escrow
      clawbackEscrowContract
        .withWallet(alice)
        .methods.clawback(
          escrowContract.address,
          tokenContract.address,
          halfAmount,
        ),
      // NFT clawback escrow
      clawbackEscrowContract
        .withWallet(alice)
        .methods.clawback_nft(escrowContract.address, nftContract.address, 2),
    ];

    return methods.filter(Boolean);
  }
}

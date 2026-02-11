import { siloNullifier } from "@aztec/stdlib/hash";
import { FieldsOf } from "@aztec/foundation/types";
import { type AztecNode } from "@aztec/aztec.js/node";
import { TestWallet } from "@aztec/test-wallet/server";
import { pedersenHash } from "@aztec/foundation/crypto/pedersen";
import { TxStatus, TxReceipt } from "@aztec/aztec.js/tx";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { deriveKeys, PublicKeys } from "@aztec/stdlib/keys";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { Fr, type GrumpkinScalar } from "@aztec/aztec.js/fields";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";
import { type ContractInstanceWithAddress } from "@aztec/aztec.js/contracts";

import {
  setupTestSuite,
  deployTokenWithMinter,
  AMOUNT,
  expectTokenBalances,
  wad,
  deployNFTWithMinter,
  deployClawbackEscrow,
  deployEscrowWithPublicKeysAndSalt,
  grumpkinScalarToFr,
  assertOwnsPrivateNFT,
} from "./utils.js";

import {
  ClawbackEscrowLogicContract,
  EscrowDetailsLogContent,
} from "../artifacts/ClawbackEscrowLogic.js";
import { EscrowContractArtifact, EscrowContract } from "../artifacts/Escrow.js";
import { TokenContract } from "../artifacts/Token.js";
import { NFTContract } from "../artifacts/NFT.js";

describe("Clawback Escrow", () => {
  const AZTEC_SLOT_TIME = 36n; // seconds

  let node: AztecNode;
  let store: AztecLMDBStoreV2;

  let wallet: TestWallet;
  let accounts: AztecAddress[];
  let alice: AztecAddress;
  let bob: AztecAddress;
  let carl: AztecAddress;

  // Linear vesting contract
  let clawbackEscrow: ClawbackEscrowLogicContract;

  // Escrow contract
  let escrow: EscrowContract;
  let escrowSk: Fr;
  let escrowKeys: {
    masterNullifierHidingKey: GrumpkinScalar;
    masterIncomingViewingSecretKey: GrumpkinScalar;
    masterOutgoingViewingSecretKey: GrumpkinScalar;
    masterTaggingSecretKey: GrumpkinScalar;
    publicKeys: PublicKeys;
  };
  let escrowSalt: Fr;
  let escrowClassId: Fr;
  let secretKeys: {
    nsk_m: Fr;
    ivsk_m: Fr;
    ovsk_m: Fr;
    tsk_m: Fr;
  };

  // Token contract
  let token: TokenContract;
  // NFT contract
  let nft: NFTContract;

  let deadline: bigint;

  beforeEach(async () => {
    // Setup test suite
    ({ store, node, wallet, accounts } =
      await setupTestSuite("clawback-escrow"));

    [alice, bob, carl] = accounts;

    // Get the class id of the escrow contract
    escrowClassId = (await getContractClassFromArtifact(EscrowContractArtifact))
      .id;

    // We default to a secret key of 1 for testing purposes
    escrowSk = Fr.ONE.add(Fr.ONE);

    // Derive the keys from the secret key
    escrowKeys = await deriveKeys(escrowSk);

    // Convert the keys to Fr
    secretKeys = {
      nsk_m: grumpkinScalarToFr(escrowKeys.masterNullifierHidingKey),
      ivsk_m: grumpkinScalarToFr(escrowKeys.masterIncomingViewingSecretKey),
      ovsk_m: grumpkinScalarToFr(escrowKeys.masterOutgoingViewingSecretKey),
      tsk_m: grumpkinScalarToFr(escrowKeys.masterTaggingSecretKey),
    };

    // Deploy clawback escrow logic contract
    clawbackEscrow = await deployClawbackEscrow(wallet, alice, escrowClassId);

    // Use the logic contract address as the salt for the escrow contract
    escrowSalt = new Fr(clawbackEscrow.address.toBigInt());

    // Deploy an escrow contract
    escrow = (await deployEscrowWithPublicKeysAndSalt(
      escrowKeys.publicKeys,
      wallet,
      alice,
      escrowSalt,
    )) as EscrowContract;

    // Register the escrow contract
    const escrowInstance = (await node.getContract(
      escrow.address,
    )) as ContractInstanceWithAddress;
    if (escrowInstance) {
      await wallet.registerContract(
        escrowInstance,
        EscrowContractArtifact,
        escrowSk,
      );
    }

    const blockNumber = await node.getBlockNumber();
    const block = await node.getBlock(blockNumber);
    deadline = block!.header.globalVariables.timestamp + 1000n;
  });

  afterEach(async () => {
    await store.delete();
  });

  describe("setup_clawback_escrow", () => {
    describe("correct escrow setup", () => {
      let setup_tx: FieldsOf<TxReceipt>;

      beforeEach(async () => {
        setup_tx = await clawbackEscrow
          .withWallet(wallet)
          .methods.setup_clawback_escrow(bob, alice, deadline, secretKeys)
          .send({ from: alice });
      });

      it("creates clawback escrow shares escrow with bob correctly", async () => {
        const blockNumber = setup_tx.blockNumber!;

        const events = await wallet.getPrivateEvents<EscrowDetailsLogContent>(
          ClawbackEscrowLogicContract.events.EscrowDetailsLogContent,
          {
            contractAddress: clawbackEscrow.address,
            fromBlock: blockNumber,
            scopes: [bob],
          },
        );

        expect(events.length).toBe(1);

        const event = events[0].event;

        expect(event.escrow).toEqual(escrow.address);
        expect(event.master_secret_keys.nsk_m).toEqual(
          escrowKeys.masterNullifierHidingKey.toBigInt(),
        );
        expect(event.master_secret_keys.ivsk_m).toEqual(
          escrowKeys.masterIncomingViewingSecretKey.toBigInt(),
        );
        expect(event.master_secret_keys.ovsk_m).toEqual(
          escrowKeys.masterOutgoingViewingSecretKey.toBigInt(),
        );
        expect(event.master_secret_keys.tsk_m).toEqual(
          escrowKeys.masterTaggingSecretKey.toBigInt(),
        );
      });

      it("creates clawback escrow shares escrow with alice correctly", async () => {
        const blockNumber = setup_tx.blockNumber!;

        const events = await wallet.getPrivateEvents<EscrowDetailsLogContent>(
          ClawbackEscrowLogicContract.events.EscrowDetailsLogContent,
          {
            contractAddress: clawbackEscrow.address,
            fromBlock: blockNumber,
            scopes: [bob],
          },
        );

        expect(events.length).toBe(1);

        const event = events[0].event;

        expect(event.escrow).toEqual(escrow.address);
        expect(event.master_secret_keys.nsk_m).toEqual(
          escrowKeys.masterNullifierHidingKey.toBigInt(),
        );
        expect(event.master_secret_keys.ivsk_m).toEqual(
          escrowKeys.masterIncomingViewingSecretKey.toBigInt(),
        );
        expect(event.master_secret_keys.ovsk_m).toEqual(
          escrowKeys.masterOutgoingViewingSecretKey.toBigInt(),
        );
        expect(event.master_secret_keys.tsk_m).toEqual(
          escrowKeys.masterTaggingSecretKey.toBigInt(),
        );
      });

      it("creates clawback escrow should create a correct ClawbackEscrow note", async () => {
        const blockNumber = setup_tx.blockNumber!;

        // Verify escrow details via private events (v4 pattern)
        const events = await wallet.getPrivateEvents<EscrowDetailsLogContent>(
          ClawbackEscrowLogicContract.events.EscrowDetailsLogContent,
          {
            contractAddress: clawbackEscrow.address,
            fromBlock: blockNumber,
            scopes: [bob],
          },
        );

        expect(events.length).toBe(1);
        const event = events[0].event;
        expect(event.escrow).toEqual(escrow.address);
      });

      it("creates clawback escrow should emit a nullifier for the escrow", async () => {
        const nullifier = await pedersenHash([escrow.address]);
        const siloedNullifier = await siloNullifier(
          clawbackEscrow.address,
          nullifier,
        );

        const txReceipt = await node.getTxReceipt(setup_tx.txHash);
        expect(txReceipt.status).toBe("checkpointed");

        const txEffect = await node.getTxEffect(setup_tx.txHash);
        let nullifierExists = false;
        if (txEffect) {
          const nullifiers = txEffect.data.nullifiers;
          nullifierExists = nullifiers.some((n) => n.equals(siloedNullifier));
        }

        expect(nullifierExists).toBe(true);
      });

      it("creates clawback escrow should nullify and not allow to create another one", async () => {
        // Try to create a clawback escrow for carl
        await expect(
          clawbackEscrow.methods
            .setup_clawback_escrow(bob, alice, deadline, secretKeys)
            .send({ from: alice }),
        ).rejects.toThrow(/Invalid tx: Existing nullifier/);
      });
    });
  });

  describe("claim", () => {
    beforeEach(async () => {
      // Deploy a token contract
      token = (await deployTokenWithMinter(wallet, alice)) as TokenContract;

      await token
        .withWallet(wallet)
        .methods.mint_to_private(escrow.address, AMOUNT)
        .send({ from: alice });
    });

    it("claim should transfer the tokens to the recipient and emit one note (token note)", async () => {
      // Create escrow with a deadline in the future (generous margin to account for slot timing variability)
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 5n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, exactDeadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

      // Bob claims the full amount
      await clawbackEscrow
        .withWallet(wallet)
        .methods.claim(escrow.address, token.address, AMOUNT)
        .send({ from: bob });
      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob, wad(0), AMOUNT);
      await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
    });

    it("claim two times in a row should be successful", async () => {
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, deadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

      const halfAmount = AMOUNT / 2n;
      // Bob claims the full amount
      await clawbackEscrow
        .withWallet(wallet)
        .methods.claim(escrow.address, token.address, halfAmount)
        .send({ from: bob });
      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob, wad(0), halfAmount);
      await expectTokenBalances(token, escrow.address, wad(0), halfAmount, bob);

      // Bob claims the full amount
      await clawbackEscrow
        .withWallet(wallet)
        .methods.claim(escrow.address, token.address, halfAmount)
        .send({ from: bob });
      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob, wad(0), AMOUNT);
      await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
    });

    it("claim after deadline should fail", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which claim() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;

      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

      // Bob tries to claim the full amount after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, token.address, AMOUNT)
          .send({ from: bob }),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("claim_nft", () => {
    const tokenId = 1n;

    beforeEach(async () => {
      // Deploy a nft contract
      nft = (await deployNFTWithMinter(wallet, alice)) as NFTContract;
      await nft
        .withWallet(wallet)
        .methods.mint_to_private(escrow.address, tokenId)
        .send({ from: alice });
    });

    it("claim_nft should transfer the NFT to the recipient and emit one note (nft note)", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      // The deadline is calculated as the exact timestamp of the block in which claim() will happen
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, exactDeadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address, true, bob);

      // Bob claims the NFT
      await clawbackEscrow
        .withWallet(wallet)
        .methods.claim_nft(escrow.address, nft.address, tokenId)
        .send({ from: bob });
      // Assert that NFT were effectively transferred
      await assertOwnsPrivateNFT(nft, tokenId, bob, true);
    });

    it("claim_nft after deadline should fail", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which claim() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;

      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address, true, bob);

      // Bob tries to claim the NFT after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.claim_nft(escrow.address, nft.address, tokenId)
          .send({ from: bob }),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("clawback", () => {
    beforeEach(async () => {
      // Deploy a token contract
      token = (await deployTokenWithMinter(wallet, alice)) as TokenContract;

      await token
        .withWallet(wallet)
        .methods.mint_to_private(escrow.address, AMOUNT)
        .send({ from: alice });
    });

    it("clawback should transfer the tokens to the recipient and emit one note (token note)", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which clawback() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await expectTokenBalances(token, alice, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, alice);

      // Alice clawbacks the full amount
      await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback(escrow.address, token.address, AMOUNT)
        .send({ from: alice });
      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, alice, wad(0), AMOUNT);
      await expectTokenBalances(token, escrow.address, wad(0), wad(0), alice);
    });

    it("clawback two times in a row should be successful", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which clawback() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await expectTokenBalances(token, alice, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, alice);

      const halfAmount = AMOUNT / 2n;
      // Alice clawbacks a partial amount
      await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback(escrow.address, token.address, halfAmount)
        .send({ from: alice });
      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, alice, wad(0), halfAmount);
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        halfAmount,
        alice,
      );

      // Alice clawbacks the full amount
      await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback(escrow.address, token.address, halfAmount)
        .send({ from: alice });
      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, alice, wad(0), AMOUNT);
      await expectTokenBalances(token, escrow.address, wad(0), wad(0), alice);
    });

    it("clawback before deadline should fail", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      // The deadline is calculated as the exact timestamp of the block in which clawback() will happen
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, exactDeadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await expectTokenBalances(token, alice, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, alice);

      // Alice tries to clawback the full amount before deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, token.address, AMOUNT)
          .send({ from: alice }),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("clawback_nft", () => {
    const tokenId = 1n;

    beforeEach(async () => {
      // Deploy a nft contract
      nft = (await deployNFTWithMinter(wallet, alice)) as NFTContract;
      await nft
        .withWallet(wallet)
        .methods.mint_to_private(escrow.address, tokenId)
        .send({ from: alice });
    });

    it("clawback_nft should transfer the NFT to the recipient and emit one note (nft note)", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which claim() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address, true, bob);

      // Alice clawbacks the NFT
      await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback_nft(escrow.address, nft.address, tokenId)
        .send({ from: alice });
      // Assert that NFT were effectively transferred
      await assertOwnsPrivateNFT(nft, tokenId, alice, true);
    });

    it("clawback_nft after deadline should fail", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      // The deadline is calculated as the exact timestamp of the block in which clawback_nft() will happen
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, exactDeadline, secretKeys)
        .send({ from: alice });

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address, true, bob);

      // Alice tries to clawback the NFT after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.clawback_nft(escrow.address, nft.address, tokenId)
          .send({ from: alice }),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });
});

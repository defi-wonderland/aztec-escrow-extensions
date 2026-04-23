import { siloNullifier } from "@aztec/stdlib/hash";
import { FieldsOf } from "@aztec/foundation/types";
import { type AztecNode } from "@aztec/aztec.js/node";
import { type EmbeddedWallet } from "@aztec/wallets/embedded";
import { pedersenHash } from "@aztec/foundation/crypto/pedersen";
import { TxStatus, TxReceipt } from "@aztec/aztec.js/tx";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { deriveKeys, PublicKeys } from "@aztec/stdlib/keys";
import { Fr } from "@aztec/aztec.js/fields";
import { type Fq } from "@aztec/foundation/curves/bn254";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";
import { type ContractInstanceWithAddress } from "@aztec/aztec.js/contracts";

import {
  setupTestSuite,
  deployTokenWithMinter,
  AMOUNT,
  expectTokenBalances,
  wad,
  deployNFTWithMinter,
  expectUintNote,
  expectNFTNote,
  deployClawbackEscrow,
  deployEscrowWithPublicKeysAndSalt,
  assertOwnsPrivateNFT,
  getWalletNotes,
  syncPXE,
} from "./utils.js";

import {
  ClawbackEscrowLogicContract,
  EscrowDetailsLogContent,
} from "../artifacts/ClawbackEscrowLogic.js";
import {
  EscrowContractArtifact,
  EscrowContract,
} from "@defi-wonderland/aztec-standards/dist/src/artifacts/Escrow.js";
import { TokenContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";
import { NFTContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/NFT.js";

describe("Clawback Escrow", () => {
  const AZTEC_SLOT_TIME = 36n; // seconds

  let node: AztecNode;
  let cleanup: () => Promise<void>;

  let wallet: EmbeddedWallet;
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
    masterNullifierHidingKey: Fq;
    masterIncomingViewingSecretKey: Fq;
    masterOutgoingViewingSecretKey: Fq;
    masterTaggingSecretKey: Fq;
    publicKeys: PublicKeys;
  };
  let escrowSalt: Fr;
  let escrowClassId: Fr;
  let secretKey: Fr;

  // Token contract
  let token: TokenContract;
  // NFT contract
  let nft: NFTContract;

  let deadline: bigint;

  beforeAll(async () => {
    // Setup test suite (one PXE for all tests to avoid LMDB reader exhaustion)
    ({ node, wallet, accounts, cleanup } =
      await setupTestSuite("clawback-escrow"));

    [alice, bob, carl] = accounts;

    // Get the class id of the escrow contract
    escrowClassId = (await getContractClassFromArtifact(EscrowContractArtifact))
      .id;

    // We default to a secret key of 1 for testing purposes
    escrowSk = Fr.ONE.add(Fr.ONE);

    // Derive the keys from the secret key
    escrowKeys = await deriveKeys(escrowSk);

    // The contract now takes the secret key directly (not derived master secret keys)
    secretKey = escrowSk;
  });

  afterAll(async () => {
    await cleanup();
  });

  // Deploy fresh escrow + logic contracts before each test (each escrow can only be set up once)
  beforeEach(async () => {
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

  describe("setup_clawback_escrow", () => {
    describe("correct escrow setup", () => {
      let setup_tx: FieldsOf<TxReceipt>;

      beforeEach(async () => {
        const sendResult = await clawbackEscrow
          .withWallet(wallet)
          .methods.setup_clawback_escrow(bob, alice, deadline, secretKey)
          .send({ from: alice, additionalScopes: [escrow.address] });
        setup_tx = sendResult.receipt;
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
        expect(event.secret_key).toEqual(escrowSk.toBigInt());
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
        expect(event.secret_key).toEqual(escrowSk.toBigInt());
      });

      it("creates clawback escrow should create a correct ClawbackEscrow note", async () => {
        await syncPXE(wallet);

        const notes = (
          await getWalletNotes(wallet, {
            contractAddress: clawbackEscrow.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(setup_tx.txHash));

        // We expect 1 note
        expect(notes.length).toBe(1);

        // const slotEscrowNotes =
        //   ClawbackEscrowLogicContract.storage.escrows.slot;

        // const escrowNotes = await getWalletNotes(wallet, {
        //   txHash: setup_tx.txHash,
        //   contractAddress: clawbackEscrow.address,
        //   recipient: alice,
        //   storageSlot: slotEscrowNotes,
        // });
        // TODO: cannot find notes if recipient: bob
        // const escrowNotes = await getWalletNotes(wallet, {
        //   txHash: setup_tx.txHash,
        //   contractAddress: clawbackEscrow.address,
        //   recipient: bob,
        //   storageSlot: slotEscrowNotes,
        // });

        expect(notes[0].note.items[0].toString()).toBe(bob.toString());
        expect(notes[0].note.items[1].toString()).toBe(alice.toString());
        expect(notes[0].note.items[2].toBigInt()).toBe(BigInt(deadline));
      });

      it("creates clawback escrow should emit a nullifier for the escrow", async () => {
        const nullifier = await pedersenHash([escrow.address]);
        const siloedNullifier = await siloNullifier(
          clawbackEscrow.address,
          nullifier,
        );

        const txReceipt = await node.getTxReceipt(setup_tx.txHash);
        expect([
          TxStatus.CHECKPOINTED,
          TxStatus.PROVEN,
          TxStatus.FINALIZED,
        ]).toContain(txReceipt.status);

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
            .setup_clawback_escrow(bob, alice, deadline, secretKey)
            .send({ from: alice, additionalScopes: [escrow.address] }),
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
        .send({ from: alice, additionalScopes: [escrow.address] });
    });

    it("claim should transfer the tokens to the recipient and emit one note (token note)", async () => {
      // Create escrow with a deadline far enough in the future that claim lands before it
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 20n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, exactDeadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        AMOUNT,
        escrow.address,
      );

      // Bob claims the full amount
      const claimTxResult = await clawbackEscrow
        .withWallet(wallet)
        .methods.claim(escrow.address, token.address, AMOUNT)
        .send({ from: bob, additionalScopes: [escrow.address] });
      const claimTx = claimTxResult.receipt;
      await syncPXE(wallet);

      // Assert that bob received the note
      const notes = (
        await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(claimTx.txHash));
      expect(notes.length).toBe(1);
      expectUintNote(notes[0].note, AMOUNT, bob);

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob, wad(0), AMOUNT);
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        wad(0),
        escrow.address,
      );
    });

    it("claim two times in a row should be successful", async () => {
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, deadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        AMOUNT,
        escrow.address,
      );

      const halfAmount = AMOUNT / 2n;
      // Bob claims the full amount
      const claimTx1Result = await clawbackEscrow
        .withWallet(wallet)
        .methods.claim(escrow.address, token.address, halfAmount)
        .send({ from: bob, additionalScopes: [escrow.address] });
      const claimTx1 = claimTx1Result.receipt;
      await syncPXE(wallet);

      // Assert that bob received the note and the escrow the change
      const notes1 = (
        await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(claimTx1.txHash));
      expect(notes1.length).toBe(2);
      const claimNotes = (
        await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(claimTx1.txHash));
      expect(claimNotes.length).toBe(2);
      // Both notes should have halfAmount (change to escrow + transfer to recipient)
      expect(
        claimNotes.every((n: any) => n.note.items[0].toBigInt() === halfAmount),
      ).toBe(true);

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob, wad(0), halfAmount);
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        halfAmount,
        escrow.address,
      );

      // Bob claims the full amount
      const claimTx2Result = await clawbackEscrow
        .withWallet(wallet)
        .methods.claim(escrow.address, token.address, halfAmount)
        .send({ from: bob, additionalScopes: [escrow.address] });
      const claimTx2 = claimTx2Result.receipt;
      await syncPXE(wallet);

      // Assert that bob received the note
      const notes2 = (
        await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(claimTx2.txHash));
      expect(notes2.length).toBe(1);
      expectUintNote(notes2[0].note, halfAmount, bob);

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob, wad(0), AMOUNT);
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        wad(0),
        escrow.address,
      );
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
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        AMOUNT,
        escrow.address,
      );

      // Bob tries to claim the full amount after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, token.address, AMOUNT)
          .send({ from: bob, additionalScopes: [escrow.address] }),
      ).rejects.toThrow(/Timestamp mismatch|app_logic_reverted/);
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
        .send({ from: alice, additionalScopes: [escrow.address] });
    });

    it("claim_nft should transfer the NFT to the recipient and emit one note (nft note)", async () => {
      // Create escrow with a deadline far enough in the future that claim lands before it
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 20n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, exactDeadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await assertOwnsPrivateNFT(
        nft,
        tokenId,
        escrow.address,
        true,
        escrow.address,
      );

      // Bob claims the NFT
      const claimTxResult = await clawbackEscrow
        .withWallet(wallet)
        .methods.claim_nft(escrow.address, nft.address, tokenId)
        .send({ from: bob, additionalScopes: [escrow.address] });
      const claimTx = claimTxResult.receipt;
      await syncPXE(wallet);

      // Assert that bob received the note
      const notes = (
        await getWalletNotes(wallet, {
          contractAddress: nft.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(claimTx.txHash));
      expect(notes.length).toBe(1);
      expectNFTNote(notes[0].note, tokenId);

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
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await assertOwnsPrivateNFT(
        nft,
        tokenId,
        escrow.address,
        true,
        escrow.address,
      );

      // Bob tries to claim the NFT after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.claim_nft(escrow.address, nft.address, tokenId)
          .send({ from: bob, additionalScopes: [escrow.address] }),
      ).rejects.toThrow(/Timestamp mismatch|app_logic_reverted/);
    });
  });

  describe("clawback", () => {
    beforeEach(async () => {
      // Deploy a token contract
      token = (await deployTokenWithMinter(wallet, alice)) as TokenContract;

      await token
        .withWallet(wallet)
        .methods.mint_to_private(escrow.address, AMOUNT)
        .send({ from: alice, additionalScopes: [escrow.address] });
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
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await expectTokenBalances(token, alice, wad(0), wad(0));
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        AMOUNT,
        escrow.address,
      );

      // Alice clawbacks the full amount
      const clawbackTxResult = await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback(escrow.address, token.address, AMOUNT)
        .send({ from: alice, additionalScopes: [escrow.address] });
      const clawbackTx = clawbackTxResult.receipt;
      await syncPXE(wallet);

      // Assert that alice received the note
      const notes = (
        await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(clawbackTx.txHash));
      expect(notes.length).toBe(1);
      expectUintNote(notes[0].note, AMOUNT, alice);

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, alice, wad(0), AMOUNT);
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        wad(0),
        escrow.address,
      );
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
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await expectTokenBalances(token, alice, wad(0), wad(0));
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        AMOUNT,
        escrow.address,
      );

      const halfAmount = AMOUNT / 2n;
      // Alice clawbacks a partial amount
      const clawbackTx1Result = await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback(escrow.address, token.address, halfAmount)
        .send({ from: alice, additionalScopes: [escrow.address] });
      const clawbackTx1 = clawbackTx1Result.receipt;
      await syncPXE(wallet);

      // Assert that alice received the note and the escrow the change
      const notes1 = (
        await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(clawbackTx1.txHash));
      expect(notes1.length).toBe(2);
      const claimNotes = (
        await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(clawbackTx1.txHash));
      expect(claimNotes.length).toBe(2);
      // Both notes should have halfAmount (change to escrow + transfer to recipient)
      expect(
        claimNotes.every((n: any) => n.note.items[0].toBigInt() === halfAmount),
      ).toBe(true);

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, alice, wad(0), halfAmount);
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        halfAmount,
        escrow.address,
      );

      // Alice clawbacks the full amount
      const clawbackTx2Result = await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback(escrow.address, token.address, halfAmount)
        .send({ from: alice, additionalScopes: [escrow.address] });
      const clawbackTx2 = clawbackTx2Result.receipt;
      await syncPXE(wallet);

      // Assert that alice received the note
      const notes2 = (
        await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(clawbackTx2.txHash));
      expect(notes2.length).toBe(1);
      expectUintNote(notes2[0].note, halfAmount, alice);

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, alice, wad(0), AMOUNT);
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        wad(0),
        escrow.address,
      );
    });

    it("clawback before deadline should fail", async () => {
      // Create escrow with a deadline far enough in the future that clawback lands before it
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 20n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, exactDeadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await expectTokenBalances(token, alice, wad(0), wad(0));
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        AMOUNT,
        escrow.address,
      );

      // Alice tries to clawback the full amount before deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, token.address, AMOUNT)
          .send({ from: alice, additionalScopes: [escrow.address] }),
      ).rejects.toThrow(/Timestamp mismatch|app_logic_reverted/);
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
        .send({ from: alice, additionalScopes: [escrow.address] });
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
        .methods.setup_clawback_escrow(bob, alice, pastDeadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await assertOwnsPrivateNFT(
        nft,
        tokenId,
        escrow.address,
        true,
        escrow.address,
      );

      // Alice clawbacks the NFT
      const claimTxResult = await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback_nft(escrow.address, nft.address, tokenId)
        .send({ from: alice, additionalScopes: [escrow.address] });
      const claimTx = claimTxResult.receipt;
      await syncPXE(wallet);

      // Assert that alice received the note
      const notes = (
        await getWalletNotes(wallet, {
          contractAddress: nft.address,
          additionalScopes: [escrow.address],
        })
      ).filter((note: any) => note.txHash.equals(claimTx.txHash));
      expect(notes.length).toBe(1);
      expectNFTNote(notes[0].note, tokenId);

      // Assert that NFT were effectively transferred
      await assertOwnsPrivateNFT(nft, tokenId, alice, true);
    });

    it("clawback_nft after deadline should fail", async () => {
      // Create escrow with a deadline far enough in the future that clawback_nft lands before it
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 20n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(bob, alice, exactDeadline, secretKey)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Assert initial balances
      await assertOwnsPrivateNFT(
        nft,
        tokenId,
        escrow.address,
        true,
        escrow.address,
      );

      // Alice tries to clawback the NFT after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.clawback_nft(escrow.address, nft.address, tokenId)
          .send({ from: alice, additionalScopes: [escrow.address] }),
      ).rejects.toThrow(/Timestamp mismatch|app_logic_reverted/);
    });
  });
});

import { type PXE } from "@aztec/pxe/server";
import { siloNullifier } from "@aztec/stdlib/hash";
import { FieldsOf } from "@aztec/foundation/types";
import { type AztecNode } from "@aztec/aztec.js/node";
import { TestWallet } from "@aztec/test-wallet/server";
import { pedersenHash } from "@aztec/foundation/crypto";
import { TxStatus, TxReceipt } from "@aztec/aztec.js/tx";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { deriveKeys, PublicKeys } from "@aztec/stdlib/keys";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { Fr, type GrumpkinScalar } from "@aztec/aztec.js/fields";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";

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

describe("Clawback Escrow - Single PXE", () => {
  const AZTEC_SLOT_TIME = 36n; // seconds

  let pxe: PXE;
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
    masterNullifierSecretKey: GrumpkinScalar;
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

  async function setup() {
    ({ pxe, store, node, wallet, accounts } =
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
      nsk_m: grumpkinScalarToFr(escrowKeys.masterNullifierSecretKey),
      ivsk_m: grumpkinScalarToFr(escrowKeys.masterIncomingViewingSecretKey),
      ovsk_m: grumpkinScalarToFr(escrowKeys.masterOutgoingViewingSecretKey),
      tsk_m: grumpkinScalarToFr(escrowKeys.masterTaggingSecretKey),
    };
  }

  beforeAll(async () => {
    await setup();
  });

  beforeEach(async () => {
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

    await wallet.registerContract(
      escrow.instance,
      EscrowContractArtifact,
      escrowSk,
    );

    const blockNumber = await node.getBlockNumber();
    const block = await node.getBlock(blockNumber);
    deadline = block!.header.globalVariables.timestamp + 1000n;
  });

  afterAll(async () => {
    await store.delete();
  });

  describe("setup_clawback_escrow", () => {
    describe("correct escrow setup", () => {
      let setup_tx: FieldsOf<TxReceipt>;

      beforeAll(async () => {
        await store.delete();
        await setup();
      });

      beforeEach(async () => {
        setup_tx = await clawbackEscrow
          .withWallet(wallet)
          .methods.setup_clawback_escrow(
            escrow.address,
            bob,
            alice,
            deadline,
            secretKeys,
          )
          .send({ from: alice })
          .wait();
      });

      it("creates clawback escrow shares escrow with bob correctly", async () => {
        const blockNumber = setup_tx.blockNumber!;

        const events = await wallet.getPrivateEvents<EscrowDetailsLogContent>(
          clawbackEscrow.address,
          ClawbackEscrowLogicContract.events.EscrowDetailsLogContent,
          blockNumber,
          1,
          [bob],
        );

        expect(events.length).toBe(1);

        const event = events[0];

        expect(event.escrow).toEqual(escrow.address);
        expect(event.master_secret_keys.nsk_m).toEqual(
          escrowKeys.masterNullifierSecretKey.toBigInt(),
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
          clawbackEscrow.address,
          ClawbackEscrowLogicContract.events.EscrowDetailsLogContent,
          blockNumber,
          1,
          [bob],
        );

        expect(events.length).toBe(1);

        const event = events[0];

        expect(event.escrow).toEqual(escrow.address);
        expect(event.master_secret_keys.nsk_m).toEqual(
          escrowKeys.masterNullifierSecretKey.toBigInt(),
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
        await clawbackEscrow
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        const notes = (
          await wallet.getNotes({
            contractAddress: clawbackEscrow.address,
          })
        ).filter((note) => note.txHash.equals(setup_tx.txHash));

        // We expect 1 note
        expect(notes.length).toBe(1);

        // const slotEscrowNotes =
        //   ClawbackEscrowLogicContract.storage.escrows.slot;

        // const escrowNotes = await wallet.getNotes({
        //   txHash: setup_tx.txHash,
        //   contractAddress: clawbackEscrow.address,
        //   recipient: alice,
        //   storageSlot: slotEscrowNotes,
        // });
        // TODO: cannot find notes if recipient: bob
        // const escrowNotes = await wallet.getNotes({
        //   txHash: setup_tx.txHash,
        //   contractAddress: clawbackEscrow.address,
        //   recipient: bob,
        //   storageSlot: slotEscrowNotes,
        // });

        expect(notes[0].note.items[0].toString()).toBe(
          escrow.address.toString(),
        );
        expect(notes[0].note.items[1].toString()).toBe(bob.toString());
        expect(notes[0].note.items[2].toString()).toBe(alice.toString());
        expect(notes[0].note.items[3].toBigInt()).toBe(BigInt(deadline));
      });

      it("creates clawback escrow should emit a nullifier for the escrow", async () => {
        const nullifier = await pedersenHash([escrow.address]);
        const siloedNullifier = await siloNullifier(
          clawbackEscrow.address,
          nullifier,
        );

        const txReceipt = await node.getTxReceipt(setup_tx.txHash);
        expect(txReceipt.status).toBe(TxStatus.SUCCESS);

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
            .setup_clawback_escrow(
              escrow.address,
              bob,
              alice,
              deadline,
              secretKeys,
            )
            .send({ from: alice })
            .wait(),
        ).rejects.toThrow(/Invalid tx: Existing nullifier/);
      });
    });

    describe("incorrect escrow setup", () => {
      beforeAll(async () => {
        await store.delete();
        await setup();
      });

      it("sharing an escrow with incorrect class id should fail", async () => {
        // Re-deploy the logic contract with an incorrect class id
        const wrongClawbackEscrow = (await deployClawbackEscrow(
          wallet,
          alice,
          escrowClassId.add(Fr.ONE),
        )) as ClawbackEscrowLogicContract;

        await expect(
          wrongClawbackEscrow.methods
            .setup_clawback_escrow(
              escrow.address,
              bob,
              alice,
              deadline,
              secretKeys,
            )
            .send({ from: alice })
            .wait(),
        ).rejects.toThrow(/Assertion failed: Escrow class id mismatch/);
      });

      it("sharing an escrow with incorrect salt should fail", async () => {
        // Re-deploy the escrow contract with a different salt (different from the logic contract address)
        escrow = (await deployEscrowWithPublicKeysAndSalt(
          escrowKeys.publicKeys,
          wallet,
          alice,
          escrowSalt.add(Fr.ONE),
        )) as EscrowContract;

        await expect(
          clawbackEscrow.methods
            .setup_clawback_escrow(
              escrow.address,
              bob,
              alice,
              deadline,
              secretKeys,
            )
            .send({ from: alice })
            .wait(),
        ).rejects.toThrow(/Assertion failed: Escrow salt mismatch/);
      });
    });
  });

  describe("claim", () => {
    beforeAll(async () => {
      await store.delete();
      await setup();
    });

    beforeEach(async () => {
      // Deploy a token contract
      token = (await deployTokenWithMinter(wallet, alice)) as TokenContract;

      await token
        .withWallet(wallet)
        .methods.mint_to_private(escrow.address, AMOUNT)
        .send({ from: alice })
        .wait();
    });

    it("claim should transfer the tokens to the recipient and emit one note (token note)", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await node.getBlockNumber();
      let block = await node.getBlock(blockNumber);
      // The deadline is calculated as the exact timestamp of the block in which claim() will happen
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n;
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          exactDeadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

      // Bob claims the full amount
      const claimTx = await clawbackEscrow
        .withWallet(wallet)
        .methods.claim(escrow.address, token.address, AMOUNT)
        .send({ from: bob })
        .wait();
      await token
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: bob });

      // Assert that bob received the note
      const notes = (
        await wallet.getNotes({
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(claimTx.txHash));
      expect(notes.length).toBe(1);
      expectUintNote(notes[0], AMOUNT, bob);

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob, wad(0), AMOUNT);
      await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
    });

    it("claim two times in a row should be successful", async () => {
      await clawbackEscrow
        .withWallet(wallet)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          deadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

      const halfAmount = AMOUNT / 2n;
      // Bob claims the full amount
      const claimTx1 = await clawbackEscrow
        .withWallet(wallet)
        .methods.claim(escrow.address, token.address, halfAmount)
        .send({ from: bob })
        .wait();
      await token
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: bob });

      // Assert that bob received the note and the escrow the change
      const notes1 = (
        await wallet.getNotes({
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(claimTx1.txHash));
      expect(notes1.length).toBe(2);
      const changeNote = (
        await wallet.getNotes({
          scopes: [escrow.address],
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(claimTx1.txHash));
      const transferNote = (
        await wallet.getNotes({
          scopes: [bob],
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(claimTx1.txHash));
      expectUintNote(changeNote[0], halfAmount, escrow.address);
      expectUintNote(transferNote[0], halfAmount, bob);

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob, wad(0), halfAmount);
      await expectTokenBalances(token, escrow.address, wad(0), halfAmount, bob);

      // Bob claims the full amount
      const claimTx2 = await clawbackEscrow
        .withWallet(wallet)
        .methods.claim(escrow.address, token.address, halfAmount)
        .send({ from: bob })
        .wait();
      await token
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: bob });

      // Assert that bob received the note
      const notes2 = (
        await wallet.getNotes({
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(claimTx2.txHash));
      expect(notes2.length).toBe(1);
      expectUintNote(notes2[0], halfAmount, bob);

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
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

      // Bob tries to claim the full amount after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, token.address, AMOUNT)
          .send({ from: bob })
          .wait(),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("claim_nft", () => {
    const tokenId = 1n;

    beforeAll(async () => {
      await store.delete();
      await setup();
    });

    beforeEach(async () => {
      // Deploy a nft contract
      nft = (await deployNFTWithMinter(wallet, alice)) as NFTContract;
      await nft
        .withWallet(wallet)
        .methods.mint_to_private(escrow.address, tokenId)
        .send({ from: alice })
        .wait();
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
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          exactDeadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address, true, bob);

      // Bob claims the NFT
      const claimTx = await clawbackEscrow
        .withWallet(wallet)
        .methods.claim_nft(escrow.address, nft.address, tokenId)
        .send({ from: bob })
        .wait();
      await nft
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: bob });

      // Assert that bob received the note
      const notes = (
        await wallet.getNotes({
          contractAddress: nft.address,
        })
      ).filter((note) => note.txHash.equals(claimTx.txHash));
      expect(notes.length).toBe(1);
      expectNFTNote(notes[0], tokenId, bob);

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
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address, true, bob);

      // Bob tries to claim the NFT after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.claim_nft(escrow.address, nft.address, tokenId)
          .send({ from: bob })
          .wait(),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("clawback", () => {
    beforeAll(async () => {
      await store.delete();
      await setup();
    });

    beforeEach(async () => {
      // Deploy a token contract
      token = (await deployTokenWithMinter(wallet, alice)) as TokenContract;

      await token
        .withWallet(wallet)
        .methods.mint_to_private(escrow.address, AMOUNT)
        .send({ from: alice })
        .wait();
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
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, alice, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, alice);

      // Alice clawbacks the full amount
      const clawbackTx = await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback(escrow.address, token.address, AMOUNT)
        .send({ from: alice })
        .wait();
      await token
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: alice });

      // Assert that alice received the note
      const notes = (
        await wallet.getNotes({
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(clawbackTx.txHash));
      expect(notes.length).toBe(1);
      expectUintNote(notes[0], AMOUNT, alice);

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
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, alice, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, alice);

      const halfAmount = AMOUNT / 2n;
      // Alice clawbacks a partial amount
      const clawbackTx1 = await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback(escrow.address, token.address, halfAmount)
        .send({ from: alice })
        .wait();
      await token
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: alice });

      // Assert that alice received the note and the escrow the change
      const notes1 = (
        await wallet.getNotes({
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(clawbackTx1.txHash));
      expect(notes1.length).toBe(2);
      const changeNote = (
        await wallet.getNotes({
          scopes: [escrow.address],
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(clawbackTx1.txHash));
      const transferNote = (
        await wallet.getNotes({
          scopes: [alice],
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(clawbackTx1.txHash));
      expectUintNote(changeNote[0], halfAmount, escrow.address);
      expectUintNote(transferNote[0], halfAmount, alice);

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
      const clawbackTx2 = await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback(escrow.address, token.address, halfAmount)
        .send({ from: alice })
        .wait();
      await token
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: alice });

      // Assert that alice received the note
      const notes2 = (
        await wallet.getNotes({
          contractAddress: token.address,
        })
      ).filter((note) => note.txHash.equals(clawbackTx2.txHash));
      expect(notes2.length).toBe(1);
      expectUintNote(notes2[0], halfAmount, alice);

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
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          exactDeadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, alice, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, alice);

      // Alice tries to clawback the full amount before deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, token.address, AMOUNT)
          .send({ from: alice })
          .wait(),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("clawback_nft", () => {
    const tokenId = 1n;

    beforeAll(async () => {
      await store.delete();
      await setup();
    });

    beforeEach(async () => {
      // Deploy a nft contract
      nft = (await deployNFTWithMinter(wallet, alice)) as NFTContract;
      await nft
        .withWallet(wallet)
        .methods.mint_to_private(escrow.address, tokenId)
        .send({ from: alice })
        .wait();
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
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address, true, bob);

      // Alice clawbacks the NFT
      const claimTx = await clawbackEscrow
        .withWallet(wallet)
        .methods.clawback_nft(escrow.address, nft.address, tokenId)
        .send({ from: alice })
        .wait();
      await nft
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: alice });

      // Assert that alice received the note
      const notes = (
        await wallet.getNotes({
          contractAddress: nft.address,
        })
      ).filter((note) => note.txHash.equals(claimTx.txHash));
      expect(notes.length).toBe(1);
      expectNFTNote(notes[0], tokenId, alice);

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
        .methods.setup_clawback_escrow(
          escrow.address,
          bob,
          alice,
          exactDeadline,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address, true, bob);

      // Alice tries to clawback the NFT after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(wallet)
          .methods.clawback_nft(escrow.address, nft.address, tokenId)
          .send({ from: alice })
          .wait(),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });
});

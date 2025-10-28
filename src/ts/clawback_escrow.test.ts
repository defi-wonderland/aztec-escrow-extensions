import {
  Fr,
  TxStatus,
  AccountWalletWithSecretKey,
  PublicKeys,
  GrumpkinScalar,
  getContractClassFromArtifact,
} from "@aztec/aztec.js";
import type { FieldsOf } from "@aztec/foundation/types";
import { type TxReceipt } from "@aztec/stdlib/tx";
import { deriveKeys } from "@aztec/stdlib/keys";
import {
  setupPXE,
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
import { siloNullifier } from "@aztec/stdlib/hash";
import { pedersenHash } from "@aztec/foundation/crypto";
import { PXE } from "@aztec/stdlib/interfaces/client";
import { AztecLmdbStore } from "@aztec/kv-store/lmdb";
import { getInitialTestAccountsManagers } from "@aztec/accounts/testing";
import {
  ClawbackEscrowLogicContract,
  EscrowDetailsLogContent,
} from "../artifacts/ClawbackEscrowLogic.js";
import { EscrowContractArtifact, EscrowContract } from "../artifacts/Escrow.js";
import { TokenContract } from "../artifacts/Token.js";
import { NFTContract } from "../artifacts/NFT.js";

const setupTestSuite = async () => {
  const { pxe, store } = await setupPXE();
  const managers = await getInitialTestAccountsManagers(pxe);
  const wallets = await Promise.all(managers.map((acc) => acc.register()));
  const [deployer] = wallets;

  return { pxe, deployer, wallets, store };
};

describe("Clawback Escrow - Single PXE", () => {
  const AZTEC_SLOT_TIME = 36n; // seconds

  let pxe: PXE;
  let store: AztecLmdbStore;

  let wallets: AccountWalletWithSecretKey[];
  let deployer: AccountWalletWithSecretKey;

  let alice: AccountWalletWithSecretKey;
  let bob: AccountWalletWithSecretKey;
  let carl: AccountWalletWithSecretKey;

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
    ({ pxe, deployer, wallets, store } = await setupTestSuite());

    [alice, bob, carl] = wallets;

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
    clawbackEscrow = await deployClawbackEscrow(alice, escrowClassId);

    // Use the logic contract address as the salt for the escrow contract
    escrowSalt = new Fr(clawbackEscrow.address.toBigInt());

    // Deploy an escrow contract
    escrow = (await deployEscrowWithPublicKeysAndSalt(
      escrowKeys.publicKeys,
      alice,
      escrowSalt,
    )) as EscrowContract;

    const partialAddressEscrow = await escrow.partialAddress;
    await pxe.registerAccount(escrowSk, partialAddressEscrow);

    const blockNumber = await pxe.getBlockNumber();
    const block = await pxe.getBlock(blockNumber);
    deadline = block!.header.globalVariables.timestamp + 1000n;
  });

  afterAll(async () => {
    await store.delete();
  });

  describe("setup_clawback_escrow", () => {
    describe("correct escrow setup", () => {
      let setup_tx: FieldsOf<TxReceipt>;

      beforeAll(async () => {
        await setup();
      });

      beforeEach(async () => {
        setup_tx = await clawbackEscrow
          .withWallet(alice)
          .methods.setup_clawback_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            deadline,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();
      });

      it("creates clawback escrow shares escrow with bob correctly", async () => {
        const blockNumber = setup_tx.blockNumber!;

        const bobPxe = pxe;

        const events = await bobPxe.getPrivateEvents<EscrowDetailsLogContent>(
          clawbackEscrow.address,
          ClawbackEscrowLogicContract.events.EscrowDetailsLogContent,
          blockNumber,
          1,
          [bob.getAddress()],
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

        const alicePxe = pxe;

        const events = await alicePxe.getPrivateEvents<EscrowDetailsLogContent>(
          clawbackEscrow.address,
          ClawbackEscrowLogicContract.events.EscrowDetailsLogContent,
          blockNumber,
          1,
          [bob.getAddress()],
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
        const bobPXE = pxe;

        await clawbackEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        const notes = await bobPXE.getNotes({
          contractAddress: clawbackEscrow.address,
          txHash: setup_tx.txHash,
        });

        // We expect 1 note
        expect(notes.length).toBe(1);

        // const slotEscrowNotes =
        //   ClawbackEscrowLogicContract.storage.escrows.slot;

        // const escrowNotes = await bobPXE.getNotes({
        //   txHash: setup_tx.txHash,
        //   contractAddress: clawbackEscrow.address,
        //   recipient: alice.getAddress(),
        //   storageSlot: slotEscrowNotes,
        // });
        // TODO: cannot find notes if recipient: bob
        // const escrowNotes = await bobPXE.getNotes({
        //   txHash: setup_tx.txHash,
        //   contractAddress: clawbackEscrow.address,
        //   recipient: bob.getAddress(),
        //   storageSlot: slotEscrowNotes,
        // });

        expect(notes[0].note.items[0].toString()).toBe(
          escrow.address.toString(),
        );
        expect(notes[0].note.items[1].toString()).toBe(
          bob.getAddress().toString(),
        );
        expect(notes[0].note.items[2].toString()).toBe(
          alice.getAddress().toString(),
        );
        expect(notes[0].note.items[3].toBigInt()).toBe(BigInt(deadline));
      });

      it("creates clawback escrow should emit a nullifier for the escrow", async () => {
        const nullifier = await pedersenHash([escrow.address]);
        const siloedNullifier = await siloNullifier(
          clawbackEscrow.address,
          nullifier,
        );

        const txReceipt = await pxe.getTxReceipt(setup_tx.txHash);
        expect(txReceipt.status).toBe(TxStatus.SUCCESS);

        const txEffect = await pxe.getTxEffect(setup_tx.txHash);
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
              bob.getAddress(),
              alice.getAddress(),
              deadline,
              secretKeys,
            )
            .send({ from: alice.getAddress() })
            .wait(),
        ).rejects.toThrow(/Invalid tx: Existing nullifier/);
      });
    });

    describe("incorrect escrow setup", () => {
      beforeAll(async () => {
        await setup();
      });

      it("sharing an escrow with incorrect class id should fail", async () => {
        // Re-deploy the logic contract with an incorrect class id
        const wrongClawbackEscrow = (await deployClawbackEscrow(
          alice,
          escrowClassId.add(Fr.ONE),
        )) as ClawbackEscrowLogicContract;

        await expect(
          wrongClawbackEscrow.methods
            .setup_clawback_escrow(
              escrow.address,
              bob.getAddress(),
              alice.getAddress(),
              deadline,
              secretKeys,
            )
            .send({ from: alice.getAddress() })
            .wait(),
        ).rejects.toThrow(/Assertion failed: Escrow class id mismatch/);
      });

      it("sharing an escrow with incorrect salt should fail", async () => {
        // Re-deploy the escrow contract with a different salt (different from the logic contract address)
        escrow = (await deployEscrowWithPublicKeysAndSalt(
          escrowKeys.publicKeys,
          alice,
          escrowSalt.add(Fr.ONE),
        )) as EscrowContract;

        await expect(
          clawbackEscrow.methods
            .setup_clawback_escrow(
              escrow.address,
              bob.getAddress(),
              alice.getAddress(),
              deadline,
              secretKeys,
            )
            .send({ from: alice.getAddress() })
            .wait(),
        ).rejects.toThrow(/Assertion failed: Escrow salt mismatch/);
      });
    });
  });

  describe("claim", () => {
    beforeAll(async () => {
      await setup();
    });

    beforeEach(async () => {
      // Deploy a token contract
      token = (await deployTokenWithMinter(alice)) as TokenContract;

      await token
        .withWallet(alice)
        .methods.mint_to_private(escrow.address, AMOUNT)
        .send({ from: alice.getAddress() })
        .wait();
    });

    it("claim should transfer the tokens to the recipient and emit one note (token note)", async () => {
      const bobPXE = pxe;

      // Create escrow with a deadline in the past
      let blockNumber = await pxe.getBlockNumber();
      let block = await pxe.getBlock(blockNumber);
      // The deadline is calculated as the exact timestamp of the block in which claim() will happen
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n;
      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          exactDeadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

      // Bob claims the full amount
      const claimTx = await clawbackEscrow
        .withWallet(bob)
        .methods.claim(escrow.address, token.address, AMOUNT)
        .send({ from: bob.getAddress() })
        .wait();
      await token
        .withWallet(bob)
        .methods.sync_private_state()
        .simulate({ from: bob.getAddress() });

      // Assert that bob received the note
      const notes = await bobPXE.getNotes({
        contractAddress: token.address,
        txHash: claimTx.txHash,
      });
      expect(notes.length).toBe(1);
      expectUintNote(notes[0], AMOUNT, bob.getAddress());

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob.getAddress(), wad(0), AMOUNT);
      await expectTokenBalances(token, escrow.address, wad(0), wad(0));
    });

    it("claim two times in a row should be successful", async () => {
      const bobPXE = pxe;

      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          deadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

      const halfAmount = AMOUNT / 2n;
      // Bob claims the full amount
      const claimTx1 = await clawbackEscrow
        .withWallet(bob)
        .methods.claim(escrow.address, token.address, halfAmount)
        .send({ from: bob.getAddress() })
        .wait();
      await token
        .withWallet(bob)
        .methods.sync_private_state()
        .simulate({ from: bob.getAddress() });

      // Assert that bob received the note and the escrow the change
      const notes1 = await bobPXE.getNotes({
        contractAddress: token.address,
        txHash: claimTx1.txHash,
      });
      expect(notes1.length).toBe(2);
      const changeNote = await bobPXE.getNotes({
        contractAddress: token.address,
        txHash: claimTx1.txHash,
        recipient: escrow.address,
      });
      const transferNote = await bobPXE.getNotes({
        contractAddress: token.address,
        txHash: claimTx1.txHash,
        recipient: bob.getAddress(),
      });
      expectUintNote(changeNote[0], halfAmount, escrow.address);
      expectUintNote(transferNote[0], halfAmount, bob.getAddress());

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob.getAddress(), wad(0), halfAmount);
      await expectTokenBalances(token, escrow.address, wad(0), halfAmount);

      // Bob claims the full amount
      const claimTx2 = await clawbackEscrow
        .withWallet(bob)
        .methods.claim(escrow.address, token.address, halfAmount)
        .send({ from: bob.getAddress() })
        .wait();
      await token
        .withWallet(bob)
        .methods.sync_private_state()
        .simulate({ from: bob.getAddress() });

      // Assert that bob received the note
      const notes2 = await bobPXE.getNotes({
        contractAddress: token.address,
        txHash: claimTx2.txHash,
      });
      expect(notes2.length).toBe(1);
      expectUintNote(notes2[0], halfAmount, bob.getAddress());

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, bob.getAddress(), wad(0), AMOUNT);
      await expectTokenBalances(token, escrow.address, wad(0), wad(0));
    });

    it("claim after deadline should fail", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await pxe.getBlockNumber();
      let block = await pxe.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which claim() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;

      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

      // Bob tries to claim the full amount after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, token.address, AMOUNT)
          .send({ from: bob.getAddress() })
          .wait(),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("claim_nft", () => {
    const tokenId = 1n;

    beforeAll(async () => {
      await setup();
    });

    beforeEach(async () => {
      // Deploy a nft contract
      nft = (await deployNFTWithMinter(alice)) as NFTContract;
      await nft
        .withWallet(alice)
        .methods.mint_to_private(escrow.address, tokenId)
        .send({ from: alice.getAddress() })
        .wait();
    });

    it("claim_nft should transfer the NFT to the recipient and emit one note (nft note)", async () => {
      const bobPXE = pxe;

      // Create escrow with a deadline in the past
      let blockNumber = await pxe.getBlockNumber();
      let block = await pxe.getBlock(blockNumber);
      // The deadline is calculated as the exact timestamp of the block in which claim() will happen
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n;
      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          exactDeadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address);

      // Bob claims the NFT
      const claimTx = await clawbackEscrow
        .withWallet(bob)
        .methods.claim_nft(escrow.address, nft.address, tokenId)
        .send({ from: bob.getAddress() })
        .wait();
      await nft
        .withWallet(bob)
        .methods.sync_private_state()
        .simulate({ from: bob.getAddress() });

      // Assert that bob received the note
      const notes = await bobPXE.getNotes({
        contractAddress: nft.address,
        txHash: claimTx.txHash,
      });
      expect(notes.length).toBe(1);
      expectNFTNote(notes[0], tokenId, bob.getAddress());

      // Assert that NFT were effectively transferred
      await assertOwnsPrivateNFT(nft, tokenId, bob.getAddress());
    });

    it("claim_nft after deadline should fail", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await pxe.getBlockNumber();
      let block = await pxe.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which claim() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;

      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address);

      // Bob tries to claim the NFT after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(bob)
          .methods.claim_nft(escrow.address, nft.address, tokenId)
          .send({ from: bob.getAddress() })
          .wait(),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("clawback", () => {
    beforeAll(async () => {
      await setup();
    });

    beforeEach(async () => {
      // Deploy a token contract
      token = (await deployTokenWithMinter(alice)) as TokenContract;

      await token
        .withWallet(alice)
        .methods.mint_to_private(escrow.address, AMOUNT)
        .send({ from: alice.getAddress() })
        .wait();
    });

    it("clawback should transfer the tokens to the recipient and emit one note (token note)", async () => {
      const alicePXE = pxe;

      // Create escrow with a deadline in the past
      let blockNumber = await pxe.getBlockNumber();
      let block = await pxe.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which clawback() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;
      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

      // Alice clawbacks the full amount
      const clawbackTx = await clawbackEscrow
        .withWallet(alice)
        .methods.clawback(escrow.address, token.address, AMOUNT)
        .send({ from: alice.getAddress() })
        .wait();
      await token
        .withWallet(alice)
        .methods.sync_private_state()
        .simulate({ from: alice.getAddress() });

      // Assert that alice received the note
      const notes = await alicePXE.getNotes({
        contractAddress: token.address,
        txHash: clawbackTx.txHash,
      });
      expect(notes.length).toBe(1);
      expectUintNote(notes[0], AMOUNT, alice.getAddress());

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, alice.getAddress(), wad(0), AMOUNT);
      await expectTokenBalances(token, escrow.address, wad(0), wad(0));
    });

    it("clawback two times in a row should be successful", async () => {
      const alicePXE = pxe;

      // Create escrow with a deadline in the past
      let blockNumber = await pxe.getBlockNumber();
      let block = await pxe.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which clawback() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;
      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

      const halfAmount = AMOUNT / 2n;
      // Alice clawbacks a partial amount
      const clawbackTx1 = await clawbackEscrow
        .withWallet(alice)
        .methods.clawback(escrow.address, token.address, halfAmount)
        .send({ from: alice.getAddress() })
        .wait();
      await token
        .withWallet(alice)
        .methods.sync_private_state()
        .simulate({ from: alice.getAddress() });

      // Assert that alice received the note and the escrow the change
      const notes1 = await alicePXE.getNotes({
        contractAddress: token.address,
        txHash: clawbackTx1.txHash,
      });
      expect(notes1.length).toBe(2);
      const changeNote = await alicePXE.getNotes({
        contractAddress: token.address,
        txHash: clawbackTx1.txHash,
        recipient: escrow.address,
      });
      const transferNote = await alicePXE.getNotes({
        contractAddress: token.address,
        txHash: clawbackTx1.txHash,
        recipient: alice.getAddress(),
      });
      expectUintNote(changeNote[0], halfAmount, escrow.address);
      expectUintNote(transferNote[0], halfAmount, alice.getAddress());

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, alice.getAddress(), wad(0), halfAmount);
      await expectTokenBalances(token, escrow.address, wad(0), halfAmount);

      // Alice clawbacks the full amount
      const clawbackTx2 = await clawbackEscrow
        .withWallet(alice)
        .methods.clawback(escrow.address, token.address, halfAmount)
        .send({ from: alice.getAddress() })
        .wait();
      await token
        .withWallet(alice)
        .methods.sync_private_state()
        .simulate({ from: alice.getAddress() });

      // Assert that alice received the note
      const notes2 = await alicePXE.getNotes({
        contractAddress: token.address,
        txHash: clawbackTx2.txHash,
      });
      expect(notes2.length).toBe(1);
      expectUintNote(notes2[0], halfAmount, alice.getAddress());

      // Assert that tokens were effectively transferred
      await expectTokenBalances(token, alice.getAddress(), wad(0), AMOUNT);
      await expectTokenBalances(token, escrow.address, wad(0), wad(0));
    });

    it("clawback before deadline should fail", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await pxe.getBlockNumber();
      let block = await pxe.getBlock(blockNumber);
      // The deadline is calculated as the exact timestamp of the block in which clawback() will happen
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n;
      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          exactDeadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

      // Alice tries to clawback the full amount before deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(alice)
          .methods.clawback(escrow.address, token.address, AMOUNT)
          .send({ from: alice.getAddress() })
          .wait(),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("clawback_nft", () => {
    const tokenId = 1n;

    beforeAll(async () => {
      await setup();
    });

    beforeEach(async () => {
      // Deploy a nft contract
      nft = (await deployNFTWithMinter(alice)) as NFTContract;
      await nft
        .withWallet(alice)
        .methods.mint_to_private(escrow.address, tokenId)
        .send({ from: alice.getAddress() })
        .wait();
    });

    it("clawback_nft should transfer the NFT to the recipient and emit one note (nft note)", async () => {
      const alicePXE = pxe;

      // Create escrow with a deadline in the past
      let blockNumber = await pxe.getBlockNumber();
      let block = await pxe.getBlock(blockNumber);
      // The deadline is calculated as 1 second in the past of the block in which claim() will happen
      const pastDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n - 1n;
      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          pastDeadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address);

      // Alice clawbacks the NFT
      const claimTx = await clawbackEscrow
        .withWallet(alice)
        .methods.clawback_nft(escrow.address, nft.address, tokenId)
        .send({ from: alice.getAddress() })
        .wait();
      await nft
        .withWallet(alice)
        .methods.sync_private_state()
        .simulate({ from: alice.getAddress() });

      // Assert that alice received the note
      const notes = await alicePXE.getNotes({
        contractAddress: nft.address,
        txHash: claimTx.txHash,
      });
      expect(notes.length).toBe(1);
      expectNFTNote(notes[0], tokenId, alice.getAddress());

      // Assert that NFT were effectively transferred
      await assertOwnsPrivateNFT(nft, tokenId, alice.getAddress());
    });

    it("clawback_nft after deadline should fail", async () => {
      // Create escrow with a deadline in the past
      let blockNumber = await pxe.getBlockNumber();
      let block = await pxe.getBlock(blockNumber);
      // The deadline is calculated as the exact timestamp of the block in which clawback_nft() will happen
      const exactDeadline =
        block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 2n;
      await clawbackEscrow
        .withWallet(alice)
        .methods.setup_clawback_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          exactDeadline,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await assertOwnsPrivateNFT(nft, tokenId, escrow.address);

      // Alice tries to clawback the NFT after deadline - this should fail
      await expect(
        clawbackEscrow
          .withWallet(alice)
          .methods.clawback_nft(escrow.address, nft.address, tokenId)
          .send({ from: alice.getAddress() })
          .wait(),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });
});

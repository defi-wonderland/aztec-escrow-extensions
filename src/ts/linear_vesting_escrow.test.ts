import { siloNullifier } from "@aztec/stdlib/hash";
import { FieldsOf } from "@aztec/foundation/types";
import { type AztecNode } from "@aztec/aztec.js/node";
import { TestWallet } from "@aztec/test-wallet/server";
import { pedersenHash } from "@aztec/foundation/crypto";
import { TxStatus, TxReceipt } from "@aztec/aztec.js/tx";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { deriveKeys, PublicKeys } from "@aztec/stdlib/keys";
import { ContractDeployer } from "@aztec/aztec.js/deployment";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { Fr, type GrumpkinScalar } from "@aztec/aztec.js/fields";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";
import {
  Contract,
  getContractInstanceFromInstantiationParams,
} from "@aztec/aztec.js/contracts";

import {
  LinearVestingEscrowLogicContract,
  LinearVestingEscrowLogicContractArtifact,
  EscrowDetailsLogContent,
} from "../artifacts/LinearVestingEscrowLogic.js";
import { EscrowContractArtifact, EscrowContract } from "../artifacts/Escrow.js";
import { TokenContract } from "../artifacts/Token.js";

import {
  setupTestSuite,
  deployTokenWithMinter,
  AMOUNT,
  U128_MAX,
  expectTokenBalances,
  wad,
  expectUintNote,
  deployLinearVestingEscrow,
  deployEscrowWithPublicKeysAndSalt,
  grumpkinScalarToFr,
  deriveContractAddress,
} from "./utils.js";

describe("Linear Vesting Escrow", () => {
  let node: AztecNode;
  let store: AztecLMDBStoreV2;

  let wallet: TestWallet;
  let accounts: AztecAddress[];
  let alice: AztecAddress;
  let bob: AztecAddress;
  let carl: AztecAddress;

  // Linear vesting contract
  let linearVestingEscrow: LinearVestingEscrowLogicContract;

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

  let start: bigint;
  let duration: bigint;

  const slotEscrowNotes = LinearVestingEscrowLogicContract.storage.escrows.slot;
  const slotReleasedAmountNotes =
    LinearVestingEscrowLogicContract.storage.released_notes.slot;

  const AZTEC_SLOT_TIME = 36n; // seconds
  const MAX_U64_VALUE = (1n << 64n) - 1n;

  async function setup() {
    ({ store, node, wallet, accounts } = await setupTestSuite(
      "linear-vesting-escrow",
    ));

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
    // Logic is deployed with the public keys because it sends encrypted events to the recipient and with the escrow class id
    linearVestingEscrow = (await deployLinearVestingEscrow(
      wallet,
      alice,
      escrowClassId,
    )) as LinearVestingEscrowLogicContract;

    // Use the logic contract address as the salt for the escrow contract
    escrowSalt = new Fr(linearVestingEscrow.address.toBigInt());

    // Deploy an escrow contract
    escrow = (await deployEscrowWithPublicKeysAndSalt(
      escrowKeys.publicKeys,
      wallet,
      alice,
      escrowSalt,
    )) as EscrowContract;

    // Deploy a token contract
    token = (await deployTokenWithMinter(wallet, alice)) as TokenContract;

    await wallet.registerContract(
      escrow.instance,
      EscrowContractArtifact,
      escrowSk,
    );

    await token
      .withWallet(wallet)
      .methods.mint_to_private(escrow.address, AMOUNT)
      .send({ from: alice })
      .wait();

    const blockNumber = await node.getBlockNumber();
    const block = await node.getBlock(blockNumber);
    start = block!.header.globalVariables.timestamp;
    duration = 200n;
  });

  afterAll(async () => {
    await store.delete();
  });

  describe("Deployment", () => {
    beforeAll(async () => {
      await setup();
    });

    it("deploys linear vesting escrow with correct constructor params", async () => {
      const salt = Fr.random();
      const deploymentData = await getContractInstanceFromInstantiationParams(
        LinearVestingEscrowLogicContractArtifact,
        {
          constructorArtifact: "constructor",
          constructorArgs: [escrowClassId],
          salt,
          deployer: alice,
        },
      );

      const deployer = new ContractDeployer(
        LinearVestingEscrowLogicContractArtifact,
        wallet,
        undefined,
        "constructor",
      );
      const tx = deployer.deploy(escrowClassId).send({
        contractAddressSalt: salt,
        from: alice,
      });

      const receipt = await tx.getReceipt();

      expect(receipt).toEqual(
        expect.objectContaining({
          status: TxStatus.PENDING,
          error: "",
        }),
      );

      const receiptAfterMined = await tx.wait({ wallet });

      const contractMetadata = await wallet.getContractMetadata(
        deploymentData.address,
      );
      expect(contractMetadata).toBeDefined();
      // TODO: Fix this
      // expect(contractMetadata.isContractPubliclyDeployed).toBeTruthy();
      expect(receiptAfterMined).toEqual(
        expect.objectContaining({
          status: TxStatus.SUCCESS,
        }),
      );

      expect(receiptAfterMined.contract.address).toEqual(
        deploymentData.address,
      );
    });

    it("deploys escrow with correctly derived address", async () => {
      const { address, initializationHash } = await deriveContractAddress(
        EscrowContractArtifact,
        [], // constructor args are null
        AztecAddress.ZERO, // deployer is null
        escrowSalt,
        escrowKeys.publicKeys,
      );

      expect(address).toEqual(escrow.address);
      expect(initializationHash).toEqual(Fr.ZERO);
      expect(initializationHash).toEqual(escrow.instance.initializationHash);
    });
  });

  describe("setup_linear_vesting_escrow", () => {
    beforeAll(async () => {
      await store.delete();
      await setup();
    });

    let tx: FieldsOf<TxReceipt>;

    beforeEach(async () => {
      tx = await linearVestingEscrow
        .withWallet(wallet)
        .methods.setup_linear_vesting_escrow(
          bob,
          alice,
          token.address,
          start,
          duration,
          AMOUNT,
          secretKeys,
        )
        .send({ from: alice })
        .wait();
    });

    it("creates linear vesting escrow shares escrow with bob correctly", async () => {
      const blockNumber = tx.blockNumber!;

      const events = await wallet.getPrivateEvents<EscrowDetailsLogContent>(
        linearVestingEscrow.address,
        LinearVestingEscrowLogicContract.events.EscrowDetailsLogContent,
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

    it("creates linear vesting escrow should create a correct linearVestingEscrow note", async () => {
      await linearVestingEscrow
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: bob });

      const notes = await wallet.getNotes({
        contractAddress: linearVestingEscrow.address,
        scopes: [escrow.address],
      });

      // We expect 2 notes: 1 for the linear vesting escrow and 1 for the released amount
      expect(notes.length).toBe(2);

      const escrowNotes = (
        await wallet.getNotes({
          scopes: [escrow.address],
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotEscrowNotes,
        })
      )[0].note;
      const releasedAmountNotes = (
        await wallet.getNotes({
          scopes: [escrow.address],
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotReleasedAmountNotes,
        })
      )[0].note;

      expect(escrowNotes.items[0].toString()).toBe(escrow.address.toString());
      expect(escrowNotes.items[1].toString()).toBe(bob.toString());
      expect(escrowNotes.items[2].toString()).toBe(alice.toString());
      expect(escrowNotes.items[3].toString()).toBe(token.address.toString());
      expect(escrowNotes.items[4].toBigInt()).toBe(BigInt(start));
      expect(escrowNotes.items[5].toBigInt()).toBe(BigInt(duration));
      expect(escrowNotes.items[6].toBigInt()).toBe(BigInt(AMOUNT));

      expect(releasedAmountNotes.items[0].toString()).toBe(
        escrow.address.toString(),
      );
      expect(releasedAmountNotes.items[1].toBigInt()).toBe(BigInt(0));
    });

    it("creates linear vesting escrow should emit a nullifier for the escrow", async () => {
      const nullifier = await pedersenHash([escrow.address]);
      const siloedNullifier = await siloNullifier(
        linearVestingEscrow.address,
        nullifier,
      );

      const txReceipt = await node.getTxReceipt(tx.txHash);
      expect(txReceipt.status).toBe(TxStatus.SUCCESS);

      const txEffect = await node.getTxEffect(tx.txHash);
      let nullifierExists = false;
      if (txEffect) {
        const nullifiers = txEffect.data.nullifiers;
        nullifierExists = nullifiers.some((n) => n.equals(siloedNullifier));
      }

      expect(nullifierExists).toBe(true);
    });

    it("creates linear vesting escrow should nullify and not allow to create another one", async () => {
      // Try to create a linear vesting escrow for carl after one for bob was created
      await expect(
        linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            carl,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait(),
      ).rejects.toThrow(/Invalid tx: Existing nullifier/);
    });

    it("creates linear vesting escrow should fail if start + duration overflows", async () => {
      start = MAX_U64_VALUE;
      duration = MAX_U64_VALUE;

      await expect(
        linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            carl,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait(),
      ).rejects.toThrow(
        "Assertion failed: attempt to add with overflow 'start + duration'",
      );
    });
  });

  describe("claim", () => {
    // Split in 3 parts due to memory limit of the store
    describe("part 1", () => {
      beforeAll(async () => {
        await setup();
      });

      it("claim should transfer the tokens to the recipient and emit one note (token note)", async () => {
        // We set the duration to 1 to make the tokens fully claimable
        duration = 1n;

        const tx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        // Next claim tx will read previous tx timestamp
        const block = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

        // Get releasable amount to call claim function
        const [releasableAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob });

        // Bob claims the full amount
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob })
          .wait();
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // Assert that bob received the note
        const notes = await wallet.getNotes({
          scopes: [bob],
          contractAddress: token.address,
        });
        expect(notes.length).toBe(1);
        expectUintNote(notes[0], AMOUNT, bob);

        // Assert that tokens were effectively transferred
        await expectTokenBalances(token, bob, wad(0), AMOUNT);
        await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
      });

      it("claim should transfer the tokens partially to the recipient and emit 3 notes (tokens and released amount note)", async () => {
        // We set the duration to 1000 to make the tokens partially claimable
        duration = 1000n;

        const tx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        // Next claim tx will read previous tx timestamp
        const block = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

        // Get releasable amount to call claim function
        const [releasableAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob });

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob })
          .wait();
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        const receivedAmount =
          ((BigInt(claimTimestamp) - BigInt(start)) * AMOUNT) /
          BigInt(duration);

        // We expect a released amount note
        const notes = await wallet.getNotes({
          scopes: [escrow.address],
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotReleasedAmountNotes,
        });
        expect(notes.length).toBe(1);

        const escrowTokenNote = await wallet.getNotes({
          scopes: [escrow.address],
          contractAddress: token.address,
        });
        expectUintNote(
          escrowTokenNote[0],
          AMOUNT - receivedAmount,
          escrow.address,
        );

        const releasedAmountNote = (
          await wallet.getNotes({
            scopes: [escrow.address],
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        )[0].note;
        expect(releasedAmountNote.items[1].toBigInt()).toBe(receivedAmount);

        const bobTokenNote = await wallet.getNotes({
          scopes: [bob],
          contractAddress: token.address,
        });
        expectUintNote(bobTokenNote[0], receivedAmount, bob);

        await expectTokenBalances(token, bob, wad(0), receivedAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - receivedAmount,
          bob,
        );
      });

      it("claim with amount equal to u128 max value should work", async () => {
        // When calculating the the vested amount in the linear vesting schedule, we use bignum to avoid overflow
        // This test makes sure the bignum works correctly by testing what would be the overflow case without bignum:
        // (total_amount * elapsed) = (U128_MAX * duration) > U128_MAX

        const newToken = (await deployTokenWithMinter(
          wallet,
          alice,
        )) as TokenContract;

        await newToken
          .withWallet(wallet)
          .methods.mint_to_private(escrow.address, U128_MAX)
          .send({ from: alice })
          .wait();

        const setupTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.setup_linear_vesting_escrow(
            bob,
            alice,
            newToken.address,
            start,
            duration,
            U128_MAX,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        // Assert initial balances
        await expectTokenBalances(newToken, bob, wad(0), wad(0));
        await expectTokenBalances(
          newToken,
          escrow.address,
          wad(0),
          U128_MAX,
          bob,
        );

        let totalClaimed = 0n;
        let previousTx = setupTx;
        let claimCount = 0;

        while (totalClaimed < U128_MAX) {
          claimCount++;

          // Use the timestamp from the PREVIOUS transaction for calculation
          const previousBlock = await node.getBlock(previousTx.blockNumber!);
          const claimTimestamp =
            previousBlock!.header.globalVariables.timestamp;

          // Get releasable amount to call claim function
          const [releasableAmount] = await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: bob });

          const claimTx = await linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, releasableAmount)
            .send({ from: bob })
            .wait();
          await newToken
            .withWallet(wallet)
            .methods.sync_private_state()
            .simulate({ from: bob });
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.sync_private_state()
            .simulate({ from: bob });

          // Calculate total vested amount up to the previous transaction's timestamp
          const totalVestedAmount =
            claimTimestamp > start
              ? ((BigInt(claimTimestamp) - BigInt(start)) * U128_MAX) /
                BigInt(duration)
              : 0n;

          // Cap at total amount if vesting period is complete
          const cappedVestedAmount =
            totalVestedAmount > U128_MAX ? U128_MAX : totalVestedAmount;

          // The amount received in this claim is the difference between total vested and previously claimed
          const receivedAmount = cappedVestedAmount - totalClaimed;
          totalClaimed += receivedAmount;

          // Check if vesting is complete
          const isVestingComplete = claimTimestamp >= start + duration;

          // We expect different number of notes based on vesting completion
          const notes = (
            await wallet.getNotes({
              contractAddress: newToken.address,
            })
          ).filter((note) => note.txHash.equals(claimTx.txHash));

          const releasedAmountNote = (
            await wallet.getNotes({
              scopes: [escrow.address],
              contractAddress: linearVestingEscrow.address,
              storageSlot: slotReleasedAmountNotes,
            })
          )[0].note;
          expect(releasedAmountNote.items[1].toBigInt()).toBe(
            cappedVestedAmount,
          );

          if (isVestingComplete) {
            // Final claim: 1 token note to Bob
            expect(notes.length).toBe(1);

            const bobTokenNote = (
              await wallet.getNotes({
                scopes: [bob],
                contractAddress: newToken.address,
              })
            ).filter((note) => note.txHash.equals(claimTx.txHash));
            expectUintNote(bobTokenNote[0], receivedAmount, bob);
          } else {
            // Partial claim: 2 token notes (escrow change tokens and bob withdrawal tokens)
            expect(notes.length).toBe(2);

            const escrowTokenNote = (
              await wallet.getNotes({
                scopes: [escrow.address],
                contractAddress: newToken.address,
              })
            ).filter((note) => note.txHash.equals(claimTx.txHash));
            expectUintNote(
              escrowTokenNote[0],
              U128_MAX - totalClaimed,
              escrow.address,
            );

            const bobTokenNote = (
              await wallet.getNotes({
                scopes: [bob],
                contractAddress: newToken.address,
              })
            ).filter((note) => note.txHash.equals(claimTx.txHash));
            expectUintNote(bobTokenNote[0], receivedAmount, bob);
          }

          // Update previousTx to current claim for next iteration
          previousTx = claimTx;

          // Final balance checks
          await expectTokenBalances(newToken, bob, wad(0), totalClaimed);
          await expectTokenBalances(
            newToken,
            escrow.address,
            wad(0),
            U128_MAX - totalClaimed,
            bob,
          );
        }

        // Be sure we had multiple claims
        expect(claimCount).toBeGreaterThan(1);
      });

      it("claim before the start time should transfer zero tokens", async () => {
        // We increment the start so the tokens are not claimable yet
        start = start + 10000n;

        const tx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        // Next claim tx will read previous tx timestamp
        const block = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Get releasable amount to call claim function
        const [releasableAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob });

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob })
          .wait();

        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);
      });
    });

    describe("part 2", () => {
      beforeAll(async () => {
        await setup();
      });

      let tx: FieldsOf<TxReceipt>;

      beforeEach(async () => {
        tx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);
      });

      it("claim executed multiple times should be successful", async () => {
        let totalClaimed = 0n;
        let previousTx = tx;
        let claimCount = 0;

        while (totalClaimed < AMOUNT) {
          claimCount++;

          // Use the timestamp from the PREVIOUS transaction for calculation
          const previousBlock = await node.getBlock(previousTx.blockNumber!);
          const claimTimestamp =
            previousBlock!.header.globalVariables.timestamp;

          // Get releasable amount to call claim function
          const [releasableAmount] = await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: bob });

          const claimTx = await linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, releasableAmount)
            .send({ from: bob })
            .wait();
          await token
            .withWallet(wallet)
            .methods.sync_private_state()
            .simulate({ from: bob });
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.sync_private_state()
            .simulate({ from: bob });

          // Calculate total vested amount up to the previous transaction's timestamp
          const totalVestedAmount =
            claimTimestamp > start
              ? ((BigInt(claimTimestamp) - BigInt(start)) * AMOUNT) /
                BigInt(duration)
              : 0n;

          // Cap at total amount if vesting period is complete
          const cappedVestedAmount =
            totalVestedAmount > AMOUNT ? AMOUNT : totalVestedAmount;

          // The amount received in this claim is the difference between total vested and previously claimed
          const receivedAmount = cappedVestedAmount - totalClaimed;
          totalClaimed += receivedAmount;

          // Check if vesting is complete
          const isVestingComplete = claimTimestamp >= start + duration;

          // We expect different number of notes based on vesting completion
          const notes = (
            await wallet.getNotes({
              contractAddress: token.address,
            })
          ).filter((note) => note.txHash.equals(claimTx.txHash));

          const releasedAmountNote = (
            await wallet.getNotes({
              scopes: [escrow.address],
              contractAddress: linearVestingEscrow.address,
              storageSlot: slotReleasedAmountNotes,
            })
          )[0].note;
          expect(releasedAmountNote.items[1].toBigInt()).toBe(
            cappedVestedAmount,
          );

          if (isVestingComplete) {
            // Final claim: 1 token note to Bob
            expect(notes.length).toBe(1);

            const bobTokenNote = (
              await wallet.getNotes({
                scopes: [bob],
                contractAddress: token.address,
              })
            ).filter((note) => note.txHash.equals(claimTx.txHash));
            expectUintNote(bobTokenNote[0], receivedAmount, bob);
          } else {
            // Partial claim: 2 token notes (escrow change tokens and bob withdrawal tokens)
            expect(notes.length).toBe(2);

            const escrowTokenNote = await wallet.getNotes({
              scopes: [escrow.address],
              contractAddress: token.address,
            });
            expectUintNote(
              escrowTokenNote[0],
              AMOUNT - totalClaimed,
              escrow.address,
            );

            const bobTokenNote = await wallet.getNotes({
              scopes: [bob],
              contractAddress: token.address,
            });
            expectUintNote(bobTokenNote[0], receivedAmount, bob);
          }

          // Update previousTx to current claim for next iteration
          previousTx = claimTx;

          // Final balance checks
          await expectTokenBalances(token, bob, wad(0), totalClaimed);
          await expectTokenBalances(
            token,
            escrow.address,
            wad(0),
            AMOUNT - totalClaimed,
            bob,
          );
        }

        // Be sure we had multiple claims
        expect(claimCount).toBeGreaterThan(1);
      });

      it("claim should fail if amount is greater than releasable amount", async () => {
        // Next claim tx will read previous tx timestamp
        const block = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Get releasable amount to call claim function
        const [releasableAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob });

        // Claim amount too high error
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, releasableAmount * 2n)
            .send({ from: bob })
            .wait(),
        ).rejects.toThrow(/claim amount too high/);
      });

      it("final claim should not allow further claims", async () => {
        const block = await node.getBlock(tx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice })
          .wait();

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob })
          .wait();

        // Try to claim again should fail
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, 1n)
            .send({ from: bob })
            .wait(),
        ).rejects.toThrow(/Claim already completed/);
      });
    });

    describe("part 3", () => {
      beforeAll(async () => {
        await setup();
      });

      beforeEach(async () => {
        // We set the duration to 1000 to make the tokens partially claimable
        duration = 1000n;
      });

      it("final claim should transfer the tokens to the recipient and emit corresponding notes", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

        const block = await node.getBlock(setupTx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice })
          .wait();

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob })
          .wait();

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        const releasedAmountNote = (
          await wallet.getNotes({
            scopes: [escrow.address],
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        )[0].note;

        expect(releasedAmountNote.items[1].toBigInt()).toBe(vestedAmount);
        // Claim completed
        expect(releasedAmountNote.items[2].toBigInt()).toBe(1n); // true is 1n in the contract

        // Assert final balances
        await expectTokenBalances(token, bob, wad(0), vestedAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - vestedAmount,
          bob,
        );
      });

      it("final claim with partially funded escrow should claim correctly", async () => {
        // We set the amount to 2x the AMOUNT to make the escrow partially funded
        const amount = AMOUNT * 2n;
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            amount,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

        const block = await node.getBlock(setupTx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice })
          .wait();

        const finalClaimTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob })
          .wait();

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        const releasedAmountNote = (
          await wallet.getNotes({
            scopes: [escrow.address],
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        )[0].note;

        expect(releasedAmountNote.items[1].toBigInt()).toBe(vestedAmount);
        // Claim completed
        expect(releasedAmountNote.items[2].toBigInt()).toBe(1n); // true is 1n in the contract

        // Assert final balances
        await expectTokenBalances(token, bob, wad(0), vestedAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - vestedAmount,
          bob,
        );
      });

      it("final claim should fail if the caller is not the recipient", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        const block = await node.getBlock(setupTx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice })
          .wait();

        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, releasableAmount)
            .send({ from: alice })
            .wait(),
        ).rejects.toThrow(/caller is not recipient/);
      });

      it("final claim should fail if amount is greater than releasable amount", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        const block = await node.getBlock(setupTx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice })
          .wait();

        // We test the edge case where the claim amount is greater than the releasable amount by 1
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, releasableAmount + 1n)
            .send({ from: bob })
            .wait(),
        ).rejects.toThrow(/claim amount too high/);
      });
    });
  });

  describe("stop_vesting", () => {
    beforeAll(async () => {
      await setup();
    });

    let tx: FieldsOf<TxReceipt>;

    beforeEach(async () => {
      tx = await linearVestingEscrow.methods
        .setup_linear_vesting_escrow(
          bob,
          alice,
          token.address,
          start,
          duration,
          AMOUNT,
          secretKeys,
        )
        .send({ from: alice })
        .wait();
    });

    it("stop vesting should stop the vesting and emit correct vesting schedule note", async () => {
      // Sync to get linear vesting escrow note
      await linearVestingEscrow
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: alice });

      const setupEscrowNote = (
        await wallet.getNotes({
          scopes: [escrow.address],
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotEscrowNotes,
        })
      )[0].note;

      // Stop vesting
      const stopVestingTimestamp = start + duration;
      const stopVestingTx = await linearVestingEscrow
        .withWallet(wallet)
        .methods.stop_vesting(escrow.address, stopVestingTimestamp)
        .send({ from: alice })
        .wait();

      // Sync to get linear vesting escrow note
      await linearVestingEscrow
        .withWallet(wallet)
        .methods.sync_private_state()
        .simulate({ from: alice });

      const stopVestingEscrowNote = (
        await wallet.getNotes({
          scopes: [escrow.address],
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotEscrowNotes,
        })
      )[0].note;

      // We expect the same values for both notes except the stop timestamp
      expect(setupEscrowNote.items[0].toString()).toBe(
        stopVestingEscrowNote.items[0].toString(),
      );
      expect(setupEscrowNote.items[1].toString()).toBe(
        stopVestingEscrowNote.items[1].toString(),
      );
      expect(setupEscrowNote.items[2].toString()).toBe(
        stopVestingEscrowNote.items[2].toString(),
      );
      expect(setupEscrowNote.items[3].toString()).toBe(
        stopVestingEscrowNote.items[3].toString(),
      );
      expect(setupEscrowNote.items[4].toBigInt()).toBe(
        stopVestingEscrowNote.items[4].toBigInt(),
      );
      expect(setupEscrowNote.items[5].toBigInt()).toBe(
        stopVestingEscrowNote.items[5].toBigInt(),
      );
      expect(setupEscrowNote.items[6].toBigInt()).toBe(
        stopVestingEscrowNote.items[6].toBigInt(),
      );
      // Stop timestamp was set to the stop vesting timestamp
      expect(stopVestingEscrowNote.items[7].toBigInt()).toBe(
        stopVestingTimestamp,
      );
    });

    it("stop vesting should fail if the caller is not the reclaimer", async () => {
      // Stop vesting should fail if the caller is not the reclaimer
      const stopVestingTimestamp = start + duration;
      await expect(
        linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: bob })
          .wait(),
      ).rejects.toThrow(/caller is not reclaimer/);
    });

    it("stop vesting should fail if already stopped", async () => {
      const stopVestingTimestamp = start + duration;

      // Stop vesting for the first time
      await linearVestingEscrow
        .withWallet(wallet)
        .methods.stop_vesting(escrow.address, stopVestingTimestamp)
        .send({ from: alice })
        .wait();

      // Stop vesting should fail if the vesting is already stopped
      await expect(
        linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice })
          .wait(),
      ).rejects.toThrow(/Vesting schedule is not active/);
    });

    it("stop vesting should fail if stop timestamp is lower than block timestamp", async () => {
      // Stop vesting time is incorrect, lower that block timestamp
      const stopVestingTimestamp = start;
      await expect(
        linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice })
          .wait(),
      ).rejects.toThrow(/app_logic_reverted/);
    });
  });

  describe("clawback", () => {
    describe("part 1", () => {
      beforeAll(async () => {
        await setup();
      });

      let tx: FieldsOf<TxReceipt>;
      beforeEach(async () => {
        tx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);
      });

      it("clawback successfully when escrow is fully funded and there's still releasable amount", async () => {
        const block = await node.getBlock(tx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice })
          .wait();

        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: alice });
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // Assert notes
        const notes = (
          await wallet.getNotes({
            contractAddress: token.address,
          })
        ).filter((note) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(2);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
      });

      it("clawback successfully when escrow was fully funded and there's no releasable amount (after final claim)", async () => {
        const block = await node.getBlock(tx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        // releasableAmount here is not 0, it will be after the claim transaction
        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        // Bob claims the releasable amount, making the releasable amount 0 for the clawback transaction
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob })
          .wait();
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // releasableAmount should be 0 after the claim transaction
        const [releasableAmountAfterClaim, _] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        expect(releasableAmountAfterClaim).toBe(0n);

        // Assert post-claim balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
          bob,
        );

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice })
          .wait();

        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: alice });
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // Assert notes
        const notes = (
          await wallet.getNotes({
            contractAddress: token.address,
          })
        ).filter((note) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(1);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
      });

      it("clawback successfully when escrow was fully funded and there's still releasable amount (after final partial claim)", async () => {
        const block = await node.getBlock(tx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        // releasableAmount here is not 0, it will be after the claim transaction
        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        // Bob claims the releasable amount, making the releasable amount 0 for the clawback transaction
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount / 2n)
          .send({ from: bob })
          .wait();
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // releasableAmount should be 0 after the claim transaction
        const [releasableAmountAfterClaim, _] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        expect(releasableAmountAfterClaim).toBe(releasableAmount / 2n);

        // Assert post-claim balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount / 2n);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount / 2n,
          bob,
        );

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice })
          .wait();

        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: alice });
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // Assert notes
        const notes = (
          await wallet.getNotes({
            contractAddress: token.address,
          })
        ).filter((note) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(2);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
      });

      it("clawback should fail if the caller is not the reclaimer", async () => {
        // Clawback should fail if the caller is not the reclaimer
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, AMOUNT)
            .send({ from: bob })
            .wait(),
        ).rejects.toThrow(/caller is not reclaimer/);
      });

      it("clawback should fail the escrow vesting is still active", async () => {
        // Clawback should fail if the vesting is still active
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, AMOUNT)
            .send({ from: alice })
            .wait(),
        ).rejects.toThrow(/Vesting schedule is active/);
      });
    });

    describe("part 2", () => {
      beforeAll(async () => {
        await setup();
      });

      let amount: bigint;
      beforeEach(async () => {
        // Increase the duration due to multiple transaction follows
        duration = 1000n;
        // We set the amount to 2x the AMOUNT to make the escrow not fully funded
        amount = AMOUNT * 2n;
      });

      it("clawback should transfer zero tokens if the reclaimer amount is zero", async () => {
        const tx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        const block = await node.getBlock(tx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        const [releasableAmount, _] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, 0n)
          .send({ from: alice })
          .wait();

        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
          bob,
        );
      });

      it("clawback successfully: escrow is not fully funded, releasable amount > 0", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            amount,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        const block = await node.getBlock(setupTx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        const clawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice })
          .wait();

        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: alice });
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // Assert notes
        const notes = (
          await wallet.getNotes({
            contractAddress: token.address,
          })
        ).filter((note) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(2);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
      });

      it("clawback successfully: escrow is not fully funded, releasable amount == 0", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            amount,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        const block = await node.getBlock(setupTx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        const clawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

        // Bob claims the releasable amount
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob })
          .wait();
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // Assert post-claim balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
          bob,
        );

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice })
          .wait();

        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: alice });
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // Assert notes
        const notes = (
          await wallet.getNotes({
            contractAddress: token.address,
          })
        ).filter((note) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(1);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
      });

      it("claiming after clawback should fail", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        const block = await node.getBlock(setupTx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        const clawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

        // Clawback
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice })
          .wait();

        // Claiming after clawback should fail because claim completed is true
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, 1n)
            .send({ from: bob })
            .wait(),
        ).rejects.toThrow(/Claim already completed/);
      });
    });

    describe("multiple clawbacks", () => {
      beforeAll(async () => {
        await setup();
      });

      let tx: FieldsOf<TxReceipt>;
      beforeEach(async () => {
        tx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice })
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);
      });

      it("release amount note is correctly created and emitted", async () => {
        const block = await node.getBlock(tx.blockNumber!);
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        const [_, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice })
          .wait();

        // Assert released amount note
        const releasedAmountNote = (
          await wallet.getNotes({
            scopes: [escrow.address],
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        ).filter((note) => note.txHash.equals(clawbackTx.txHash))[0].note;

        // Assert released amount is vested amount and claim completed is true
        expect(releasedAmountNote.items[1].toBigInt()).toBe(vestedAmount);
        expect(releasedAmountNote.items[2].toBigInt()).toBe(1n);
      });

      it("reclaimer can split clawback amount across multiple transactions", async () => {
        const block = await node.getBlock(tx.blockNumber!);
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        const totalClawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

        // First clawback - claim half of the reclaimer's amount
        const firstClawbackAmount = totalClawbackAmount / 2n;
        const clawbackTx1 = await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, firstClawbackAmount)
          .send({ from: alice })
          .wait();

        // Assert released amount note
        const releasedAmountNote = (
          await wallet.getNotes({
            scopes: [escrow.address],
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        ).filter((note) => note.txHash.equals(clawbackTx1.txHash))[0].note;

        expect(releasedAmountNote.items[1].toBigInt()).toBe(vestedAmount);
        expect(releasedAmountNote.items[2].toBigInt()).toBe(1n);

        // After first clawback: alice got firstClawbackAmount, bob got releasableAmount
        await expectTokenBalances(token, alice, wad(0), firstClawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - firstClawbackAmount - releasableAmount,
          bob,
        );

        // Second clawback - claim the remaining amount
        const secondClawbackAmount = totalClawbackAmount - firstClawbackAmount;
        const clawbackTx2 = await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, secondClawbackAmount)
          .send({ from: alice })
          .wait();

        // Assert released amount note
        const releasedAmountNote2 = (
          await wallet.getNotes({
            scopes: [escrow.address],
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        ).filter((note) => note.txHash.equals(clawbackTx2.txHash))[0].note;

        expect(releasedAmountNote2.items[1].toBigInt()).toBe(vestedAmount);
        expect(releasedAmountNote2.items[2].toBigInt()).toBe(1n);

        // Assert final balances - alice has full clawback amount, bob has releasable amount
        await expectTokenBalances(token, alice, wad(0), totalClawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);
      });

      it("reclaimer can do multiple clawbacks after recipient has already claimed", async () => {
        const block = await node.getBlock(tx.blockNumber!);
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice });

        // Bob claims his releasable amount first
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob })
          .wait();

        const totalClawbackAmount = AMOUNT - vestedAmount;

        // Assert post-claim balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
          bob,
        );

        // First clawback - claim 1/2 of the reclaimer's amount
        const firstClawbackAmount = totalClawbackAmount / 2n;
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, firstClawbackAmount)
          .send({ from: alice })
          .wait();

        await expectTokenBalances(token, alice, wad(0), firstClawbackAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount - firstClawbackAmount,
          bob,
        );

        // Second clawback - claim another 1/2
        const secondClawbackAmount = totalClawbackAmount / 2n;
        const clawbackTx2 = await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, secondClawbackAmount)
          .send({ from: alice })
          .wait();

        await expectTokenBalances(
          token,
          alice,
          wad(0),
          firstClawbackAmount + secondClawbackAmount,
        );

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), totalClawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(token, escrow.address, wad(0), wad(0), bob);

        // Assert released amount note
        const releasedAmountNote2 = (
          await wallet.getNotes({
            scopes: [escrow.address],
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        ).filter((note) => note.txHash.equals(clawbackTx2.txHash))[0].note;

        expect(releasedAmountNote2.items[1].toBigInt()).toBe(vestedAmount);
        expect(releasedAmountNote2.items[2].toBigInt()).toBe(1n);
      });
    });
  });

  describe("releasable and vested amount", () => {
    beforeAll(async () => {
      await setup();
    });

    it("releasable and vested amount should be correct with multiple claims", async () => {
      const tx = await linearVestingEscrow
        .withWallet(wallet)
        .methods.setup_linear_vesting_escrow(
          bob,
          alice,
          token.address,
          start,
          duration,
          AMOUNT,
          secretKeys,
        )
        .send({ from: alice })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT, bob);

      let totalClaimed = 0n;
      let previousTx = tx;
      let claimCount = 0;

      while (totalClaimed < AMOUNT) {
        claimCount++;

        // Get timestamp from the previous transaction for calculation
        const previousBlock = await node.getBlock(previousTx.blockNumber!);
        const claimTimestamp = previousBlock!.header.globalVariables.timestamp;

        // Utility functions
        const [utilityReleasable, utilityVested] = await linearVestingEscrow
          .withWallet(wallet)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob });

        // Calculate expected values
        const totalVestedAmount =
          claimTimestamp > start
            ? ((BigInt(claimTimestamp) - BigInt(start)) * AMOUNT) /
              BigInt(duration)
            : 0n;

        const cappedVestedAmount =
          totalVestedAmount > AMOUNT ? AMOUNT : totalVestedAmount;

        const receivedAmount = cappedVestedAmount - totalClaimed;
        totalClaimed += receivedAmount;

        // Verify utility functions match
        expect(utilityVested).toBe(cappedVestedAmount);
        expect(utilityReleasable).toBe(receivedAmount);

        // Now make the claim
        const claimTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, utilityReleasable)
          .send({ from: bob })
          .wait();
        await token
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.sync_private_state()
          .simulate({ from: bob });

        // Check if vesting is complete
        const isVestingComplete = claimTimestamp >= start + duration;

        // We expect different number of notes based on vesting completion
        const notes = (
          await wallet.getNotes({
            contractAddress: token.address,
          })
        ).filter((note) => note.txHash.equals(claimTx.txHash));

        const releasedAmountNote = (
          await wallet.getNotes({
            scopes: [escrow.address],
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        )[0].note;
        expect(releasedAmountNote.items[1].toBigInt()).toBe(utilityVested);

        if (isVestingComplete) {
          // Final claim: 1 token note to Bob
          expect(notes.length).toBe(1);

          const bobTokenNote = (
            await wallet.getNotes({
              scopes: [bob],
              contractAddress: token.address,
            })
          ).filter((note) => note.txHash.equals(claimTx.txHash));
          expectUintNote(bobTokenNote[0], utilityReleasable, bob);
        } else {
          // Partial claim: 2 token notes (escrow change tokens and bob withdrawal tokens)
          expect(notes.length).toBe(2);

          const escrowTokenNote = (
            await wallet.getNotes({
              scopes: [escrow.address],
              contractAddress: token.address,
            })
          ).filter((note) => note.txHash.equals(claimTx.txHash));
          expectUintNote(
            escrowTokenNote[0],
            AMOUNT - totalClaimed,
            escrow.address,
          );

          const bobTokenNote = (
            await wallet.getNotes({
              scopes: [bob],
              contractAddress: token.address,
            })
          ).filter((note) => note.txHash.equals(claimTx.txHash));
          expectUintNote(bobTokenNote[0], utilityReleasable, bob);
        }

        // Update previousTx to current claim for next iteration
        previousTx = claimTx;

        // Final balance checks
        await expectTokenBalances(token, bob, wad(0), totalClaimed);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - totalClaimed,
          bob,
        );
      }

      // Be sure we had multiple claims
      expect(claimCount).toBeGreaterThan(1);
    });
  });
});

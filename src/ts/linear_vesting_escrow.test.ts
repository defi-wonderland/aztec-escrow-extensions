import { siloNullifier } from "@aztec/stdlib/hash";
import { FieldsOf } from "@aztec/foundation/types";
import { type AztecNode } from "@aztec/aztec.js/node";
import { type EmbeddedWallet } from "@aztec/wallets/embedded";
import { pedersenHash } from "@aztec/foundation/crypto/pedersen";
import { TxStatus, TxReceipt } from "@aztec/aztec.js/tx";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { deriveKeys, PublicKeys } from "@aztec/stdlib/keys";
import { ContractDeployer } from "@aztec/aztec.js/deployment";
import { Fr } from "@aztec/aztec.js/fields";
import { type Fq } from "@aztec/foundation/curves/bn254";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";
import {
  Contract,
  getContractInstanceFromInstantiationParams,
  type ContractInstanceWithAddress,
} from "@aztec/aztec.js/contracts";

import {
  LinearVestingEscrowLogicContract,
  LinearVestingEscrowLogicContractArtifact,
  EscrowDetailsLogContent,
} from "../artifacts/LinearVestingEscrowLogic.js";
import {
  EscrowContractArtifact,
  EscrowContract,
} from "@defi-wonderland/aztec-standards/dist/src/artifacts/Escrow.js";
import { TokenContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";

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
  deriveContractAddress,
  getWalletNotes,
  syncPXE,
} from "./utils.js";

describe("Linear Vesting Escrow", () => {
  let node: AztecNode;
  let cleanup: () => Promise<void>;

  let wallet: EmbeddedWallet;
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

  let start: bigint;
  let duration: bigint;

  const slotEscrowNotes = LinearVestingEscrowLogicContract.storage.escrows.slot;
  const slotReleasedAmountNotes =
    LinearVestingEscrowLogicContract.storage.released_notes.slot;

  const AZTEC_SLOT_TIME = 36n; // seconds
  const MAX_U64_VALUE = (1n << 64n) - 1n;

  beforeAll(async () => {
    // Setup test suite (one PXE for all tests to avoid LMDB reader exhaustion)
    ({ node, wallet, accounts, cleanup } = await setupTestSuite(
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

    // The contract now takes the secret key directly (not derived master secret keys)
    secretKey = escrowSk;
  });

  afterAll(async () => {
    await cleanup();
  });

  // Deploy fresh contracts before each test (each escrow can only be set up once due to nullifier)
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

    await token
      .withWallet(wallet)
      .methods.mint_to_private(escrow.address, AMOUNT)
      .send({ from: alice, additionalScopes: [escrow.address] });

    const blockNumber = await node.getBlockNumber();
    const block = await node.getBlock(blockNumber);
    start = block!.header.globalVariables.timestamp;
    duration = 200n;
  });

  describe("Deployment", () => {
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
        "constructor",
      );
      const deployResult = await deployer
        .deploy([escrowClassId], { salt })
        .send({
          from: alice,
        });
      const contract = deployResult.contract;

      const contractMetadata = await wallet.getContractMetadata(
        deploymentData.address,
      );
      expect(contractMetadata).toBeDefined();

      expect(contract.address).toEqual(deploymentData.address);
    });

    it("deploys escrow with correctly derived address", async () => {
      const { address, initializationHash } = await deriveContractAddress(
        EscrowContractArtifact,
        [], // constructor args are null
        AztecAddress.ZERO, // deployer is null
        escrowSalt,
        escrowKeys.publicKeys,
      );

      const escrowInstance = (await node.getContract(
        escrow.address,
      )) as ContractInstanceWithAddress;

      expect(address).toEqual(escrow.address);
      expect(initializationHash).toEqual(Fr.ZERO);
      expect(initializationHash).toEqual(escrowInstance.initializationHash);
    });
  });

  describe("setup_linear_vesting_escrow", () => {
    let tx: FieldsOf<TxReceipt>;

    beforeEach(async () => {
      const sendResult = await linearVestingEscrow
        .withWallet(wallet)
        .methods.setup_linear_vesting_escrow(
          bob,
          alice,
          token.address,
          start,
          duration,
          AMOUNT,
          secretKey,
        )
        .send({ from: alice, additionalScopes: [escrow.address] });
      tx = sendResult.receipt;
    });

    it("creates linear vesting escrow shares escrow with bob correctly", async () => {
      const blockNumber = tx.blockNumber!;

      const events = await wallet.getPrivateEvents<EscrowDetailsLogContent>(
        LinearVestingEscrowLogicContract.events.EscrowDetailsLogContent,
        {
          contractAddress: linearVestingEscrow.address,
          fromBlock: blockNumber,
          scopes: [bob],
        },
      );

      expect(events.length).toBe(1);

      const event = events[0].event;

      expect(event.escrow).toEqual(escrow.address);
      expect(event.secret_key).toEqual(escrowSk.toBigInt());
    });

    it("creates linear vesting escrow should create a correct linearVestingEscrow note", async () => {
      await syncPXE(wallet);

      const notes = await getWalletNotes(wallet, {
        contractAddress: linearVestingEscrow.address,
        additionalScopes: [escrow.address],
      });

      // We expect 2 notes: 1 for the linear vesting escrow and 1 for the released amount
      expect(notes.length).toBe(2);

      const escrowNotes = (
        await getWalletNotes(wallet, {
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotEscrowNotes,
          additionalScopes: [escrow.address],
        })
      )[0].note;
      const releasedAmountNotes = (
        await getWalletNotes(wallet, {
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotReleasedAmountNotes,
          additionalScopes: [escrow.address],
        })
      )[0].note;

      expect(escrowNotes.items[0].toString()).toBe(bob.toString());
      expect(escrowNotes.items[1].toString()).toBe(alice.toString());
      expect(escrowNotes.items[2].toString()).toBe(token.address.toString());
      expect(escrowNotes.items[3].toBigInt()).toBe(BigInt(start));
      expect(escrowNotes.items[4].toBigInt()).toBe(BigInt(duration));
      expect(escrowNotes.items[5].toBigInt()).toBe(BigInt(AMOUNT));

      expect(releasedAmountNotes.items[0].toBigInt()).toBe(BigInt(0));
    });

    it("creates linear vesting escrow should emit a nullifier for the escrow", async () => {
      const nullifier = await pedersenHash([escrow.address]);
      const siloedNullifier = await siloNullifier(
        linearVestingEscrow.address,
        nullifier,
      );

      const txReceipt = await node.getTxReceipt(tx.txHash);
      expect([
        TxStatus.CHECKPOINTED,
        TxStatus.PROVEN,
        TxStatus.FINALIZED,
      ]).toContain(txReceipt.status);

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
            secretKey,
          )
          .send({ from: alice, additionalScopes: [escrow.address] }),
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
            secretKey,
          )
          .send({ from: alice, additionalScopes: [escrow.address] }),
      ).rejects.toThrow(
        "Assertion failed: attempt to add with overflow 'start + duration'",
      );
    });
  });

  describe("claim", () => {
    // Split in 3 parts due to memory limit of the store
    describe("part 1", () => {
      it("claim should transfer the tokens to the recipient and emit one note (token note)", async () => {
        // We set the duration to 1 to make the tokens fully claimable
        duration = 1n;

        const tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Next claim tx will read previous tx timestamp
        const setupBlock = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = setupBlock!.header.globalVariables.timestamp;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0), bob);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        // Get releasable amount to call claim function
        const [releasableAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Bob claims the full amount
        const bobtx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob, additionalScopes: [escrow.address] });

        // Assert that bob received the note
        const notes = await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        });
        expect(notes.length).toBe(1);
        expectUintNote(notes[0].note, AMOUNT, bob);

        // Assert that tokens were effectively transferred
        await expectTokenBalances(token, bob, wad(0), AMOUNT, bob);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("claim should transfer the tokens partially to the recipient and emit 3 notes (tokens and released amount note)", async () => {
        // We set the duration to 1000 to make the tokens partially claimable
        duration = 1000n;

        const tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Next claim tx will read previous tx timestamp
        const block = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        // Get releasable amount to call claim function
        const [releasableAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        const claimTxResult = await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob, additionalScopes: [escrow.address] });
        const claimTx = claimTxResult.receipt;
        await syncPXE(wallet);

        // Use releasableAmount as the actual claimed amount (timestamp-independent)
        const receivedAmount = releasableAmount as bigint;

        // We expect a released amount note
        const notes = await getWalletNotes(wallet, {
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotReleasedAmountNotes,
          additionalScopes: [escrow.address],
        });
        expect(notes.length).toBe(1);

        const claimTokenNotes = (
          await getWalletNotes(wallet, {
            contractAddress: token.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(claimTx.txHash));

        // Find notes by value: one is the escrow change, one is bob's received tokens
        const escrowChangeNote = claimTokenNotes.find(
          (n: any) => n.note.items[0].toBigInt() === AMOUNT - receivedAmount,
        );
        const bobReceivedNote = claimTokenNotes.find(
          (n: any) => n.note.items[0].toBigInt() === receivedAmount,
        );
        expect(escrowChangeNote).toBeDefined();
        expect(bobReceivedNote).toBeDefined();

        const releasedAmountNote = (
          await getWalletNotes(wallet, {
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
            additionalScopes: [escrow.address],
          })
        )[0].note;
        expect(releasedAmountNote.items[0].toBigInt()).toBe(receivedAmount);

        await expectTokenBalances(token, bob, wad(0), receivedAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - receivedAmount,
          escrow.address,
        );
      });

      it("claim with amount equal to u128 max value should work", async () => {
        // When calculating the the vested amount in the linear vesting schedule, we use bignum to avoid overflow
        // This test makes sure the bignum works correctly by testing what would be the overflow case without bignum:
        // (total_amount * elapsed) = (U128_MAX * duration) > U128_MAX

        // Use a longer duration to ensure multiple claims are needed (blocks advance by ~72s each)
        duration = 1000n;

        const newToken = (await deployTokenWithMinter(
          wallet,
          alice,
        )) as TokenContract;

        await newToken
          .withWallet(wallet)
          .methods.mint_to_private(escrow.address, U128_MAX)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const setupTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              newToken.address,
              start,
              duration,
              U128_MAX,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(newToken, bob, wad(0), wad(0));
        await expectTokenBalances(
          newToken,
          escrow.address,
          wad(0),
          U128_MAX,
          escrow.address,
        );

        let totalClaimed = 0n;
        let previousTx: FieldsOf<TxReceipt> = setupTx;
        let claimCount = 0;

        while (totalClaimed < U128_MAX) {
          claimCount++;

          // Use the timestamp from the PREVIOUS transaction for calculation
          const previousBlock = await node.getBlock(previousTx.blockNumber!);
          const claimTimestamp =
            previousBlock!.header.globalVariables.timestamp;

          // Get releasable amount to call claim function
          const [releasableAmount] = (
            await linearVestingEscrow
              .withWallet(wallet)
              .methods.releasable_and_vested_amounts(
                escrow.address,
                claimTimestamp,
              )
              .simulate({ from: escrow.address })
          ).result;

          const claimTx = (
            await linearVestingEscrow
              .withWallet(wallet)
              .methods.claim(escrow.address, releasableAmount)
              .send({ from: bob, additionalScopes: [escrow.address] })
          ).receipt;
          await syncPXE(wallet);

          // Use releasableAmount from simulate as the actual claimed amount (timestamp-independent)
          const receivedAmount = releasableAmount as bigint;
          totalClaimed += receivedAmount;

          // Check if vesting is complete
          const isVestingComplete = claimTimestamp >= start + duration;

          // The capped vested amount is totalClaimed so far
          const cappedVestedAmount = totalClaimed;

          // We expect different number of notes based on vesting completion
          const notes = (
            await getWalletNotes(wallet, {
              contractAddress: newToken.address,
              additionalScopes: [escrow.address],
            })
          ).filter((note: any) => note.txHash.equals(claimTx.txHash));

          const releasedAmountNote = (
            await getWalletNotes(wallet, {
              contractAddress: linearVestingEscrow.address,
              storageSlot: slotReleasedAmountNotes,
              additionalScopes: [escrow.address],
            })
          )[0].note;
          expect(releasedAmountNote.items[0].toBigInt()).toBe(
            cappedVestedAmount,
          );

          if (isVestingComplete) {
            // Final claim: 1 token note to Bob
            expect(notes.length).toBe(1);

            const bobTokenNote = (
              await getWalletNotes(wallet, {
                contractAddress: newToken.address,
                additionalScopes: [escrow.address],
              })
            ).filter((note: any) => note.txHash.equals(claimTx.txHash));
            expectUintNote(bobTokenNote[0].note, receivedAmount, bob);
          } else {
            // Partial claim: 2 token notes (escrow change tokens and bob withdrawal tokens)
            expect(notes.length).toBe(2);

            const claimTokenNotes = (
              await getWalletNotes(wallet, {
                contractAddress: newToken.address,
                additionalScopes: [escrow.address],
              })
            ).filter((note: any) => note.txHash.equals(claimTx.txHash));

            // Find notes by value
            const escrowChangeNote = claimTokenNotes.find(
              (n: any) =>
                n.note.items[0].toBigInt() === U128_MAX - totalClaimed,
            );
            const bobReceivedNote = claimTokenNotes.find(
              (n: any) => n.note.items[0].toBigInt() === receivedAmount,
            );
            expect(escrowChangeNote).toBeDefined();
            expect(bobReceivedNote).toBeDefined();
            expectUintNote(
              escrowChangeNote!.note,
              U128_MAX - totalClaimed,
              escrow.address,
            );
            expectUintNote(bobReceivedNote!.note, receivedAmount, bob);
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
            escrow.address,
          );
        }

        // Be sure we had multiple claims
        expect(claimCount).toBeGreaterThan(1);
      });

      it("claim before the start time should transfer zero tokens", async () => {
        // We increment the start so the tokens are not claimable yet
        start = start + 10000n;

        const tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Next claim tx will read previous tx timestamp
        const block = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Get releasable amount to call claim function
        const [releasableAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob, additionalScopes: [escrow.address] });

        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );
      });
    });

    describe("part 2", () => {
      let tx: FieldsOf<TxReceipt>;

      beforeEach(async () => {
        tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );
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
          const [releasableAmount] = (
            await linearVestingEscrow
              .withWallet(wallet)
              .methods.releasable_and_vested_amounts(
                escrow.address,
                claimTimestamp,
              )
              .simulate({ from: escrow.address })
          ).result;

          const claimTx = (
            await linearVestingEscrow
              .withWallet(wallet)
              .methods.claim(escrow.address, releasableAmount)
              .send({ from: bob, additionalScopes: [escrow.address] })
          ).receipt;
          await syncPXE(wallet);

          // Use releasableAmount from simulate as the actual claimed amount (timestamp-independent)
          const receivedAmount = releasableAmount as bigint;
          totalClaimed += receivedAmount;

          // Check if vesting is complete
          const isVestingComplete = claimTimestamp >= start + duration;

          // The capped vested amount is totalClaimed so far
          const cappedVestedAmount = totalClaimed;

          // We expect different number of notes based on vesting completion
          const notes = (
            await getWalletNotes(wallet, {
              contractAddress: token.address,
              additionalScopes: [escrow.address],
            })
          ).filter((note: any) => note.txHash.equals(claimTx.txHash));

          const releasedAmountNote = (
            await getWalletNotes(wallet, {
              contractAddress: linearVestingEscrow.address,
              storageSlot: slotReleasedAmountNotes,
              additionalScopes: [escrow.address],
            })
          )[0].note;
          expect(releasedAmountNote.items[0].toBigInt()).toBe(
            cappedVestedAmount,
          );

          if (isVestingComplete) {
            // Final claim: 1 token note to Bob
            expect(notes.length).toBe(1);

            const bobTokenNote = (
              await getWalletNotes(wallet, {
                contractAddress: token.address,
                additionalScopes: [escrow.address],
              })
            ).filter((note: any) => note.txHash.equals(claimTx.txHash));
            expectUintNote(bobTokenNote[0].note, receivedAmount, bob);
          } else {
            // Partial claim: 2 token notes (escrow change tokens and bob withdrawal tokens)
            expect(notes.length).toBe(2);

            const claimTokenNotes = (
              await getWalletNotes(wallet, {
                contractAddress: token.address,
                additionalScopes: [escrow.address],
              })
            ).filter((note: any) => note.txHash.equals(claimTx.txHash));

            // Find notes by value
            const escrowChangeNote = claimTokenNotes.find(
              (n: any) => n.note.items[0].toBigInt() === AMOUNT - totalClaimed,
            );
            const bobReceivedNote = claimTokenNotes.find(
              (n: any) => n.note.items[0].toBigInt() === receivedAmount,
            );
            expect(escrowChangeNote).toBeDefined();
            expect(bobReceivedNote).toBeDefined();
            expectUintNote(
              escrowChangeNote!.note,
              AMOUNT - totalClaimed,
              escrow.address,
            );
            expectUintNote(bobReceivedNote!.note, receivedAmount, bob);
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
            escrow.address,
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
        const [releasableAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Claim amount too high error
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, releasableAmount * 2n)
            .send({ from: bob, additionalScopes: [escrow.address] }),
        ).rejects.toThrow(/claim amount too high/);
      });

      it("final claim should not allow further claims", async () => {
        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopVestingTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        const [releasableAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopVestingTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob, additionalScopes: [escrow.address] });

        // Try to claim again should fail
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, 1n)
            .send({ from: bob, additionalScopes: [escrow.address] }),
        ).rejects.toThrow(/Claim already completed/);
      });
    });

    describe("part 3", () => {
      beforeEach(async () => {
        // We set the duration to 1000 to make the tokens partially claimable
        duration = 1000n;
      });

      it("final claim should transfer the tokens to the recipient and emit corresponding notes", async () => {
        const setupTx = (
          await linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopVestingTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopVestingTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob, additionalScopes: [escrow.address] });

        await syncPXE(wallet);

        const releasedAmountNote = (
          await getWalletNotes(wallet, {
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
            additionalScopes: [escrow.address],
          })
        )[0].note;

        expect(releasedAmountNote.items[0].toBigInt()).toBe(vestedAmount);
        // Claim completed
        expect(releasedAmountNote.items[1].toBigInt()).toBe(1n); // true is 1n in the contract

        // Assert final balances
        await expectTokenBalances(token, bob, wad(0), vestedAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - vestedAmount,
          escrow.address,
        );
      });

      it("final claim with partially funded escrow should claim correctly", async () => {
        // We set the amount to 2x the AMOUNT to make the escrow partially funded
        // Use a large duration so vested amount stays below funded balance
        duration = 10000n;
        const amount = AMOUNT * 2n;
        const setupTx = (
          await linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              amount,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopVestingTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopVestingTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const finalClaimTx = await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob, additionalScopes: [escrow.address] });

        await syncPXE(wallet);

        const releasedAmountNote = (
          await getWalletNotes(wallet, {
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
            additionalScopes: [escrow.address],
          })
        )[0].note;

        expect(releasedAmountNote.items[0].toBigInt()).toBe(vestedAmount);
        // Claim completed
        expect(releasedAmountNote.items[1].toBigInt()).toBe(1n); // true is 1n in the contract

        // Assert final balances
        await expectTokenBalances(token, bob, wad(0), vestedAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - vestedAmount,
          escrow.address,
        );
      });

      it("final claim should fail if the caller is not the recipient", async () => {
        const setupTx = (
          await linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopVestingTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        const [releasableAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopVestingTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, releasableAmount)
            .send({ from: alice, additionalScopes: [escrow.address] }),
        ).rejects.toThrow(/caller is not recipient/);
      });

      it("final claim should fail if amount is greater than releasable amount", async () => {
        const setupTx = (
          await linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopVestingTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        const [releasableAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopVestingTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        // We test the edge case where the claim amount is greater than the releasable amount by 1
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, releasableAmount + 1n)
            .send({ from: bob, additionalScopes: [escrow.address] }),
        ).rejects.toThrow(/claim amount too high/);
      });
    });

    describe("timelock (duration = 0)", () => {
      beforeEach(async () => {
        // Set duration to 0 for timelock-like behavior
        duration = 0n;
      });

      it("claim before start time should transfer zero tokens", async () => {
        // Set start time in the future
        const blockNumber = await node.getBlockNumber();
        const block = await node.getBlock(blockNumber);
        start = block!.header.globalVariables.timestamp + 10000n;

        const tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        // Get timestamp from setup tx (before start time)
        const setupBlock = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = setupBlock!.header.globalVariables.timestamp;

        // Verify claim timestamp is before start
        expect(claimTimestamp).toBeLessThan(start);

        // Get releasable amount (should be 0)
        const [releasableAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        expect(releasableAmount).toBe(0n);

        // Claim with 0 amount
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, 0n)
          .send({ from: bob, additionalScopes: [escrow.address] });

        // Assert balances unchanged
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );
      });

      it("claim at start time should transfer full amount immediately", async () => {
        const tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        // Get timestamp from setup tx
        const setupBlock = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = setupBlock!.header.globalVariables.timestamp;

        // Verify claim timestamp is at or after start (duration = 0 means immediate unlock at start)
        expect(claimTimestamp).toBeGreaterThanOrEqual(start);

        // Get releasable amount (should be full AMOUNT since duration = 0)
        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        expect(releasableAmount).toBe(AMOUNT);
        expect(vestedAmount).toBe(AMOUNT);

        // Claim full amount
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, AMOUNT)
          .send({ from: bob, additionalScopes: [escrow.address] });

        // Assert bob received the note
        const notes = await getWalletNotes(wallet, {
          contractAddress: token.address,
          additionalScopes: [escrow.address],
        });
        expect(notes.length).toBe(1);
        expectUintNote(notes[0].note, AMOUNT, bob);

        // Assert final balances
        await expectTokenBalances(token, bob, wad(0), AMOUNT);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("claim after start time should transfer full amount", async () => {
        // Set start in the past
        const blockNumber = await node.getBlockNumber();
        const block = await node.getBlock(blockNumber);
        start = block!.header.globalVariables.timestamp - 100n;

        const tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        // Get timestamp from setup tx
        const setupBlock = await node.getBlock(tx.blockNumber!);
        const claimTimestamp = setupBlock!.header.globalVariables.timestamp;

        // Verify claim timestamp is after start
        expect(claimTimestamp).toBeGreaterThan(start);

        // Get releasable amount (should be full AMOUNT)
        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        expect(releasableAmount).toBe(AMOUNT);
        expect(vestedAmount).toBe(AMOUNT);

        // Claim full amount
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, AMOUNT)
          .send({ from: bob, additionalScopes: [escrow.address] });

        // Assert final balances
        await expectTokenBalances(token, bob, wad(0), AMOUNT);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("stop vesting and clawback with duration = 0 should work correctly", async () => {
        // Set start in the future so nothing is claimable yet
        const blockNumber = await node.getBlockNumber();
        const block = await node.getBlock(blockNumber);
        start = block!.header.globalVariables.timestamp + 10000n;

        const tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        // Get releasable and vested amounts at stop timestamp
        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Since stop timestamp is before start, vested and releasable should be 0
        expect(vestedAmount).toBe(0n);
        expect(releasableAmount).toBe(0n);

        // Clawback full amount (reclaimer gets everything since nothing vested)
        const clawbackTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, AMOUNT)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert token notes - 1 note (alice's clawback, no recipient withdrawal since releasable = 0)
        const notes = (
          await getWalletNotes(wallet, {
            contractAddress: token.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(1);

        // Assert final balances - alice gets everything
        await expectTokenBalances(token, alice, wad(0), AMOUNT);
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("stop vesting after start with duration = 0 should vest full amount", async () => {
        // Set start in the past so everything is immediately vested
        const blockNumber = await node.getBlockNumber();
        const block = await node.getBlock(blockNumber);
        start = block!.header.globalVariables.timestamp - 100n;

        const tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        // Get releasable and vested amounts at stop timestamp
        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Since stop timestamp is after start and duration = 0, everything is vested
        expect(vestedAmount).toBe(AMOUNT);
        expect(releasableAmount).toBe(AMOUNT);

        // Clawback with 0 reclaimer amount (recipient gets everything)
        const clawbackTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, 0n)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert token notes - 1 note (bob's releasable, no reclaimer withdrawal)
        const notes = (
          await getWalletNotes(wallet, {
            contractAddress: token.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(1);

        // Assert final balances - bob gets everything
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), AMOUNT);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });
    });
  });

  describe("stop_vesting", () => {
    let tx: FieldsOf<TxReceipt>;

    beforeEach(async () => {
      tx = (
        await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKey,
          )
          .send({ from: alice, additionalScopes: [escrow.address] })
      ).receipt;
    });

    it("stop vesting should stop the vesting and emit correct vesting schedule note", async () => {
      // Sync to get linear vesting escrow note
      await syncPXE(wallet);

      const setupEscrowNote = (
        await getWalletNotes(wallet, {
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotEscrowNotes,
          additionalScopes: [escrow.address],
        })
      )[0].note;

      // Stop vesting
      let currentBlockNumber = await node.getBlockNumber();
      let currentBlock = await node.getBlock(currentBlockNumber);
      const stopVestingTimestamp =
        currentBlock!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 20n;
      const stopVestingTx = await linearVestingEscrow
        .withWallet(wallet)
        .methods.stop_vesting(escrow.address, stopVestingTimestamp)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Sync to get linear vesting escrow note
      await syncPXE(wallet);

      const stopVestingEscrowNote = (
        await getWalletNotes(wallet, {
          contractAddress: linearVestingEscrow.address,
          storageSlot: slotEscrowNotes,
          additionalScopes: [escrow.address],
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
      // Stop timestamp was set to the stop vesting timestamp
      expect(stopVestingEscrowNote.items[6].toBigInt()).toBe(
        stopVestingTimestamp,
      );
    });

    it("stop vesting should fail if the caller is not the reclaimer", async () => {
      // Stop vesting should fail if the caller is not the reclaimer
      let currentBlockNumber = await node.getBlockNumber();
      let currentBlock = await node.getBlock(currentBlockNumber);
      const stopVestingTimestamp =
        currentBlock!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 20n;
      await expect(
        linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: bob, additionalScopes: [escrow.address] }),
      ).rejects.toThrow(/caller is not reclaimer/);
    });

    it("stop vesting should fail if already stopped", async () => {
      let currentBlockNumber = await node.getBlockNumber();
      let currentBlock = await node.getBlock(currentBlockNumber);
      const stopVestingTimestamp =
        currentBlock!.header.globalVariables.timestamp + AZTEC_SLOT_TIME * 20n;

      // Stop vesting for the first time
      await linearVestingEscrow
        .withWallet(wallet)
        .methods.stop_vesting(escrow.address, stopVestingTimestamp)
        .send({ from: alice, additionalScopes: [escrow.address] });

      // Stop vesting should fail if the vesting is already stopped
      await expect(
        linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] }),
      ).rejects.toThrow(/Vesting schedule is not active/);
    });

    it("stop vesting should fail if stop timestamp is lower than block timestamp", async () => {
      // Stop vesting time is incorrect, lower that block timestamp
      const stopVestingTimestamp = start;
      await expect(
        linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] }),
      ).rejects.toThrow(/Timestamp mismatch|app_logic_reverted/);
    });
  });

  describe("clawback", () => {
    describe("part 1", () => {
      let tx: FieldsOf<TxReceipt>;
      beforeEach(async () => {
        // Override duration to ensure partial vesting at current block time
        duration = 10000n;

        tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );
      });

      it("clawback successfully when escrow is fully funded and there's still releasable amount", async () => {
        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, clawbackAmount)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        await syncPXE(wallet);

        // Assert notes
        const notes = (
          await getWalletNotes(wallet, {
            contractAddress: token.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(2);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("clawback successfully when escrow was fully funded and there's no releasable amount (after final claim)", async () => {
        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        // releasableAmount here is not 0, it will be after the claim transaction
        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Bob claims the releasable amount, making the releasable amount 0 for the clawback transaction
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob, additionalScopes: [escrow.address] });
        await syncPXE(wallet);

        // releasableAmount should be 0 after the claim transaction
        const [releasableAmountAfterClaim, _] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        expect(releasableAmountAfterClaim).toBe(0n);

        // Assert post-claim balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
          escrow.address,
        );

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, clawbackAmount)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        await syncPXE(wallet);

        // Assert notes
        const notes = (
          await getWalletNotes(wallet, {
            contractAddress: token.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(1);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("clawback successfully when escrow was fully funded and there's still releasable amount (after final partial claim)", async () => {
        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        // releasableAmount here is not 0, it will be after the claim transaction
        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Bob claims the releasable amount, making the releasable amount 0 for the clawback transaction
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount / 2n)
          .send({ from: bob, additionalScopes: [escrow.address] });
        await syncPXE(wallet);

        // releasableAmount should be 0 after the claim transaction
        const [releasableAmountAfterClaim, _] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        expect(releasableAmountAfterClaim).toBe(releasableAmount / 2n);

        // Assert post-claim balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount / 2n);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount / 2n,
          escrow.address,
        );

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, clawbackAmount)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        await syncPXE(wallet);

        // Assert notes
        const notes = (
          await getWalletNotes(wallet, {
            contractAddress: token.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(2);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("clawback should fail if the caller is not the reclaimer", async () => {
        // Clawback should fail if the caller is not the reclaimer
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, AMOUNT)
            .send({ from: bob, additionalScopes: [escrow.address] }),
        ).rejects.toThrow(/caller is not reclaimer/);
      });

      it("clawback should fail the escrow vesting is still active", async () => {
        // Clawback should fail if the vesting is still active
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, AMOUNT)
            .send({ from: alice, additionalScopes: [escrow.address] }),
        ).rejects.toThrow(/Vesting schedule is active/);
      });
    });

    describe("part 2", () => {
      let amount: bigint;
      beforeEach(async () => {
        // Override duration to ensure partial vesting at current block time
        duration = 10000n;
        // We set the amount to 2x the AMOUNT to make the escrow not fully funded
        amount = AMOUNT * 2n;
      });

      it("clawback should transfer zero tokens if the reclaimer amount is zero", async () => {
        const tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const [releasableAmount, _] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, 0n)
          .send({ from: alice, additionalScopes: [escrow.address] });

        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
          escrow.address,
        );
      });

      it("clawback successfully: escrow is not fully funded, releasable amount > 0", async () => {
        const setupTx = (
          await linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              amount,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        const clawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        // Clawback
        const clawbackTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, clawbackAmount)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        await syncPXE(wallet);

        // Assert notes
        const notes = (
          await getWalletNotes(wallet, {
            contractAddress: token.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(2);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("clawback successfully: escrow is not fully funded, releasable amount == 0", async () => {
        const setupTx = (
          await linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              amount,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        const clawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        // Bob claims the releasable amount
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob, additionalScopes: [escrow.address] });
        await syncPXE(wallet);

        // Assert post-claim balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
          escrow.address,
        );

        // Clawback
        const clawbackTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, clawbackAmount)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        await syncPXE(wallet);

        // Assert notes
        const notes = (
          await getWalletNotes(wallet, {
            contractAddress: token.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx.txHash));
        expect(notes.length).toBe(1);

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), clawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("claiming after clawback should fail", async () => {
        const setupTx = (
          await linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        const clawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        // Clawback
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice, additionalScopes: [escrow.address] });

        // Claiming after clawback should fail because claim completed is true
        await expect(
          linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, 1n)
            .send({ from: bob, additionalScopes: [escrow.address] }),
        ).rejects.toThrow(/Claim already completed/);
      });
    });

    describe("multiple clawbacks", () => {
      let tx: FieldsOf<TxReceipt>;
      beforeEach(async () => {
        // Override duration to ensure partial vesting at current block time
        duration = 10000n;

        tx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.setup_linear_vesting_escrow(
              bob,
              alice,
              token.address,
              start,
              duration,
              AMOUNT,
              secretKey,
            )
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );
      });

      it("release amount note is correctly created and emitted", async () => {
        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const [_, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, clawbackAmount)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert released amount note
        const releasedAmountNote = (
          await getWalletNotes(wallet, {
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx.txHash))[0].note;

        // Assert released amount is vested amount and claim completed is true
        expect(releasedAmountNote.items[0].toBigInt()).toBe(vestedAmount);
        expect(releasedAmountNote.items[1].toBigInt()).toBe(1n);
      });

      it("reclaimer can split clawback amount across multiple transactions", async () => {
        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        const totalClawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), wad(0));
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT,
          escrow.address,
        );

        // First clawback - claim half of the reclaimer's amount
        const firstClawbackAmount = totalClawbackAmount / 2n;
        const clawbackTx1 = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, firstClawbackAmount)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert released amount note
        const releasedAmountNote = (
          await getWalletNotes(wallet, {
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx1.txHash))[0].note;

        expect(releasedAmountNote.items[0].toBigInt()).toBe(vestedAmount);
        expect(releasedAmountNote.items[1].toBigInt()).toBe(1n);

        // After first clawback: alice got firstClawbackAmount, bob got releasableAmount
        await expectTokenBalances(token, alice, wad(0), firstClawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - firstClawbackAmount - releasableAmount,
          escrow.address,
        );

        // Second clawback - claim the remaining amount
        const secondClawbackAmount = totalClawbackAmount - firstClawbackAmount;
        const clawbackTx2 = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, secondClawbackAmount)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        // Assert released amount note
        const releasedAmountNote2 = (
          await getWalletNotes(wallet, {
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx2.txHash))[0].note;

        expect(releasedAmountNote2.items[0].toBigInt()).toBe(vestedAmount);
        expect(releasedAmountNote2.items[1].toBigInt()).toBe(1n);

        // Assert final balances - alice has full clawback amount, bob has releasable amount
        await expectTokenBalances(token, alice, wad(0), totalClawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );
      });

      it("reclaimer can do multiple clawbacks after recipient has already claimed", async () => {
        let currentBlockNumber = await node.getBlockNumber();
        let currentBlock = await node.getBlock(currentBlockNumber);
        const stopTimestamp =
          currentBlock!.header.globalVariables.timestamp +
          AZTEC_SLOT_TIME * 20n;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice, additionalScopes: [escrow.address] });

        const [releasableAmount, vestedAmount] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              stopTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Bob claims his releasable amount first
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob, additionalScopes: [escrow.address] });

        const totalClawbackAmount = AMOUNT - vestedAmount;

        // Assert post-claim balances
        await expectTokenBalances(token, alice, wad(0), wad(0));
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
          escrow.address,
        );

        // First clawback - claim 1/2 of the reclaimer's amount
        const firstClawbackAmount = totalClawbackAmount / 2n;
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.clawback(escrow.address, firstClawbackAmount)
          .send({ from: alice, additionalScopes: [escrow.address] });

        await expectTokenBalances(token, alice, wad(0), firstClawbackAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount - firstClawbackAmount,
          escrow.address,
        );

        // Second clawback - claim another 1/2
        const secondClawbackAmount = totalClawbackAmount / 2n;
        const clawbackTx2 = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.clawback(escrow.address, secondClawbackAmount)
            .send({ from: alice, additionalScopes: [escrow.address] })
        ).receipt;

        await expectTokenBalances(
          token,
          alice,
          wad(0),
          firstClawbackAmount + secondClawbackAmount,
        );

        // Assert final balances
        await expectTokenBalances(token, alice, wad(0), totalClawbackAmount);
        await expectTokenBalances(token, bob, wad(0), releasableAmount);
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          wad(0),
          escrow.address,
        );

        // Assert released amount note
        const releasedAmountNote2 = (
          await getWalletNotes(wallet, {
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(clawbackTx2.txHash))[0].note;

        expect(releasedAmountNote2.items[0].toBigInt()).toBe(vestedAmount);
        expect(releasedAmountNote2.items[1].toBigInt()).toBe(1n);
      });
    });
  });

  describe("releasable and vested amount", () => {
    it("releasable and vested amount should be correct with multiple claims", async () => {
      const tx = (
        await linearVestingEscrow
          .withWallet(wallet)
          .methods.setup_linear_vesting_escrow(
            bob,
            alice,
            token.address,
            start,
            duration,
            AMOUNT,
            secretKey,
          )
          .send({ from: alice, additionalScopes: [escrow.address] })
      ).receipt;

      // Assert initial balances
      await expectTokenBalances(token, bob, wad(0), wad(0));
      await expectTokenBalances(
        token,
        escrow.address,
        wad(0),
        AMOUNT,
        escrow.address,
      );

      let totalClaimed = 0n;
      let previousTx: FieldsOf<TxReceipt> = tx;
      let claimCount = 0;

      while (totalClaimed < AMOUNT) {
        claimCount++;

        // Get timestamp from the previous transaction for calculation
        const previousBlock = await node.getBlock(previousTx.blockNumber!);
        const claimTimestamp = previousBlock!.header.globalVariables.timestamp;

        // Utility functions
        const [utilityReleasable, utilityVested] = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: escrow.address })
        ).result;

        // Use utility function results as the source of truth (timestamp-independent)
        const receivedAmount = utilityReleasable as bigint;
        const cappedVestedAmount = utilityVested as bigint;
        totalClaimed += receivedAmount;

        // Now make the claim
        const claimTx = (
          await linearVestingEscrow
            .withWallet(wallet)
            .methods.claim(escrow.address, utilityReleasable)
            .send({ from: bob, additionalScopes: [escrow.address] })
        ).receipt;
        await syncPXE(wallet);

        // Check if vesting is complete
        const isVestingComplete = claimTimestamp >= start + duration;

        // We expect different number of notes based on vesting completion
        const notes = (
          await getWalletNotes(wallet, {
            contractAddress: token.address,
            additionalScopes: [escrow.address],
          })
        ).filter((note: any) => note.txHash.equals(claimTx.txHash));

        const releasedAmountNote = (
          await getWalletNotes(wallet, {
            contractAddress: linearVestingEscrow.address,
            storageSlot: slotReleasedAmountNotes,
            additionalScopes: [escrow.address],
          })
        )[0].note;
        expect(releasedAmountNote.items[0].toBigInt()).toBe(utilityVested);

        if (isVestingComplete) {
          // Final claim: 1 token note to Bob
          expect(notes.length).toBe(1);

          const bobTokenNote = (
            await getWalletNotes(wallet, {
              contractAddress: token.address,
              additionalScopes: [escrow.address],
            })
          ).filter((note: any) => note.txHash.equals(claimTx.txHash));
          expectUintNote(bobTokenNote[0].note, utilityReleasable, bob);
        } else {
          // Partial claim: 2 token notes (escrow change tokens and bob withdrawal tokens)
          expect(notes.length).toBe(2);

          const claimTokenNotes = (
            await getWalletNotes(wallet, {
              contractAddress: token.address,
              additionalScopes: [escrow.address],
            })
          ).filter((note: any) => note.txHash.equals(claimTx.txHash));

          // Find notes by value
          const escrowChangeNote = claimTokenNotes.find(
            (n: any) => n.note.items[0].toBigInt() === AMOUNT - totalClaimed,
          );
          const bobReceivedNote = claimTokenNotes.find(
            (n: any) => n.note.items[0].toBigInt() === utilityReleasable,
          );
          expect(escrowChangeNote).toBeDefined();
          expect(bobReceivedNote).toBeDefined();
          expectUintNote(
            escrowChangeNote!.note,
            AMOUNT - totalClaimed,
            escrow.address,
          );
          expectUintNote(bobReceivedNote!.note, utilityReleasable, bob);
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
          escrow.address,
        );
      }

      // Be sure we had multiple claims
      expect(claimCount).toBeGreaterThan(1);
    });
  });
});

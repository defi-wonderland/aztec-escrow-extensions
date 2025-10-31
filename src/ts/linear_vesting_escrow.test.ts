import {
  ContractDeployer,
  Fr,
  TxStatus,
  getContractInstanceFromInstantiationParams,
  Contract,
  AccountWalletWithSecretKey,
  PublicKeys,
  AztecAddress,
  getContractClassFromArtifact,
  GrumpkinScalar,
  TxReceipt,
  FieldsOf,
} from "@aztec/aztec.js";
import {
  computeInitializationHash,
  computeContractAddressFromInstance,
  computeSaltedInitializationHash,
} from "@aztec/stdlib/contract";
import { getDefaultInitializer } from "@aztec/stdlib/abi";
import { deriveKeys } from "@aztec/stdlib/keys";
import {
  setupPXE,
  deployTokenWithMinter,
  AMOUNT,
  U128_MAX,
  expectTokenBalances,
  wad,
  deployNFTWithMinter,
  expectUintNote,
  deployLinearVestingEscrow,
  deployEscrowWithPublicKeysAndSalt,
  grumpkinScalarToFr,
} from "./utils.js";
import { siloNullifier } from "@aztec/stdlib/hash";
import { pedersenHash } from "@aztec/foundation/crypto";
import { PXE } from "@aztec/stdlib/interfaces/client";
import { AztecLmdbStore } from "@aztec/kv-store/lmdb";
import { getInitialTestAccountsManagers } from "@aztec/accounts/testing";
import {
  LinearVestingEscrowLogicContract,
  LinearVestingEscrowLogicContractArtifact,
  EscrowDetailsLogContent,
} from "../artifacts/LinearVestingEscrowLogic.js";
import { EscrowContractArtifact, EscrowContract } from "../artifacts/Escrow.js";
import { TokenContract } from "../artifacts/Token.js";

/**
 * Predicts the contract address for a given artifact and constructor arguments.
 * @param artifact - The contract artifact.
 * @param constructorArgs - The arguments to pass to the constructor.
 * @param deployer - The address of the deployer.
 * @param salt - The salt to use for the contract address. If not provided, a random salt will be used.
 * @param publicKeys - The public keys to use for the contract.
 * @returns The predicted contract address.
 */
export async function deriveContractAddress(
  artifact: any,
  constructorArgs: any,
  deployer: AztecAddress = AztecAddress.ZERO,
  salt: Fr = Fr.random(),
  publicKeys: PublicKeys,
) {
  if (!publicKeys) {
    publicKeys = await PublicKeys.random();
  }

  const contractClass = await getContractClassFromArtifact(artifact);
  const contractClassId = contractClass.id;
  const constructorArtifact = getDefaultInitializer(artifact);
  const initializationHash = await computeInitializationHash(
    constructorArtifact,
    constructorArgs,
  );
  const saltedInitializationHash = await computeSaltedInitializationHash({
    initializationHash,
    salt,
    deployer,
  });

  const address = await computeContractAddressFromInstance({
    originalContractClassId: contractClassId,
    saltedInitializationHash: saltedInitializationHash,
    publicKeys: publicKeys,
  });

  return { address, initializationHash, saltedInitializationHash };
}

const setupTestSuite = async () => {
  const { pxe, store } = await setupPXE();
  const managers = await getInitialTestAccountsManagers(pxe);
  const wallets = await Promise.all(managers.map((acc) => acc.register()));

  return { pxe, wallets, store };
};

describe("Linear Vesting Escrow - Single PXE", () => {
  let pxe: PXE;
  let store: AztecLmdbStore;

  let wallets: AccountWalletWithSecretKey[];

  let alice: AccountWalletWithSecretKey;
  let bob: AccountWalletWithSecretKey;
  let carl: AccountWalletWithSecretKey;

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

  async function setup() {
    ({ pxe, wallets, store } = await setupTestSuite());

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
    // Logic is deployed with the public keys because it sends encrypted events to the recipient and with the escrow class id
    linearVestingEscrow = (await deployLinearVestingEscrow(
      alice,
      escrowClassId,
    )) as LinearVestingEscrowLogicContract;

    // Use the logic contract address as the salt for the escrow contract
    escrowSalt = new Fr(linearVestingEscrow.address.toBigInt());

    // Deploy an escrow contract
    escrow = (await deployEscrowWithPublicKeysAndSalt(
      escrowKeys.publicKeys,
      alice,
      escrowSalt,
    )) as EscrowContract;

    // Deploy a token contract
    token = (await deployTokenWithMinter(alice)) as TokenContract;

    const partialAddressEscrow = await escrow.partialAddress;
    await pxe.registerAccount(escrowSk, partialAddressEscrow);

    await token
      .withWallet(alice)
      .methods.mint_to_private(escrow.address, AMOUNT)
      .send({ from: alice.getAddress() })
      .wait();

    const blockNumber = await pxe.getBlockNumber();
    const block = await pxe.getBlock(blockNumber);
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
          deployer: alice.getAddress(),
        },
      );

      const deployer = new ContractDeployer(
        LinearVestingEscrowLogicContractArtifact,
        alice,
        undefined,
        "constructor",
      );
      const tx = deployer.deploy(escrowClassId).send({
        contractAddressSalt: salt,
        from: alice.getAddress(),
      });

      const receipt = await tx.getReceipt();

      expect(receipt).toEqual(
        expect.objectContaining({
          status: TxStatus.PENDING,
          error: "",
        }),
      );

      const receiptAfterMined = await tx.wait({ wallet: alice });

      const contractMetadata = await pxe.getContractMetadata(
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
    // Split in 2 parts due to memory limit of the store
    describe("part 1", () => {
      beforeAll(async () => {
        await setup();
      });

      let tx: FieldsOf<TxReceipt>;

      beforeEach(async () => {
        tx = await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();
      });

      it("creates linear vesting escrow shares escrow with bob correctly", async () => {
        const blockNumber = tx.blockNumber!;
        const bobPxe = pxe;

        const events = await bobPxe.getPrivateEvents<EscrowDetailsLogContent>(
          linearVestingEscrow.address,
          LinearVestingEscrowLogicContract.events.EscrowDetailsLogContent,
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

      it("creates linear vesting escrow should create a correct linearVestingEscrow note", async () => {
        const bobPXE = pxe;

        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        const notes = await bobPXE.getNotes({
          contractAddress: linearVestingEscrow.address,
          txHash: tx.txHash,
        });

        // We expect 2 notes: 1 for the linear vesting escrow and 1 for the released amount
        expect(notes.length).toBe(2);

        const escrowNotes = (
          await bobPXE.getNotes({
            txHash: tx.txHash,
            contractAddress: linearVestingEscrow.address,
            recipient: escrow.address,
            storageSlot: slotEscrowNotes,
          })
        )[0].note;
        const releasedAmountNotes = (
          await bobPXE.getNotes({
            txHash: tx.txHash,
            contractAddress: linearVestingEscrow.address,
            recipient: escrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        )[0].note;

        expect(escrowNotes.items[0].toString()).toBe(escrow.address.toString());
        expect(escrowNotes.items[1].toString()).toBe(
          bob.getAddress().toString(),
        );
        expect(escrowNotes.items[2].toString()).toBe(
          alice.getAddress().toString(),
        );
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

        const txReceipt = await pxe.getTxReceipt(tx.txHash);
        expect(txReceipt.status).toBe(TxStatus.SUCCESS);

        const txEffect = await pxe.getTxEffect(tx.txHash);
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
              escrow.address,
              carl.getAddress(),
              alice.getAddress(),
              token.address,
              start,
              duration,
              AMOUNT,
              secretKeys,
            )
            .send({ from: alice.getAddress() })
            .wait(),
        ).rejects.toThrow(/Invalid tx: Existing nullifier/);
      });
    });

    describe("part 2", () => {
      beforeAll(async () => {
        await setup();
      });

      it("sharing an escrow with with incorrect secret keys should fail", async () => {
        let secretKeysPlusOne = {
          nsk_m: secretKeys.nsk_m.add(Fr.ONE),
          ivsk_m: secretKeys.ivsk_m.add(Fr.ONE),
          ovsk_m: secretKeys.ovsk_m.add(Fr.ONE),
          tsk_m: secretKeys.tsk_m.add(Fr.ONE),
        };

        await expect(
          linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              escrow.address,
              bob.getAddress(),
              alice.getAddress(),
              token.address,
              start,
              duration,
              AMOUNT,
              secretKeysPlusOne,
            )
            .send({ from: alice.getAddress() })
            .wait(),
        ).rejects.toThrow(/Assertion failed: Escrow public keys mismatch/);
      });

      it("sharing an escrow with non zero deployer should fail", async () => {
        // Re-deploy the escrow contract with no universalDeploy
        escrow = (await Contract.deployWithPublicKeys(
          escrowKeys.publicKeys,
          alice,
          EscrowContractArtifact,
          [],
        )
          .send({ contractAddressSalt: escrowSalt, from: alice.getAddress() })
          .deployed()) as EscrowContract;

        await expect(
          linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              escrow.address,
              bob.getAddress(),
              alice.getAddress(),
              token.address,
              start,
              duration,
              AMOUNT,
              secretKeys,
            )
            .send({ from: alice.getAddress() })
            .wait(),
        ).rejects.toThrow(/Assertion failed: Escrow deployer should be null/);
      });

      it("sharing an escrow with incorrect class id should fail", async () => {
        // Re-deploy the logic contract with an incorrect class id
        linearVestingEscrow = (await deployLinearVestingEscrow(
          alice,
          escrowClassId.add(Fr.ONE),
        )) as LinearVestingEscrowLogicContract;

        await expect(
          linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              escrow.address,
              bob.getAddress(),
              alice.getAddress(),
              token.address,
              start,
              duration,
              AMOUNT,
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
          linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              escrow.address,
              bob.getAddress(),
              alice.getAddress(),
              token.address,
              start,
              duration,
              AMOUNT,
              secretKeys,
            )
            .send({ from: alice.getAddress() })
            .wait(),
        ).rejects.toThrow(/Assertion failed: Escrow salt mismatch/);
      });
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
        const bobPXE = pxe;

        const tx = await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        // Next claim tx will read previous tx timestamp
        const block = await pxe.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        // Get releasable amount to call claim function
        const [releasableAmount] = await linearVestingEscrow
          .withWallet(bob)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob.getAddress() });

        // Bob claims the full amount
        const claimTx = await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, releasableAmount)
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

      it("claim should transfer the tokens partially to the recipient and emit 3 notes (tokens and released amount note)", async () => {
        // We set the duration to 1000 to make the tokens partially claimable
        duration = 1000n;
        const bobPXE = pxe;

        const tx = await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        // Next claim tx will read previous tx timestamp
        const block = await pxe.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        // Get releasable amount to call claim function
        const [releasableAmount] = await linearVestingEscrow
          .withWallet(bob)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob.getAddress() });

        const claimTx = await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob.getAddress() })
          .wait();
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });
        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        const receivedAmount =
          ((BigInt(claimTimestamp) - BigInt(start)) * AMOUNT) /
          BigInt(duration);

        // We expect a released amount note
        const notes = await bobPXE.getNotes({
          contractAddress: linearVestingEscrow.address,
          txHash: claimTx.txHash,
        });
        expect(notes.length).toBe(1);

        const escrowTokenNote = await bobPXE.getNotes({
          txHash: claimTx.txHash,
          contractAddress: token.address,
          recipient: escrow.address,
        });
        expectUintNote(
          escrowTokenNote[0],
          AMOUNT - receivedAmount,
          escrow.address,
        );

        const releasedAmountNote = (
          await bobPXE.getNotes({
            txHash: claimTx.txHash,
            contractAddress: linearVestingEscrow.address,
            recipient: escrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        )[0].note;
        expect(releasedAmountNote.items[1].toBigInt()).toBe(receivedAmount);

        const bobTokenNote = await bobPXE.getNotes({
          txHash: claimTx.txHash,
          contractAddress: token.address,
          recipient: bob.getAddress(),
        });
        expectUintNote(bobTokenNote[0], receivedAmount, bob.getAddress());

        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          receivedAmount,
        );
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - receivedAmount,
        );
      });

      it("claim with amount equal to u128 max value should work", async () => {
        // When calculating the the vested amount in the linear vesting schedule, we use bignum to avoid overflow
        // This test makes sure the bignum works correctly by testing what would be the overflow case without bignum:
        // (total_amount * elapsed) = (U128_MAX * duration) > U128_MAX

        const newToken = (await deployTokenWithMinter(alice)) as TokenContract;

        await newToken
          .withWallet(alice)
          .methods.mint_to_private(escrow.address, U128_MAX)
          .send({ from: alice.getAddress() })
          .wait();

        const bobPXE = pxe;

        const setupTx = await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            newToken.address,
            start,
            duration,
            U128_MAX,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        // Assert initial balances
        await expectTokenBalances(newToken, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(newToken, escrow.address, wad(0), U128_MAX);

        let totalClaimed = 0n;
        let previousTx = setupTx;
        let claimCount = 0;

        while (totalClaimed < U128_MAX) {
          claimCount++;

          // Use the timestamp from the PREVIOUS transaction for calculation
          const previousBlock = await pxe.getBlock(previousTx.blockNumber!);
          const claimTimestamp =
            previousBlock!.header.globalVariables.timestamp;

          // Get releasable amount to call claim function
          const [releasableAmount] = await linearVestingEscrow
            .withWallet(bob)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: bob.getAddress() });

          const claimTx = await linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address, releasableAmount)
            .send({ from: bob.getAddress() })
            .wait();
          await newToken
            .withWallet(bob)
            .methods.sync_private_state()
            .simulate({ from: bob.getAddress() });
          await linearVestingEscrow
            .withWallet(bob)
            .methods.sync_private_state()
            .simulate({ from: bob.getAddress() });

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
          const notes = await bobPXE.getNotes({
            contractAddress: newToken.address,
            txHash: claimTx.txHash,
          });

          const releasedAmountNote = (
            await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: linearVestingEscrow.address,
              recipient: escrow.address,
              storageSlot: slotReleasedAmountNotes,
            })
          )[0].note;
          expect(releasedAmountNote.items[1].toBigInt()).toBe(
            cappedVestedAmount,
          );

          if (isVestingComplete) {
            // Final claim: 1 token note to Bob
            expect(notes.length).toBe(1);

            const bobTokenNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: newToken.address,
              recipient: bob.getAddress(),
            });
            expectUintNote(bobTokenNote[0], receivedAmount, bob.getAddress());
          } else {
            // Partial claim: 2 token notes (escrow change tokens and bob withdrawal tokens)
            expect(notes.length).toBe(2);

            const escrowTokenNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: newToken.address,
              recipient: escrow.address,
            });
            expectUintNote(
              escrowTokenNote[0],
              U128_MAX - totalClaimed,
              escrow.address,
            );

            const bobTokenNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: newToken.address,
              recipient: bob.getAddress(),
            });
            expectUintNote(bobTokenNote[0], receivedAmount, bob.getAddress());
          }

          // Update previousTx to current claim for next iteration
          previousTx = claimTx;

          // Final balance checks
          await expectTokenBalances(
            newToken,
            bob.getAddress(),
            wad(0),
            totalClaimed,
          );
          await expectTokenBalances(
            newToken,
            escrow.address,
            wad(0),
            U128_MAX - totalClaimed,
          );
        }

        // Be sure we had multiple claims
        expect(claimCount).toBeGreaterThan(1);
      });

      it("claim before the start time should transfer zero tokens", async () => {
        // We increment the start so the tokens are not claimable yet
        start = start + 10000n;

        const tx = await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        // Next claim tx will read previous tx timestamp
        const block = await pxe.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Get releasable amount to call claim function
        const [releasableAmount] = await linearVestingEscrow
          .withWallet(bob)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob.getAddress() });

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob.getAddress() })
          .wait();

        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);
      });
    });

    describe("part 2", () => {
      beforeAll(async () => {
        await setup();
      });

      let tx: FieldsOf<TxReceipt>;

      beforeEach(async () => {
        tx = await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);
      });

      it("claim executed multiple times should be successful", async () => {
        const bobPXE = pxe;

        let totalClaimed = 0n;
        let previousTx = tx;
        let claimCount = 0;

        while (totalClaimed < AMOUNT) {
          claimCount++;

          // Use the timestamp from the PREVIOUS transaction for calculation
          const previousBlock = await pxe.getBlock(previousTx.blockNumber!);
          const claimTimestamp =
            previousBlock!.header.globalVariables.timestamp;

          // Get releasable amount to call claim function
          const [releasableAmount] = await linearVestingEscrow
            .withWallet(bob)
            .methods.releasable_and_vested_amounts(
              escrow.address,
              claimTimestamp,
            )
            .simulate({ from: bob.getAddress() });

          const claimTx = await linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address, releasableAmount)
            .send({ from: bob.getAddress() })
            .wait();
          await token
            .withWallet(bob)
            .methods.sync_private_state()
            .simulate({ from: bob.getAddress() });
          await linearVestingEscrow
            .withWallet(bob)
            .methods.sync_private_state()
            .simulate({ from: bob.getAddress() });

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
          const notes = await bobPXE.getNotes({
            contractAddress: token.address,
            txHash: claimTx.txHash,
          });

          const releasedAmountNote = (
            await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: linearVestingEscrow.address,
              recipient: escrow.address,
              storageSlot: slotReleasedAmountNotes,
            })
          )[0].note;
          expect(releasedAmountNote.items[1].toBigInt()).toBe(
            cappedVestedAmount,
          );

          if (isVestingComplete) {
            // Final claim: 1 token note to Bob
            expect(notes.length).toBe(1);

            const bobTokenNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: token.address,
              recipient: bob.getAddress(),
            });
            expectUintNote(bobTokenNote[0], receivedAmount, bob.getAddress());
          } else {
            // Partial claim: 2 token notes (escrow change tokens and bob withdrawal tokens)
            expect(notes.length).toBe(2);

            const escrowTokenNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: token.address,
              recipient: escrow.address,
            });
            expectUintNote(
              escrowTokenNote[0],
              AMOUNT - totalClaimed,
              escrow.address,
            );

            const bobTokenNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: token.address,
              recipient: bob.getAddress(),
            });
            expectUintNote(bobTokenNote[0], receivedAmount, bob.getAddress());
          }

          // Update previousTx to current claim for next iteration
          previousTx = claimTx;

          // Final balance checks
          await expectTokenBalances(
            token,
            bob.getAddress(),
            wad(0),
            totalClaimed,
          );
          await expectTokenBalances(
            token,
            escrow.address,
            wad(0),
            AMOUNT - totalClaimed,
          );
        }

        // Be sure we had multiple claims
        expect(claimCount).toBeGreaterThan(1);
      });

      it("claim should fail if amount is greater than releasable amount", async () => {
        // Next claim tx will read previous tx timestamp
        const block = await pxe.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Get releasable amount to call claim function
        const [releasableAmount] = await linearVestingEscrow
          .withWallet(bob)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob.getAddress() });

        // Claim amount too high error
        await expect(
          linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address, releasableAmount * 2n)
            .send({ from: bob.getAddress() })
            .wait(),
        ).rejects.toThrow(/claim amount too high/);
      });

      it("final claim should not allow further claims", async () => {
        const block = await pxe.getBlock(tx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice.getAddress() });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob.getAddress() })
          .wait();

        // Try to claim again should fail
        await expect(
          linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address, 1n)
            .send({ from: bob.getAddress() })
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
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        const block = await pxe.getBlock(setupTx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice.getAddress() });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        const finalClaimTx = await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob.getAddress() })
          .wait();

        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        const releasedAmountNote = (
          await pxe.getNotes({
            txHash: finalClaimTx.txHash,
            contractAddress: linearVestingEscrow.address,
            recipient: escrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        )[0].note;

        expect(releasedAmountNote.items[1].toBigInt()).toBe(vestedAmount);
        // Claim completed
        expect(releasedAmountNote.items[2].toBigInt()).toBe(1n); // true is 1n in the contract

        // Assert final balances
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          vestedAmount,
        );
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - vestedAmount,
        );
      });

      it("final claim with partially funded escrow should claim correctly", async () => {
        // We set the amount to 2x the AMOUNT to make the escrow partially funded
        const amount = AMOUNT * 2n;
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            amount,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        const block = await pxe.getBlock(setupTx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice.getAddress() });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        const finalClaimTx = await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob.getAddress() })
          .wait();

        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        const releasedAmountNote = (
          await pxe.getNotes({
            txHash: finalClaimTx.txHash,
            contractAddress: linearVestingEscrow.address,
            recipient: escrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        )[0].note;

        expect(releasedAmountNote.items[1].toBigInt()).toBe(vestedAmount);
        // Claim completed
        expect(releasedAmountNote.items[2].toBigInt()).toBe(1n); // true is 1n in the contract

        // Assert final balances
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          vestedAmount,
        );
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - vestedAmount,
        );
      });

      it("final claim should fail if the caller is not the recipient", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        const block = await pxe.getBlock(setupTx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice.getAddress() });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        await expect(
          linearVestingEscrow
            .withWallet(alice)
            .methods.claim(escrow.address, releasableAmount)
            .send({ from: alice.getAddress() })
            .wait(),
        ).rejects.toThrow(/caller is not recipient/);
      });

      it("final claim should fail if amount is greater than releasable amount", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        const block = await pxe.getBlock(setupTx.blockNumber!);
        const stopVestingTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        const [releasableAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(
            escrow.address,
            stopVestingTimestamp,
          )
          .simulate({ from: alice.getAddress() });

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        // We test the edge case where the claim amount is greater than the releasable amount by 1
        await expect(
          linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address, releasableAmount + 1n)
            .send({ from: bob.getAddress() })
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
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          token.address,
          start,
          duration,
          AMOUNT,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();
    });

    it("stop vesting should stop the vesting and emit correct vesting schedule note", async () => {
      // Sync to get linear vesting escrow note
      await linearVestingEscrow
        .withWallet(alice)
        .methods.sync_private_state()
        .simulate({ from: alice.getAddress() });

      const setupEscrowNote = (
        await pxe.getNotes({
          txHash: tx.txHash,
          contractAddress: linearVestingEscrow.address,
          recipient: escrow.address,
          storageSlot: slotEscrowNotes,
        })
      )[0].note;

      // Stop vesting
      const stopVestingTimestamp = start + duration;
      const stopVestingTx = await linearVestingEscrow
        .withWallet(alice)
        .methods.stop_vesting(escrow.address, stopVestingTimestamp)
        .send({ from: alice.getAddress() })
        .wait();

      // Sync to get linear vesting escrow note
      await linearVestingEscrow
        .withWallet(alice)
        .methods.sync_private_state()
        .simulate({ from: alice.getAddress() });

      const stopVestingEscrowNote = (
        await pxe.getNotes({
          txHash: stopVestingTx.txHash,
          contractAddress: linearVestingEscrow.address,
          recipient: escrow.address,
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
          .withWallet(bob)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: bob.getAddress() })
          .wait(),
      ).rejects.toThrow(/caller is not reclaimer/);
    });

    it("stop vesting should fail if already stopped", async () => {
      const stopVestingTimestamp = start + duration;

      // Stop vesting for the first time
      await linearVestingEscrow
        .withWallet(alice)
        .methods.stop_vesting(escrow.address, stopVestingTimestamp)
        .send({ from: alice.getAddress() })
        .wait();

      // Stop vesting should fail if the vesting is already stopped
      await expect(
        linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice.getAddress() })
          .wait(),
      ).rejects.toThrow(/Vesting schedule is not active/);
    });

    it("stop vesting should fail if stop timestamp is lower than block timestamp", async () => {
      // Stop vesting time is incorrect, lower that block timestamp
      const stopVestingTimestamp = start;
      await expect(
        linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopVestingTimestamp)
          .send({ from: alice.getAddress() })
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
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);
      });

      it("clawback successfully when escrow is fully funded and there's still releasable amount", async () => {
        const block = await pxe.getBlock(tx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice.getAddress() });

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(alice)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice.getAddress() })
          .wait();

        await token
          .withWallet(alice)
          .methods.sync_private_state()
          .simulate({ from: alice.getAddress() });
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // Assert notes
        const notes = await pxe.getNotes({
          contractAddress: token.address,
          txHash: clawbackTx.txHash,
        });
        expect(notes.length).toBe(2);

        // Assert final balances
        await expectTokenBalances(
          token,
          alice.getAddress(),
          wad(0),
          clawbackAmount,
        );
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          releasableAmount,
        );
        await expectTokenBalances(token, escrow.address, wad(0), wad(0));
      });

      it("clawback successfully when escrow was fully funded and there's no releasable amount (after final claim)", async () => {
        const block = await pxe.getBlock(tx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        // releasableAmount here is not 0, it will be after the claim transaction
        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice.getAddress() });

        // Bob claims the releasable amount, making the releasable amount 0 for the clawback transaction
        await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob.getAddress() })
          .wait();
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // releasableAmount should be 0 after the claim transaction
        const [releasableAmountAfterClaim, _] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice.getAddress() });

        expect(releasableAmountAfterClaim).toBe(0n);

        // Assert post-claim balances
        await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          releasableAmount,
        );
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
        );

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(alice)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice.getAddress() })
          .wait();

        await token
          .withWallet(alice)
          .methods.sync_private_state()
          .simulate({ from: alice.getAddress() });
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // Assert notes
        const notes = await pxe.getNotes({
          contractAddress: token.address,
          txHash: clawbackTx.txHash,
        });
        expect(notes.length).toBe(1);

        // Assert final balances
        await expectTokenBalances(
          token,
          alice.getAddress(),
          wad(0),
          clawbackAmount,
        );
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          releasableAmount,
        );
        await expectTokenBalances(token, escrow.address, wad(0), wad(0));
      });

      it("clawback successfully when escrow was fully funded and there's still releasable amount (after final partial claim)", async () => {
        const block = await pxe.getBlock(tx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        // releasableAmount here is not 0, it will be after the claim transaction
        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice.getAddress() });

        // Bob claims the releasable amount, making the releasable amount 0 for the clawback transaction
        await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, releasableAmount / 2n)
          .send({ from: bob.getAddress() })
          .wait();
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // releasableAmount should be 0 after the claim transaction
        const [releasableAmountAfterClaim, _] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice.getAddress() });

        expect(releasableAmountAfterClaim).toBe(releasableAmount / 2n);

        // Assert post-claim balances
        await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          releasableAmount / 2n,
        );
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount / 2n,
        );

        const clawbackAmount = AMOUNT - vestedAmount;

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(alice)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice.getAddress() })
          .wait();

        await token
          .withWallet(alice)
          .methods.sync_private_state()
          .simulate({ from: alice.getAddress() });
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // Assert notes
        const notes = await pxe.getNotes({
          contractAddress: token.address,
          txHash: clawbackTx.txHash,
        });
        expect(notes.length).toBe(2);

        // Assert final balances
        await expectTokenBalances(
          token,
          alice.getAddress(),
          wad(0),
          clawbackAmount,
        );
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          releasableAmount,
        );
        await expectTokenBalances(token, escrow.address, wad(0), wad(0));
      });

      it("clawback should fail if the caller is not the reclaimer", async () => {
        // Clawback should fail if the caller is not the reclaimer
        await expect(
          linearVestingEscrow
            .withWallet(bob)
            .methods.clawback(escrow.address, AMOUNT)
            .send({ from: bob.getAddress() })
            .wait(),
        ).rejects.toThrow(/caller is not reclaimer/);
      });

      it("clawback should fail the escrow vesting is still active", async () => {
        // Clawback should fail if the vesting is still active
        await expect(
          linearVestingEscrow
            .withWallet(alice)
            .methods.clawback(escrow.address, AMOUNT)
            .send({ from: alice.getAddress() })
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
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        const block = await pxe.getBlock(tx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        const [releasableAmount, _] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice.getAddress() });

        linearVestingEscrow
          .withWallet(alice)
          .methods.clawback(escrow.address, 0n)
          .send({ from: alice.getAddress() })
          .wait();

        await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          releasableAmount,
        );
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
        );
      });

      it("clawback successfully: escrow is not fully funded, releasable amount > 0", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            amount,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        const block = await pxe.getBlock(setupTx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice.getAddress() });

        const clawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(alice)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice.getAddress() })
          .wait();

        await token
          .withWallet(alice)
          .methods.sync_private_state()
          .simulate({ from: alice.getAddress() });
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // Assert notes
        const notes = await pxe.getNotes({
          contractAddress: token.address,
          txHash: clawbackTx.txHash,
        });
        expect(notes.length).toBe(2);

        // Assert final balances
        await expectTokenBalances(
          token,
          alice.getAddress(),
          wad(0),
          clawbackAmount,
        );
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          releasableAmount,
        );
        await expectTokenBalances(token, escrow.address, wad(0), wad(0));
      });

      it("clawback successfully: escrow is not fully funded, releasable amount == 0", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            amount,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        const block = await pxe.getBlock(setupTx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice.getAddress() });

        const clawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        // Bob claims the releasable amount
        await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address, releasableAmount)
          .send({ from: bob.getAddress() })
          .wait();
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // Assert post-claim balances
        await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          releasableAmount,
        );
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - releasableAmount,
        );

        // Clawback
        const clawbackTx = await linearVestingEscrow
          .withWallet(alice)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice.getAddress() })
          .wait();

        await token
          .withWallet(alice)
          .methods.sync_private_state()
          .simulate({ from: alice.getAddress() });
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // Assert notes
        const notes = await pxe.getNotes({
          contractAddress: token.address,
          txHash: clawbackTx.txHash,
        });
        expect(notes.length).toBe(1);

        // Assert final balances
        await expectTokenBalances(
          token,
          alice.getAddress(),
          wad(0),
          clawbackAmount,
        );
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          releasableAmount,
        );
        await expectTokenBalances(token, escrow.address, wad(0), wad(0));
      });

      it("claiming after clawback should fail", async () => {
        const setupTx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            alice.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys,
          )
          .send({ from: alice.getAddress() })
          .wait();

        const block = await pxe.getBlock(setupTx.blockNumber!);
        // Stop timestamp to match exactly the next block timestamp
        const stopTimestamp =
          block!.header.globalVariables.timestamp + AZTEC_SLOT_TIME;

        // Stop vesting
        await linearVestingEscrow
          .withWallet(alice)
          .methods.stop_vesting(escrow.address, stopTimestamp)
          .send({ from: alice.getAddress() })
          .wait();

        const [releasableAmount, vestedAmount] = await linearVestingEscrow
          .withWallet(alice)
          .methods.releasable_and_vested_amounts(escrow.address, stopTimestamp)
          .simulate({ from: alice.getAddress() });

        const clawbackAmount = AMOUNT - vestedAmount;

        // Assert initial balances
        await expectTokenBalances(token, alice.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        // Clawback
        await linearVestingEscrow
          .withWallet(alice)
          .methods.clawback(escrow.address, clawbackAmount)
          .send({ from: alice.getAddress() })
          .wait();

        await token
          .withWallet(alice)
          .methods.sync_private_state()
          .simulate({ from: alice.getAddress() });
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // Claiming after clawback should fail
        await expect(
          linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address, 1n)
            .send({ from: bob.getAddress() })
            .wait(),
        ).rejects.toThrow(/released amount note not found/);
      });
    });
  });

  describe("releasable and vested amount", () => {
    beforeAll(async () => {
      await setup();
    });

    it("releasable and vested amount should be correct with multiple claims", async () => {
      const bobPXE = pxe;

      const tx = await linearVestingEscrow
        .withWallet(alice)
        .methods.setup_linear_vesting_escrow(
          escrow.address,
          bob.getAddress(),
          alice.getAddress(),
          token.address,
          start,
          duration,
          AMOUNT,
          secretKeys,
        )
        .send({ from: alice.getAddress() })
        .wait();

      // Assert initial balances
      await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
      await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

      let totalClaimed = 0n;
      let previousTx = tx;
      let claimCount = 0;

      while (totalClaimed < AMOUNT) {
        claimCount++;

        // Get timestamp from the previous transaction for calculation
        const previousBlock = await pxe.getBlock(previousTx.blockNumber!);
        const claimTimestamp = previousBlock!.header.globalVariables.timestamp;

        // Utility functions
        const [utilityReleasable, utilityVested] = await linearVestingEscrow
          .withWallet(bob)
          .methods.releasable_and_vested_amounts(escrow.address, claimTimestamp)
          .simulate({ from: bob.getAddress() });

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
          .withWallet(bob)
          .methods.claim(escrow.address, utilityReleasable)
          .send({ from: bob.getAddress() })
          .wait();
        await token
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });
        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({ from: bob.getAddress() });

        // Check if vesting is complete
        const isVestingComplete = claimTimestamp >= start + duration;

        // We expect different number of notes based on vesting completion
        const notes = await bobPXE.getNotes({
          contractAddress: token.address,
          txHash: claimTx.txHash,
        });

        const releasedAmountNote = (
          await bobPXE.getNotes({
            txHash: claimTx.txHash,
            contractAddress: linearVestingEscrow.address,
            recipient: escrow.address,
            storageSlot: slotReleasedAmountNotes,
          })
        )[0].note;
        expect(releasedAmountNote.items[1].toBigInt()).toBe(utilityVested);

        if (isVestingComplete) {
          // Final claim: 1 token note to Bob
          expect(notes.length).toBe(1);

          const bobTokenNote = await bobPXE.getNotes({
            txHash: claimTx.txHash,
            contractAddress: token.address,
            recipient: bob.getAddress(),
          });
          expectUintNote(bobTokenNote[0], utilityReleasable, bob.getAddress());
        } else {
          // Partial claim: 2 token notes (escrow change tokens and bob withdrawal tokens)
          expect(notes.length).toBe(2);

          const escrowTokenNote = await bobPXE.getNotes({
            txHash: claimTx.txHash,
            contractAddress: token.address,
            recipient: escrow.address,
          });
          expectUintNote(
            escrowTokenNote[0],
            AMOUNT - totalClaimed,
            escrow.address,
          );

          const bobTokenNote = await bobPXE.getNotes({
            txHash: claimTx.txHash,
            contractAddress: token.address,
            recipient: bob.getAddress(),
          });
          expectUintNote(bobTokenNote[0], utilityReleasable, bob.getAddress());
        }

        // Update previousTx to current claim for next iteration
        previousTx = claimTx;

        // Final balance checks
        await expectTokenBalances(
          token,
          bob.getAddress(),
          wad(0),
          totalClaimed,
        );
        await expectTokenBalances(
          token,
          escrow.address,
          wad(0),
          AMOUNT - totalClaimed,
        );
      }

      // Be sure we had multiple claims
      expect(claimCount).toBeGreaterThan(1);
    });
  });
});

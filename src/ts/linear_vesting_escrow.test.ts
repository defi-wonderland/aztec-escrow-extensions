import {
  ContractDeployer,
  Fr,
  TxStatus,
  getContractInstanceFromDeployParams,
  Contract,
  AccountWalletWithSecretKey,
  AccountWallet,
  PublicKeys,
  AztecAddress,
  getContractClassFromArtifact,
  DeployOptions,
  GrumpkinScalar,
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
import { CheatCodes } from "@aztec/aztec.js/testing";
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
  const { pxe, store, cc } = await setupPXE();
  const managers = await getInitialTestAccountsManagers(pxe);
  const wallets = await Promise.all(managers.map((acc) => acc.register()));
  const [deployer] = wallets;

  return { pxe, deployer, wallets, store, cc };
};

describe("Linear Vesting Escrow - Single PXE", () => {
  let pxe: PXE;
  let store: AztecLmdbStore;
  let cc: CheatCodes;

  let wallets: AccountWalletWithSecretKey[];
  let deployer: AccountWalletWithSecretKey;

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
  let secretKeys: Fr[];

  // Token contract
  let token: TokenContract;

  let start: bigint;
  let duration: bigint;

  async function setup() {
    ({ pxe, deployer, wallets, store, cc } = await setupTestSuite());

    [alice, bob, carl] = wallets;

    // Get the class id of the escrow contract
    escrowClassId = (await getContractClassFromArtifact(EscrowContractArtifact))
      .id;

    // We default to a secret key of 1 for testing purposes
    escrowSk = Fr.ONE.add(Fr.ONE);

    // Derive the keys from the secret key
    escrowKeys = await deriveKeys(escrowSk);

    // Convert the keys to Fr
    secretKeys = [
      grumpkinScalarToFr(escrowKeys.masterNullifierSecretKey),
      grumpkinScalarToFr(escrowKeys.masterIncomingViewingSecretKey),
      grumpkinScalarToFr(escrowKeys.masterOutgoingViewingSecretKey),
      grumpkinScalarToFr(escrowKeys.masterTaggingSecretKey),
    ];
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
    token = (await deployTokenWithMinter(alice, {})) as TokenContract;

    const partialAddressEscrow = await escrow.partialAddress;
    await pxe.registerAccount(escrowSk, partialAddressEscrow);

    await token
      .withWallet(alice)
      .methods.mint_to_private(escrow.address, escrow.address, AMOUNT)
      .send()
      .wait();

    const blockNumber = await pxe.getBlockNumber();
    const block = await pxe.getBlock(blockNumber);
    start = block!.header.globalVariables.timestamp;
    duration = 100n;
  });

  afterAll(async () => {
    await store.delete();
  });

  describe("Deployment", () => {
    beforeAll(async () => {
      await store.delete();
      await setup();
    });

    it("deploys linear vesting escrow with correct constructor params", async () => {
      const salt = Fr.random();
      const deploymentData = await getContractInstanceFromDeployParams(
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
      expect(contractMetadata.isContractPubliclyDeployed).toBeTruthy();
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
        await store.delete();
        await setup();
      });

      it("creates linear vesting escrow shares escrow with bob correctly", async () => {
        const tx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();
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
        expect(event.nsk_m).toEqual(
          escrowKeys.masterNullifierSecretKey.toBigInt(),
        );
        expect(event.ivsk_m).toEqual(
          escrowKeys.masterIncomingViewingSecretKey.toBigInt(),
        );
        expect(event.ovsk_m).toEqual(
          escrowKeys.masterOutgoingViewingSecretKey.toBigInt(),
        );
        expect(event.tsk_m).toEqual(
          escrowKeys.masterTaggingSecretKey.toBigInt(),
        );
      });

      it("creates linear vesting escrow should create a correct linearVestingEscrow note", async () => {
        const bobPXE = pxe;

        const tx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();

        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({});

        const notes = await bobPXE.getNotes({ txHash: tx.txHash });

        // We expect 2 notes: 1 for the linear vesting escrow and 1 for the released amount
        expect(notes.length).toBe(2);

        const slotEscrowNotes =
          LinearVestingEscrowLogicContract.storage.escrows.slot;
        const slotReleasedAmountNotes =
          LinearVestingEscrowLogicContract.storage.released_notes.slot;

        const escrowNotes = await bobPXE.getNotes({
          txHash: tx.txHash,
          contractAddress: linearVestingEscrow.address,
          recipient: bob.getAddress(),
          storageSlot: slotEscrowNotes,
        });
        const releasedAmountNotes = await bobPXE.getNotes({
          txHash: tx.txHash,
          contractAddress: linearVestingEscrow.address,
          recipient: bob.getAddress(),
          storageSlot: slotReleasedAmountNotes,
        });

        expect(escrowNotes[0].note.items[0].toString()).toBe(
          escrow.address.toString(),
        );
        expect(escrowNotes[0].note.items[1].toString()).toBe(
          bob.getAddress().toString(),
        );
        expect(escrowNotes[0].note.items[2].toString()).toBe(
          token.address.toString(),
        );
        expect(escrowNotes[0].note.items[3].toBigInt()).toBe(BigInt(start));
        expect(escrowNotes[0].note.items[4].toBigInt()).toBe(BigInt(duration));
        expect(escrowNotes[0].note.items[5].toBigInt()).toBe(BigInt(AMOUNT));

        expect(releasedAmountNotes[0].note.items[0].toString()).toBe(
          escrow.address.toString(),
        );
        expect(releasedAmountNotes[0].note.items[1].toBigInt()).toBe(BigInt(0));
      });

      it("creates linear vesting escrow should emit a nullifier for the escrow", async () => {
        const tx = await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();

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
        // Create a linear vesting escrow for bob
        await linearVestingEscrow.methods
          .setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();

        // Try to create a linear vesting escrow for carl
        await expect(
          linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              escrow.address,
              carl.getAddress(),
              token.address,
              start,
              duration,
              AMOUNT,
              secretKeys[0],
              secretKeys[1],
              secretKeys[2],
              secretKeys[3],
            )
            .send()
            .wait(),
        ).rejects.toThrow(/Invalid tx: Existing nullifier/);
      });
    });

    describe("part 2", () => {
      beforeAll(async () => {
        await store.delete();
        await setup();
      });

      it("sharing an escrow with with incorrect secret keys should fail", async () => {
        let secretKeysPlusOne = secretKeys.map((sk) => sk.add(Fr.ONE));

        await expect(
          linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              escrow.address,
              bob.getAddress(),
              token.address,
              start,
              duration,
              AMOUNT,
              secretKeysPlusOne[0],
              secretKeysPlusOne[1],
              secretKeysPlusOne[2],
              secretKeysPlusOne[3],
            )
            .send()
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
          .send({ contractAddressSalt: escrowSalt })
          .deployed()) as EscrowContract;

        await expect(
          linearVestingEscrow.methods
            .setup_linear_vesting_escrow(
              escrow.address,
              bob.getAddress(),
              token.address,
              start,
              duration,
              AMOUNT,
              secretKeys[0],
              secretKeys[1],
              secretKeys[2],
              secretKeys[3],
            )
            .send()
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
              token.address,
              start,
              duration,
              AMOUNT,
              secretKeys[0],
              secretKeys[1],
              secretKeys[2],
              secretKeys[3],
            )
            .send()
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
              token.address,
              start,
              duration,
              AMOUNT,
              secretKeys[0],
              secretKeys[1],
              secretKeys[2],
              secretKeys[3],
            )
            .send()
            .wait(),
        ).rejects.toThrow(/Assertion failed: Escrow salt mismatch/);
      });
    });
  });

  describe("claim", () => {
    // Split in 2 parts due to memory limit of the store
    describe("part 1", () => {
      beforeAll(async () => {
        await store.delete();
        await setup();
      });

      it("claim should transfer the tokens to the recipient and emit one note (token note)", async () => {
        // We set the duration to 1 to make the tokens fully claimable
        duration = 1n;
        const bobPXE = pxe;

        await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        // Bob claims the full amount
        const claimTx = await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address)
          .send()
          .wait();
        await token.withWallet(bob).methods.sync_private_state().simulate({});

        // Assert that bob received the note
        const notes = await bobPXE.getNotes({ txHash: claimTx.txHash });
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
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();

        // Next claim tx will read previous tx timestamp
        const block = await pxe.getBlock(tx.blockNumber!);
        const claimTimestamp = block!.header.globalVariables.timestamp;

        // Sync to get linear vesting escrow note
        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({});

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        const claimTx = await linearVestingEscrow
          .withWallet(bob)
          .methods.claim(escrow.address)
          .send()
          .wait();
        await token.withWallet(bob).methods.sync_private_state().simulate({});
        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({});

        const receivedAmount =
          ((BigInt(claimTimestamp) - BigInt(start)) * AMOUNT) /
          BigInt(duration);

        // We expect 3 notes: 2 token notes (bob + escrow) and a released amount note
        const notes = await bobPXE.getNotes({ txHash: claimTx.txHash });
        expect(notes.length).toBe(3);

        const slotReleasedAmountNotes =
          LinearVestingEscrowLogicContract.storage.released_notes.slot;

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

        const releasedAmountNote = await bobPXE.getNotes({
          txHash: claimTx.txHash,
          contractAddress: linearVestingEscrow.address,
          recipient: bob.getAddress(),
          storageSlot: slotReleasedAmountNotes,
        });
        expect(releasedAmountNote[0].note.items[1].toBigInt()).toBe(
          receivedAmount,
        );

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

      it("claim two times in a row should be successful", async () => {
        // We set the duration to 1000 to make the tokens partially claimable
        duration = 1000n;
        const bobPXE = pxe;

        const tx = await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();

        // Sync to get linear vesting escrow note
        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({});

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        let totalClaimed = 0n;
        let previousTx = tx;

        for (let i = 0; i < 2; i++) {
          const claimTx = await linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address)
            .send()
            .wait();
          await token.withWallet(bob).methods.sync_private_state().simulate({});
          await linearVestingEscrow
            .withWallet(bob)
            .methods.sync_private_state()
            .simulate({});

          // Use the timestamp from the PREVIOUS transaction for calculation
          const previousBlock = await pxe.getBlock(previousTx.blockNumber!);
          const claimTimestamp =
            previousBlock!.header.globalVariables.timestamp;

          // Calculate total vested amount up to the previous transaction's timestamp
          const totalVestedAmount =
            claimTimestamp > start
              ? ((BigInt(claimTimestamp) - BigInt(start)) * AMOUNT) /
                BigInt(duration)
              : 0n;

          // The amount received in this claim is the difference between total vested and previously claimed
          const receivedAmount = totalVestedAmount - totalClaimed;
          totalClaimed += receivedAmount;

          // We expect 3 notes: 2 token notes (bob + escrow), plus an escrow note for bob
          const notes = await bobPXE.getNotes({ txHash: claimTx.txHash });
          expect(notes.length).toBe(3);

          const slotReleasedAmountNotes =
            LinearVestingEscrowLogicContract.storage.released_notes.slot;

          const releasedAmountNote = await bobPXE.getNotes({
            txHash: claimTx.txHash,
            contractAddress: linearVestingEscrow.address,
            recipient: bob.getAddress(),
            storageSlot: slotReleasedAmountNotes,
          });
          expect(releasedAmountNote[0].note.items[1].toBigInt()).toBe(
            totalVestedAmount,
          );

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

          // Update previousTx to current claim for next iteration
          previousTx = claimTx;

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
      });
    });

    describe("part 2", () => {
      beforeAll(async () => {
        await store.delete();
        await setup();
      });

      it("claim executed multiple times should be successful", async () => {
        // We set the duration to 200 to make the tokens partially claimable (claims every 36 units of time)
        duration = 200n;
        const bobPXE = pxe;

        const tx = await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();

        // Sync to get linear vesting escrow note
        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({});

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        let totalClaimed = 0n;
        let previousTx = tx;
        let claimCount = 0;

        while (totalClaimed < AMOUNT) {
          claimCount++;

          const claimTx = await linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address)
            .send()
            .wait();
          await token.withWallet(bob).methods.sync_private_state().simulate({});
          await linearVestingEscrow
            .withWallet(bob)
            .methods.sync_private_state()
            .simulate({});

          // Use the timestamp from the PREVIOUS transaction for calculation
          const previousBlock = await pxe.getBlock(previousTx.blockNumber!);
          const claimTimestamp =
            previousBlock!.header.globalVariables.timestamp;

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
          const notes = await bobPXE.getNotes({ txHash: claimTx.txHash });

          if (isVestingComplete) {
            // Final claim: 1 note (tokens to Bob)
            expect(notes.length).toBe(1);

            const bobTokenNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: token.address,
              recipient: bob.getAddress(),
            });
            expectUintNote(bobTokenNote[0], receivedAmount, bob.getAddress());
          } else {
            // Partial claim: 3 notes (escrow tokens, linear vesting note, bob tokens)
            expect(notes.length).toBe(3);

            const slotReleasedAmountNotes =
              LinearVestingEscrowLogicContract.storage.released_notes.slot;

            const releasedAmountNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: linearVestingEscrow.address,
              recipient: bob.getAddress(),
              storageSlot: slotReleasedAmountNotes,
            });
            expect(releasedAmountNote[0].note.items[1].toBigInt()).toBe(
              cappedVestedAmount,
            );

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

      it("claim with amount equal to u128 max value should work", async () => {
        // When calculating the the vested amount in the linear vesting schedule, we use bignum to avoid overflow
        // This test makes sure the bignum works correctly by testing what would be the overflow case without bignum:
        // (total_amount * elapsed) = (U128_MAX * duration) > U128_MAX

        const newToken = (await deployTokenWithMinter(
          alice,
          {},
        )) as TokenContract;

        await newToken
          .withWallet(alice)
          .methods.mint_to_private(escrow.address, escrow.address, U128_MAX)
          .send()
          .wait();

        duration = 200n;
        const bobPXE = pxe;

        const tx = await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            newToken.address,
            start,
            duration,
            U128_MAX,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();

        // Sync to get linear vesting escrow note
        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({});

        // Assert initial balances
        await expectTokenBalances(newToken, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(newToken, escrow.address, wad(0), U128_MAX);

        let totalClaimed = 0n;
        let previousTx = tx;
        let claimCount = 0;

        while (totalClaimed < U128_MAX) {
          claimCount++;

          const claimTx = await linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address)
            .send()
            .wait();
          await newToken
            .withWallet(bob)
            .methods.sync_private_state()
            .simulate({});
          await linearVestingEscrow
            .withWallet(bob)
            .methods.sync_private_state()
            .simulate({});

          // Use the timestamp from the PREVIOUS transaction for calculation
          const previousBlock = await pxe.getBlock(previousTx.blockNumber!);
          const claimTimestamp =
            previousBlock!.header.globalVariables.timestamp;

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
          const notes = await bobPXE.getNotes({ txHash: claimTx.txHash });

          if (isVestingComplete) {
            // Final claim: 1 note (tokens to Bob)
            expect(notes.length).toBe(1);

            const bobTokenNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: newToken.address,
              recipient: bob.getAddress(),
            });
            expectUintNote(bobTokenNote[0], receivedAmount, bob.getAddress());
          } else {
            // Partial claim: 3 notes (escrow tokens, linear vesting note, bob tokens)
            expect(notes.length).toBe(3);

            const slotReleasedAmountNotes =
              LinearVestingEscrowLogicContract.storage.released_notes.slot;

            const releasedAmountNote = await bobPXE.getNotes({
              txHash: claimTx.txHash,
              contractAddress: linearVestingEscrow.address,
              recipient: bob.getAddress(),
              storageSlot: slotReleasedAmountNotes,
            });
            expect(releasedAmountNote[0].note.items[1].toBigInt()).toBe(
              cappedVestedAmount,
            );

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

      it("claim before the start time should not transfer", async () => {
        // We increment the start so the tokens are not claimable yet
        start = start + 10000n;
        duration = 200n;

        await linearVestingEscrow
          .withWallet(alice)
          .methods.setup_linear_vesting_escrow(
            escrow.address,
            bob.getAddress(),
            token.address,
            start,
            duration,
            AMOUNT,
            secretKeys[0],
            secretKeys[1],
            secretKeys[2],
            secretKeys[3],
          )
          .send()
          .wait();

        // Sync to get linear vesting escrow note
        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({});

        // Assert initial balances
        await expectTokenBalances(token, bob.getAddress(), wad(0), wad(0));
        await expectTokenBalances(token, escrow.address, wad(0), AMOUNT);

        // Balance too low error
        await expect(
          linearVestingEscrow
            .withWallet(bob)
            .methods.claim(escrow.address)
            .send()
            .wait(),
        ).rejects.toThrow("Balance too low 'subtracted > 0'");
      });
    });
  });

  describe("releasable and vested amount", () => {
    beforeAll(async () => {
      await store.delete();
      await setup();
    });

    it("releasable and vested amount should be correct with multiple claims", async () => {
      // We set the duration to 200 to make the tokens partially claimable (claims every 36 units of time)
      duration = 200n;
      const bobPXE = pxe;

      const tx = await linearVestingEscrow
        .withWallet(alice)
        .methods.setup_linear_vesting_escrow(
          escrow.address,
          bob.getAddress(),
          token.address,
          start,
          duration,
          AMOUNT,
          secretKeys[0],
          secretKeys[1],
          secretKeys[2],
          secretKeys[3],
        )
        .send()
        .wait();

      // Sync to get linear vesting escrow note
      await linearVestingEscrow
        .withWallet(bob)
        .methods.sync_private_state()
        .simulate({});

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
          .simulate();

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
          .methods.claim(escrow.address)
          .send()
          .wait();
        await token.withWallet(bob).methods.sync_private_state().simulate({});
        await linearVestingEscrow
          .withWallet(bob)
          .methods.sync_private_state()
          .simulate({});

        // Check if vesting is complete
        const isVestingComplete = claimTimestamp >= start + duration;

        // We expect different number of notes based on vesting completion
        const notes = await bobPXE.getNotes({ txHash: claimTx.txHash });

        if (isVestingComplete) {
          // Final claim: 1 note (tokens to Bob)
          expect(notes.length).toBe(1);

          const bobTokenNote = await bobPXE.getNotes({
            txHash: claimTx.txHash,
            contractAddress: token.address,
            recipient: bob.getAddress(),
          });
          expectUintNote(bobTokenNote[0], utilityReleasable, bob.getAddress());
        } else {
          // Partial claim: 3 notes (escrow tokens, linear vesting note, bob tokens)
          expect(notes.length).toBe(3);

          const slotReleasedAmountNotes =
            LinearVestingEscrowLogicContract.storage.released_notes.slot;

          const releasedAmountNote = await bobPXE.getNotes({
            txHash: claimTx.txHash,
            contractAddress: linearVestingEscrow.address,
            recipient: bob.getAddress(),
            storageSlot: slotReleasedAmountNotes,
          });
          expect(releasedAmountNote[0].note.items[1].toBigInt()).toBe(
            utilityVested,
          );

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

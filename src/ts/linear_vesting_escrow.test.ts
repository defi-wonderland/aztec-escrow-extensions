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
    GrumpkinScalar,
    getContractClassFromArtifact,
    DeployOptions,
  } from '@aztec/aztec.js';
  import {
    computeInitializationHash,
    computeContractAddressFromInstance,
    computeSaltedInitializationHash,
  } from '@aztec/stdlib/contract';
  import { getDefaultInitializer } from '@aztec/stdlib/abi';
  import { deriveKeys } from '@aztec/stdlib/keys';
  import {
    setupPXE,
    deployTokenWithMinter,
    AMOUNT,
    expectTokenBalances,
    wad,
    deployNFTWithMinter,
    expectUintNote,
    deployLinearVestingEscrow,
    deployEscrowWithPublicKeysAndSalt,
  } from './utils.js';
  import { CheatCodes } from "@aztec/aztec.js/testing";
  import { PXE } from '@aztec/stdlib/interfaces/client';
  import { AztecLmdbStore } from '@aztec/kv-store/lmdb';
  import { getInitialTestAccountsManagers } from '@aztec/accounts/testing';
  import { LinearVestingEscrowLogicContract, LinearVestingEscrowLogicContractArtifact, EscrowDetailsLogContent } from '../artifacts/LinearVestingEscrowLogic.js';
  import { EscrowContractArtifact, EscrowContract } from '@defi-wonderland/aztec-standards/current/artifacts/Escrow.js';
  import { TokenContract } from '@defi-wonderland/aztec-standards/current/artifacts/Token.js';
  
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
    const initializationHash = await computeInitializationHash(constructorArtifact, constructorArgs);
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
  
  export function grumpkinScalarToFr(scalar: GrumpkinScalar) {
    return new Fr(scalar.toBigInt());
  }
  
  const setupTestSuite = async () => {
    const { pxe, store, cc } = await setupPXE();
    const managers = await getInitialTestAccountsManagers(pxe);
    const wallets = await Promise.all(managers.map((acc) => acc.register()));
    const [deployer] = wallets;
  
    return { pxe, deployer, wallets, store, cc };
  };
  
  describe('Linear Vesting Escrow - Single PXE', () => {
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

    let start: number;
    let duration: number;
  
    async function setup() {
      ({ pxe, deployer, wallets, store, cc } = await setupTestSuite());
  
      [alice, bob, carl] = wallets;
  
      // Get the class id of the escrow contract
      escrowClassId = (await getContractClassFromArtifact(EscrowContractArtifact)).id;
  
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
        linearVestingEscrow = (await deployLinearVestingEscrow(alice, escrowClassId)) as LinearVestingEscrowLogicContract;
    
        // Use the logic contract address as the salt for the escrow contract
        escrowSalt = new Fr(linearVestingEscrow.instance.address.toBigInt());
    
        // Deploy an escrow contract
        escrow = (await deployEscrowWithPublicKeysAndSalt(escrowKeys.publicKeys, alice, escrowSalt)) as EscrowContract;

        // Deploy a token contract
        token = (await deployTokenWithMinter(alice, {})) as TokenContract;

        const partialAddressEscrow = await escrow.partialAddress;
        await pxe.registerAccount(escrowSk, partialAddressEscrow);

        await token
            .withWallet(alice)
            .methods.mint_to_private(escrow.instance.address, escrow.instance.address, AMOUNT)
            .send()
            .wait();

        start = await pxe.getBlockNumber();
        duration = 1000;
    });
  
    afterAll(async () => {
        await store.delete();
    });
  
    describe('Deployment', () => {
        beforeAll(async () => {
            await store.delete();
            await setup();
        });

        it('deploys linear vesting escrow with correct constructor params', async () => {
            const deploymentData = await getContractInstanceFromDeployParams(LinearVestingEscrowLogicContractArtifact, {
            constructorArtifact: 'constructor',
            constructorArgs: [alice.getAddress(), escrowClassId],
            salt: escrowSalt,
            deployer: alice.getAddress(),
            });
    
            const deployer = new ContractDeployer(LinearVestingEscrowLogicContractArtifact, alice, undefined, 'constructor');
            const tx = deployer.deploy(alice.getAddress(), escrowClassId).send({
            contractAddressSalt: escrowSalt,
            });
    
            const receipt = await tx.getReceipt();
    
            expect(receipt).toEqual(
            expect.objectContaining({
                status: TxStatus.PENDING,
                error: '',
            }),
            );
    
            const receiptAfterMined = await tx.wait({ wallet: alice });
    
            const contractMetadata = await pxe.getContractMetadata(deploymentData.address);
            expect(contractMetadata).toBeDefined();
            expect(contractMetadata.isContractPubliclyDeployed).toBeTruthy();
            expect(receiptAfterMined).toEqual(
            expect.objectContaining({
                status: TxStatus.SUCCESS,
            }),
            );
    
            expect(receiptAfterMined.contract.instance.address).toEqual(deploymentData.address);
        });
  
        it('deploys escrow with correctly derived address', async () => {
            const { address, initializationHash } = await deriveContractAddress(
            EscrowContractArtifact,
            [], // constructor args are null
            AztecAddress.ZERO, // deployer is null
            escrowSalt,
            escrowKeys.publicKeys,
            );
    
            expect(address).toEqual(escrow.instance.address);
            expect(initializationHash).toEqual(Fr.ZERO);
            expect(initializationHash).toEqual(escrow.instance.initializationHash);
        });
    });

    describe('create_linear_vesting_escrow', () => {
        beforeAll(async () => {
            await store.delete();
            await setup();
        });

        it('creates linear vesting escrow shares escrow with bob correctly', async () => {
            const tx = await linearVestingEscrow.methods.create_linear_vesting_escrow(escrow.instance.address, bob.getAddress(), token.instance.address, start, duration, AMOUNT, secretKeys[0], secretKeys[1], secretKeys[2], secretKeys[3]).send().wait();
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

            expect(event.escrow).toEqual(escrow.instance.address);
            expect(event.nsk_m).toEqual(escrowKeys.masterNullifierSecretKey.toBigInt());
            expect(event.ivsk_m).toEqual(escrowKeys.masterIncomingViewingSecretKey.toBigInt());
            expect(event.ovsk_m).toEqual(escrowKeys.masterOutgoingViewingSecretKey.toBigInt());
            expect(event.tsk_m).toEqual(escrowKeys.masterTaggingSecretKey.toBigInt());
        });

        it('creates linear vesting escrow should nullify and not allow to create another one', async () => {
            // Create a linear vesting escrow for bob
            await linearVestingEscrow.methods.create_linear_vesting_escrow(escrow.instance.address, bob.getAddress(), token.instance.address, start, duration, AMOUNT, secretKeys[0], secretKeys[1], secretKeys[2], secretKeys[3]).send().wait(); 

            // Try to create a linear vesting escrow for carl
            await expect(
                linearVestingEscrow.methods.create_linear_vesting_escrow(escrow.instance.address, carl.getAddress(), token.instance.address, start, duration, AMOUNT, secretKeys[0], secretKeys[1], secretKeys[2], secretKeys[3]).send().wait(),
            ).rejects.toThrow(/Invalid tx: Existing nullifier/);
        });

        it('sharing an escrow with with incorrect secret keys should fail', async () => {
            let secretKeysPlusOne = secretKeys.map((sk) => sk.add(Fr.ONE));

            await expect(
                linearVestingEscrow.methods.create_linear_vesting_escrow(escrow.instance.address, bob.getAddress(), token.instance.address, start, duration, AMOUNT, secretKeysPlusOne[0], secretKeysPlusOne[1], secretKeysPlusOne[2], secretKeysPlusOne[3]).send().wait(),
            ).rejects.toThrow(/Assertion failed: Escrow public keys mismatch/);
        });

        it('sharing an escrow with non zero deployer should fail', async () => {
            // Re-deploy the escrow contract with no universalDeploy
            escrow = (await Contract.deployWithPublicKeys(escrowKeys.publicKeys, alice, EscrowContractArtifact, [])
              .send({ contractAddressSalt: escrowSalt })
              .deployed()) as EscrowContract;
      
            await expect(
                linearVestingEscrow.methods
                .create_linear_vesting_escrow(escrow.instance.address, bob.getAddress(), token.instance.address, start, duration, AMOUNT, secretKeys[0], secretKeys[1], secretKeys[2], secretKeys[3])
                .send()
                .wait(),
            ).rejects.toThrow(/Assertion failed: Escrow deployer should be null/);
        });

        it('sharing an escrow with incorrect class id should fail', async () => {
            // Re-deploy the logic contract with an incorrect class id
            linearVestingEscrow = (await deployLinearVestingEscrow(
              alice,
              escrowClassId.add(Fr.ONE),
            )) as LinearVestingEscrowLogicContract;
      
            await expect(
                linearVestingEscrow.methods
                .create_linear_vesting_escrow(escrow.instance.address, bob.getAddress(), token.instance.address, start, duration, AMOUNT, secretKeys[0], secretKeys[1], secretKeys[2], secretKeys[3])
                .send()
                .wait(),
            ).rejects.toThrow(/Assertion failed: Escrow class id mismatch/);
        });

        it('sharing an escrow with incorrect salt should fail', async () => {
            // Re-deploy the escrow contract with a different salt (different from the logic contract address)
            escrow = (await deployEscrowWithPublicKeysAndSalt(
              escrowKeys.publicKeys,
              alice,
              escrowSalt.add(Fr.ONE),
            )) as EscrowContract;
      
            await expect(
              linearVestingEscrow.methods
                .create_linear_vesting_escrow(escrow.instance.address, bob.getAddress(), token.instance.address, start, duration, AMOUNT, secretKeys[0], secretKeys[1], secretKeys[2], secretKeys[3])
                .send()
                .wait(),
            ).rejects.toThrow(/Assertion failed: Escrow salt mismatch/);
        });
    });

    // TODO: Add tests for claim
    describe('claim', () => {
        beforeAll(async () => {
            await store.delete();
            await setup();
        });

    });

    // TODO: Add tests for utility functions
});

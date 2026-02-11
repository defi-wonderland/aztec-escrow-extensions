import { PublicKeys } from "@aztec/stdlib/keys";
import { createLogger } from "@aztec/aztec.js/log";
import { type Wallet } from "@aztec/aztec.js/wallet";
import { createStore } from "@aztec/kv-store/lmdb-v2";
import { getDefaultInitializer } from "@aztec/stdlib/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { getPXEConfig } from "@aztec/pxe/server";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { Fr, type GrumpkinScalar } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import {
  registerInitialLocalNetworkAccountsInWallet,
  TestWallet,
} from "@aztec/test-wallet/server";
import {
  Contract,
  DeployOptions,
  ContractFunctionInteraction,
  getContractClassFromArtifact,
} from "@aztec/aztec.js/contracts";
import {
  AuthWitness,
  type ContractFunctionInteractionCallIntent,
} from "@aztec/aztec.js/authorization";
import {
  computeInitializationHash,
  computeSaltedInitializationHash,
  computeContractAddressFromInstance,
} from "@aztec/stdlib/contract";

import {
  LinearVestingEscrowLogicContract,
  LinearVestingEscrowLogicContractArtifact,
} from "../artifacts/LinearVestingEscrowLogic.js";
import {
  ClawbackEscrowLogicContract,
  ClawbackEscrowLogicContractArtifact,
} from "../artifacts/ClawbackEscrowLogic.js";
import { EscrowContract, EscrowContractArtifact } from "../artifacts/Escrow.js";
import { TokenContract, TokenContractArtifact } from "../artifacts/Token.js";
import { NFTContract, NFTContractArtifact } from "../artifacts/NFT.js";

export const logger = createLogger("aztec:aztec-standards");

const { NODE_URL = "http://localhost:8080" } = process.env;
const node = createAztecNodeClient(NODE_URL);
await waitForNode(node);
const { PXE_VERSION = "2" } = process.env;
const pxeVersion = parseInt(PXE_VERSION);
const l1Contracts = await node.getL1ContractAddresses();
const config = getPXEConfig();
let fullConfig = { ...config, l1Contracts };

/**
 * Setup the store, node, wallet and accounts
 * @param suffix - optional - The suffix to use for the store directory.
 * @param proverEnabled - optional - Whether to enable the prover, used for benchmarking.
 * @returns The store, node, wallet and accounts
 */
export const setupTestSuite = async (
  suffix?: string,
  proverEnabled: boolean = false,
) => {
  const storeDir = suffix ? `store-${suffix}` : "store";

  fullConfig = {
    ...fullConfig,
    dataDirectory: storeDir,
    dataStoreMapSizeKb: 1e6,
  };

  // Create the store for manual cleanups
  const store: AztecLMDBStoreV2 = await createStore("pxe_data", pxeVersion, {
    dataDirectory: storeDir,
    dataStoreMapSizeKb: 1e6,
  });

  const wallet: TestWallet = await TestWallet.create(
    node,
    { ...fullConfig, proverEnabled },
    { store },
  );

  const accounts: AztecAddress[] =
    await registerInitialLocalNetworkAccountsInWallet(wallet);

  return {
    store,
    node,
    wallet,
    accounts,
  };
};

// --- Token Utils ---

export const expectTokenBalances = async (
  token: TokenContract,
  address: AztecAddress,
  publicBalance: bigint | number | Fr,
  privateBalance: bigint | number | Fr,
  caller?: AztecAddress,
) => {
  const aztecAddress = address instanceof AztecAddress ? address : address;
  logger.info("checking balances for", aztecAddress.toString());
  // We can't use an account that is not in the wallet to simulate the balances, so we use the caller if provided.
  const from = caller ? caller : aztecAddress;

  // Helper to cast to bigint if not already
  const toBigInt = (val: bigint | number | Fr) => {
    if (typeof val === "bigint") return val;
    if (typeof val === "number") return BigInt(val);
    if (val instanceof Fr) return val.toBigInt();
    throw new Error("Unsupported type for balance");
  };

  expect(
    await token.methods.balance_of_public(aztecAddress).simulate({ from }),
  ).toBe(toBigInt(publicBalance));
  expect(
    await token.methods.balance_of_private(aztecAddress).simulate({ from }),
  ).toBe(toBigInt(privateBalance));
};

export const AMOUNT = 1000n;
export const wad = (n: number = 1) => AMOUNT * BigInt(n);
export const U128_MAX: bigint = (1n << 128n) - 1n;

/**
 * Deploys the Token contract with a specified minter.
 * @param wallet - The wallet to deploy the contract with.
 * @param deployer - The account to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployTokenWithMinter(
  wallet: Wallet,
  deployer: AztecAddress,
  options?: DeployOptions,
) {
  const contract = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ["PrivateToken", "PT", 18, deployer, AztecAddress.ZERO],
    "constructor_with_minter",
  ).send({ ...options, from: deployer });
  return contract;
}

/**
 * Deploys the Token contract with a specified initial supply.
 * @param wallet - The wallet to deploy the contract with.
 * @param deployer - The account to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployTokenWithInitialSupply(
  wallet: Wallet,
  deployer: AztecAddress,
  options?: DeployOptions,
) {
  const contract = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ["PrivateToken", "PT", 18, 0, deployer, deployer],
    "constructor_with_initial_supply",
  ).send({ ...options, from: deployer });
  return contract;
}

/**
 * Deploys the NFT contract with a specified minter.
 * @param wallet - The wallet to deploy the contract with.
 * @param deployer - The address to deploy the contract with.
 * @param options - The options to deploy the contract with.
 * @returns A deployed contract instance.
 */
// Deploy NFT contract with a minter
export async function deployNFTWithMinter(
  wallet: TestWallet,
  deployer: AztecAddress,
  options?: DeployOptions,
) {
  const contract = await Contract.deploy(
    wallet,
    NFTContractArtifact,
    ["TestNFT", "TNFT", deployer, deployer],
    "constructor_with_minter",
  ).send({
    ...options,
    from: deployer,
  });
  return contract;
}

// --- Tokenized Vault Utils ---

/**
 * Deploys the Token contract with a specified minter.
 * @param wallet - The wallet to deploy the contract with.
 * @param deployer - The account to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployVaultAndAssetWithMinter(
  wallet: Wallet,
  deployer: AztecAddress,
  options?: DeployOptions,
): Promise<[Contract, Contract]> {
  const assetContract = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ["PrivateToken", "PT", 6, deployer, AztecAddress.ZERO],
    "constructor_with_minter",
  ).send({ ...options, from: deployer });

  const vaultContract = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ["VaultToken", "VT", 6, assetContract.address, AztecAddress.ZERO],
    "constructor_with_asset",
  ).send({ ...options, from: deployer });

  return [vaultContract, assetContract];
}

// --- Escrow Utils ---

/**
 * Deploys the Linear Vesting Logic contract.
 * @param wallet - The wallet to deploy the contract with.
 * @param deployer - The address to deploy the contract with.
 * @param escrowClassId - The class id of the escrow contract.
 * @param options - The options to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployLinearVestingEscrow(
  wallet: Wallet,
  deployer: AztecAddress,
  escrowClassId: Fr,
  options?: DeployOptions,
) {
  const contract = await Contract.deploy(
    wallet,
    LinearVestingEscrowLogicContractArtifact,
    [escrowClassId],
    "constructor",
  ).send({ ...options, from: deployer });
  return contract as LinearVestingEscrowLogicContract;
}

/**
 * Deploys the Clawback Logic contract.
 * @param wallet - The wallet to deploy the contract with.
 * @param deployer - The address to deploy the contract with.
 * @param escrowClassId - The class id of the escrow contract.
 * @param options - The options to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployClawbackEscrow(
  wallet: Wallet,
  deployer: AztecAddress,
  escrowClassId: Fr,
  options?: DeployOptions,
) {
  const contract = await Contract.deploy(
    wallet,
    ClawbackEscrowLogicContractArtifact,
    [escrowClassId],
    "constructor",
  ).send({ ...options, from: deployer });
  return contract as ClawbackEscrowLogicContract;
}

/**
 * Deploys the Escrow contract.
 * @param publicKeys - The public keys to use for the contract.
 * @param wallet - The wallet to deploy the contract with.
 * @param deployer - The wallet to deploy the contract with.
 * @param salt - The salt to use for the contract address. If not provided, a random salt will be used.
 * @param args - The arguments to pass to the contract constructor.
 * @param constructor - The constructor to use for the contract.
 * @returns A deployed contract instance.
 */
export async function deployEscrowWithPublicKeysAndSalt(
  publicKeys: PublicKeys,
  wallet: Wallet,
  deployer: AztecAddress,
  salt: Fr = Fr.random(),
  args: unknown[] = [],
  constructor?: string,
): Promise<EscrowContract> {
  const contract = await Contract.deployWithPublicKeys(
    publicKeys,
    wallet,
    EscrowContractArtifact,
    args,
    constructor,
  ).send({
    contractAddressSalt: salt,
    universalDeploy: true,
    from: deployer,
  });
  return contract as EscrowContract;
}

// --- NFT Utils ---

// Check if an address owns a specific NFT in private state
export async function assertOwnsPrivateNFT(
  nft: NFTContract,
  tokenId: bigint,
  owner: AztecAddress,
  expectToBeTrue: boolean,
  caller?: AztecAddress,
) {
  const from = caller
    ? caller instanceof AztecAddress
      ? caller
      : caller
    : owner;
  const [nfts, _] = await nft.methods
    .get_private_nfts(owner, 0)
    .simulate({ from });
  const hasNFT = nfts.some((id: bigint) => id === tokenId);
  expect(hasNFT).toBe(expectToBeTrue);
}

// --- General Utils ---

export async function setPrivateAuthWit(
  caller: AztecAddress,
  action: ContractFunctionInteraction,
  authorizer: AztecAddress,
  wallet: TestWallet,
): Promise<AuthWitness> {
  const intent: ContractFunctionInteractionCallIntent = {
    caller: caller,
    action: action,
  };
  return wallet.createAuthWit(authorizer, intent);
}

export async function setPublicAuthWit(
  caller: AztecAddress,
  action: ContractFunctionInteraction,
  authorizer: AztecAddress,
  wallet: TestWallet,
) {
  const validateAction = await wallet.setPublicAuthWit(
    authorizer,
    {
      caller: caller,
      action: action,
    },
    true,
  );
  await validateAction.send();
}

/**
 * Converts a GrumpkinScalar to an Fr.
 * @param scalar - The GrumpkinScalar to convert.
 * @returns The converted Fr.
 */
export function grumpkinScalarToFr(scalar: GrumpkinScalar) {
  return new Fr(scalar.toBigInt());
}

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

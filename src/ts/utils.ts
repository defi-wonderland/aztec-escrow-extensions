import {
  createLogger,
  Fr,
  AztecAddress,
  UniqueNote,
  AccountWallet,
  Contract,
  DeployOptions,
  createAztecNodeClient,
  waitForPXE,
  IntentAction,
  Wallet,
  AuthWitness,
  ContractFunctionInteraction,
  PublicKeys,
} from "@aztec/aztec.js";
import { getPXEServiceConfig } from "@aztec/pxe/config";
import { createPXEService } from "@aztec/pxe/server";
import { createStore } from "@aztec/kv-store/lmdb";
import { CheatCodes } from "@aztec/aztec.js/testing";
import {
  LinearVestingEscrowLogicContract,
  LinearVestingEscrowLogicContractArtifact,
} from "../artifacts/LinearVestingEscrowLogic.js";
import {
  EscrowContract,
  EscrowContractArtifact,
} from "@defi-wonderland/aztec-standards/current/artifacts/Escrow.js";
import {
  TokenContract,
  TokenContractArtifact,
} from "@defi-wonderland/aztec-standards/current/artifacts/Token.js";
import { NFTContractArtifact } from "@defi-wonderland/aztec-standards/current/artifacts/NFT.js";

export const logger = createLogger("aztec:aztec-standards");

const { NODE_URL = "http://localhost:8080" } = process.env;
const ethRpcUrl = "http://localhost:8545";
const node = createAztecNodeClient(NODE_URL);
const l1Contracts = await node.getL1ContractAddresses();
const config = getPXEServiceConfig();
const fullConfig = { ...config, l1Contracts };
fullConfig.proverEnabled = false;

export const setupPXE = async () => {
  const store = await createStore("pxe", {
    dataDirectory: "store",
    dataStoreMapSizeKB: 1e6,
  });
  const pxe = await createPXEService(node, fullConfig, { store });
  await waitForPXE(pxe);
  const cc = await CheatCodes.create([ethRpcUrl], pxe);
  return { pxe, store, cc };
};

// --- Token Utils ---

export const expectUintNote = (
  note: UniqueNote,
  amount: bigint,
  owner: AztecAddress,
) => {
  expect(note.note.items[0]).toEqual(new Fr(owner.toBigInt()));
  expect(note.note.items[2]).toEqual(new Fr(amount));
};

export const expectTokenBalances = async (
  token: TokenContract,
  address: AztecAddress | { getAddress: () => AztecAddress },
  publicBalance: bigint | number | Fr,
  privateBalance: bigint | number | Fr,
  caller?: AccountWallet,
) => {
  const aztecAddress =
    address instanceof AztecAddress ? address : address.getAddress();
  logger.info("checking balances for", aztecAddress.toString());
  const t = caller ? token.withWallet(caller) : token;

  // Helper to cast to bigint if not already
  const toBigInt = (val: bigint | number | Fr) => {
    if (typeof val === "bigint") return val;
    if (typeof val === "number") return BigInt(val);
    if (val instanceof Fr) return val.toBigInt();
    throw new Error("Unsupported type for balance");
  };

  expect(await t.methods.balance_of_public(aztecAddress).simulate()).toBe(
    toBigInt(publicBalance),
  );
  expect(await t.methods.balance_of_private(aztecAddress).simulate()).toBe(
    toBigInt(privateBalance),
  );
};

export const AMOUNT = 1000n;
export const wad = (n: number = 1) => AMOUNT * BigInt(n);
export const U128_MAX: bigint = (1n << 128n) - 1n;

/**
 * Deploys the Token contract with a specified minter.
 * @param deployer - The wallet to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployTokenWithMinter(
  deployer: Wallet,
  options?: DeployOptions,
) {
  const contract = await Contract.deploy(
    deployer,
    TokenContractArtifact,
    ["PrivateToken", "PT", 18, deployer.getAddress(), AztecAddress.ZERO],
    "constructor_with_minter",
  )
    .send(options)
    .deployed();
  return contract;
}

export async function deployTokenWithInitialSupply(deployer: AccountWallet) {
  const contract = await Contract.deploy(
    deployer,
    TokenContractArtifact,
    ["PrivateToken", "PT", 18, 0, deployer.getAddress(), deployer.getAddress()],
    "constructor_with_initial_supply",
  )
    .send()
    .deployed();
  return contract;
}

/**
 * Deploys the NFT contract with a specified minter.
 * @param deployer - The wallet to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployNFTWithMinter(
  deployer: AccountWallet,
  options?: DeployOptions,
) {
  const contract = await Contract.deploy(
    deployer,
    NFTContractArtifact,
    ["NFT", "NFT", deployer.getAddress(), deployer.getAddress()],
    "constructor_with_minter",
  )
    .send(options)
    .deployed();
  return contract;
}

/**
 * Deploys the Token contract with a specified minter.
 * @param deployer - The wallet to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployVaultAndAssetWithMinter(
  deployer: AccountWallet,
): Promise<[Contract, Contract]> {
  const assetContract = await Contract.deploy(
    deployer,
    TokenContractArtifact,
    ["PrivateToken", "PT", 6, deployer.getAddress(), AztecAddress.ZERO],
    "constructor_with_minter",
  )
    .send()
    .deployed();

  const vaultContract = await Contract.deploy(
    deployer,
    TokenContractArtifact,
    ["VaultToken", "VT", 6, assetContract.address, AztecAddress.ZERO],
    "constructor_with_asset",
  )
    .send()
    .deployed();

  return [vaultContract, assetContract];
}

export async function setPrivateAuthWit(
  caller: AztecAddress | { getAddress: () => AztecAddress },
  action: ContractFunctionInteraction,
  deployer: AccountWallet,
): Promise<AuthWitness> {
  const callerAddress =
    caller instanceof AztecAddress ? caller : caller.getAddress();

  const intent: IntentAction = {
    caller: callerAddress,
    action: action,
  };
  return deployer.createAuthWit(intent);
}

export async function setPublicAuthWit(
  caller: AztecAddress | { getAddress: () => AztecAddress },
  action: ContractFunctionInteraction,
  deployer: AccountWallet,
) {
  const callerAddress =
    caller instanceof AztecAddress ? caller : caller.getAddress();

  const intent: IntentAction = {
    caller: callerAddress,
    action: action,
  };
  await deployer.createAuthWit(intent);
  await (await deployer.setPublicAuthWit(intent, true)).send().wait();
}

/**
 * Deploys the Logic contract.
 * @param deployer - The wallet to deploy the contract with.
 * @param escrowClassId - The class id of the escrow contract.
 * @param options - The options to deploy the contract with.
 * @returns A deployed contract instance.
 */
export async function deployLinearVestingEscrow(
  deployer: AccountWallet,
  escrowClassId: Fr,
  options?: DeployOptions,
) {
  const contract = await Contract.deploy(
    deployer,
    LinearVestingEscrowLogicContractArtifact,
    [escrowClassId],
    "constructor",
  )
    .send(options)
    .deployed();
  return contract as LinearVestingEscrowLogicContract;
}

/**
 * Deploys the Escrow contract.
 * @param publicKeys - The public keys to use for the contract.
 * @param deployer - The wallet to deploy the contract with.
 * @param salt - The salt to use for the contract address. If not provided, a random salt will be used.
 * @returns A deployed contract instance.
 */
export async function deployEscrowWithPublicKeysAndSalt(
  publicKeys: PublicKeys,
  deployer: AccountWallet,
  salt: Fr = Fr.random(),
  args: unknown[] = [],
  constructor?: string,
): Promise<EscrowContract> {
  const contract = await Contract.deployWithPublicKeys(
    publicKeys,
    deployer,
    EscrowContractArtifact,
    args,
    constructor,
  )
    .send({ contractAddressSalt: salt, universalDeploy: true })
    .deployed();
  return contract as EscrowContract;
}

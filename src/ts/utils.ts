import { Note } from "@aztec/aztec.js/note";
import { PublicKeys } from "@aztec/stdlib/keys";
import { createLogger } from "@aztec/aztec.js/log";
import { type Wallet } from "@aztec/aztec.js/wallet";
import { getDefaultInitializer } from "@aztec/stdlib/abi";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { getPXEConfig } from "@aztec/pxe/server";
import { Fr } from "@aztec/aztec.js/fields";
import { type Fq } from "@aztec/foundation/curves/bn254";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";
import {
  Contract,
  DeployOptions,
  ContractFunctionInteraction,
  getContractClassFromArtifact,
} from "@aztec/aztec.js/contracts";
import {
  AuthWitness,
  SetPublicAuthwitContractInteraction,
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
import {
  EscrowContract,
  EscrowContractArtifact,
} from "@defi-wonderland/aztec-standards/dist/src/artifacts/Escrow.js";
import {
  TokenContract,
  TokenContractArtifact,
} from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";
import {
  NFTContract,
  NFTContractArtifact,
} from "@defi-wonderland/aztec-standards/dist/src/artifacts/NFT.js";

export const logger = createLogger("aztec:aztec-standards");

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const { NODE_URL = "http://localhost:8080" } = process.env;
const node = createAztecNodeClient(NODE_URL);
await waitForNode(node);
const config = getPXEConfig();

/**
 * Setup the node, wallet and accounts
 * @param suffix - optional - The suffix to use for the store directory name.
 * @param proverEnabled - optional - Whether to enable the prover, used for benchmarking.
 * @returns The node, wallet, accounts, and a cleanup function
 */
export const setupTestSuite = async (
  suffix?: string,
  proverEnabled: boolean = false,
) => {
  const dirName = suffix
    ? `aztec-escrow-${suffix}-${randomBytes(4).toString("hex")}`
    : `aztec-escrow-${randomBytes(8).toString("hex")}`;
  const dataDirectory = join(tmpdir(), dirName);
  const pxeConfig = { ...config, dataDirectory, proverEnabled };

  const wallet: EmbeddedWallet = await EmbeddedWallet.create(node, {
    pxeConfig,
  });

  const accounts: AztecAddress[] =
    await registerInitialLocalNetworkAccountsInWallet(wallet);

  const cleanup = async () => {
    await wallet.stop();
    try {
      rmSync(dataDirectory, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  return {
    node,
    wallet,
    accounts,
    cleanup,
  };
};

// --- Token Utils ---

export const expectUintNote = (
  note: Note,
  amount: bigint,
  owner: AztecAddress,
) => {
  expect(note.items[0]).toEqual(new Fr(amount));
};

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
    (await token.methods.balance_of_public(aztecAddress).simulate({ from }))
      .result,
  ).toBe(toBigInt(publicBalance));
  expect(
    (await token.methods.balance_of_private(aztecAddress).simulate({ from }))
      .result,
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
  const result = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ["PrivateToken", "PT", 18, deployer],
    "constructor_with_minter",
  ).send({ ...options, from: deployer });
  return result.contract as TokenContract;
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
  const result = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ["PrivateToken", "PT", 18, 0, deployer, deployer],
    "constructor_with_initial_supply",
  ).send({ ...options, from: deployer });
  return result.contract as TokenContract;
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
  wallet: EmbeddedWallet,
  deployer: AztecAddress,
  options?: DeployOptions,
) {
  const result = await Contract.deploy(
    wallet,
    NFTContractArtifact,
    ["TestNFT", "TNFT", deployer],
    "constructor_with_minter",
  ).send({
    ...options,
    from: deployer,
  });
  return result.contract as NFTContract;
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
  const assetResult = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ["PrivateToken", "PT", 6, deployer],
    "constructor_with_minter",
  ).send({ ...options, from: deployer });
  const vaultResult = await Contract.deploy(
    wallet,
    TokenContractArtifact,
    ["VaultToken", "VT", 6, assetResult.contract.address],
    "constructor_with_asset",
  ).send({ ...options, from: deployer });
  return [vaultResult.contract, assetResult.contract];
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
  const result = await Contract.deploy(
    wallet,
    LinearVestingEscrowLogicContractArtifact,
    [escrowClassId],
    "constructor",
  ).send({ ...options, from: deployer });
  return result.contract as LinearVestingEscrowLogicContract;
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
  const result = await Contract.deploy(
    wallet,
    ClawbackEscrowLogicContractArtifact,
    [escrowClassId],
    "constructor",
  ).send({ ...options, from: deployer });
  return result.contract as ClawbackEscrowLogicContract;
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
  const result = await Contract.deployWithPublicKeys(
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
  return result.contract as EscrowContract;
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
  const simResult = await nft.methods
    .get_private_nfts(owner, 0)
    .simulate({ from });
  const [nfts, _] = simResult.result;
  const hasNFT = nfts.some((id: bigint) => id === tokenId);
  expect(hasNFT).toBe(expectToBeTrue);
}

export const expectNFTNote = (note: Note, tokenId: bigint) => {
  expect(note.items[0]).toEqual(new Fr(tokenId));
};

// --- General Utils ---

export async function setPrivateAuthWit(
  caller: AztecAddress,
  action: ContractFunctionInteraction,
  authorizer: AztecAddress,
  wallet: EmbeddedWallet,
): Promise<AuthWitness> {
  const intent: ContractFunctionInteractionCallIntent = {
    caller: caller,
    action: action,
  };
  return wallet.createAuthWit(
    authorizer,
    intent as unknown as Parameters<typeof wallet.createAuthWit>[1],
  );
}

export async function setPublicAuthWit(
  caller: AztecAddress,
  action: ContractFunctionInteraction,
  authorizer: AztecAddress,
  wallet: EmbeddedWallet,
) {
  const validateAction = await SetPublicAuthwitContractInteraction.create(
    wallet,
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
 * Access getNotes via the PXE debug utilities.
 * In v4, getNotes moved from the wallet to PXEDebugUtils.
 * In v4.2, scopes must be an AztecAddress[] (the string "ALL_SCOPES" is no longer accepted).
 *
 * If no `scopes` are provided, this defaults to all registered accounts plus any
 * `additionalScopes` (useful to include contract addresses like escrows that were
 * registered with a secret key via `wallet.registerContract(..., secretKey)`).
 */
export async function getWalletNotes(
  wallet: EmbeddedWallet,
  filter: {
    contractAddress: AztecAddress;
    owner?: AztecAddress;
    storageSlot?: Fr;
    scopes?: AztecAddress[];
    additionalScopes?: AztecAddress[];
  },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = wallet as any;
  let scopes: AztecAddress[];
  if (filter.scopes) {
    scopes = filter.scopes;
  } else {
    const registered = await w.pxe.getRegisteredAccounts();
    scopes = registered.map((a: any) => a.address);
    if (filter.additionalScopes) {
      scopes = [...scopes, ...filter.additionalScopes];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { additionalScopes: _ignored, ...rest } = filter;
  const fullFilter = { ...rest, scopes };
  return w.pxe.debug.getNotes(fullFilter);
}

/**
 * Syncs the PXE private state via debug utilities.
 * In v4, sync_state() on contracts is forbidden via simulate.
 */
export async function syncPXE(wallet: EmbeddedWallet) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (wallet as any).pxe.debug.sync();
}

/**
 * Converts an Fq to an Fr.
 * @param scalar - The Fq to convert.
 * @returns The converted Fr.
 */
export function grumpkinScalarToFr(scalar: Fq) {
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

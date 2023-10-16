import { Server } from "http";
import { Server as SecureServer } from "https";
import { Express } from "express";
import { ApiPromise, Keyring } from "@polkadot/api";
import { WsProvider } from "@polkadot/rpc-provider/ws";
import { SubmittableExtrinsic } from "@polkadot/api/types";
import { Hash, WeightV2 } from "@polkadot/types/interfaces";
import { CodePromise, Abi } from "@polkadot/api-contract";
import { KeyringPair } from "@polkadot/keyring/types";
import type { SignerOptions } from "@polkadot/api/submittable/types";
import { isHex } from "@polkadot/util";
import { PrometheusExporter } from "./prometheus-exporter/prometheus-exporter";
import {
  GetPrometheusExporterMetricsEndpointV1,
  IGetPrometheusExporterMetricsEndpointV1Options,
} from "./web-services/get-prometheus-exporter-metrics-endpoint-v1";

import "multer";
import { Optional } from "typescript-optional";

import OAS from "../json/openapi.json";

import {
  consensusHasTransactionFinality,
  PluginRegistry,
} from "@hyperledger/cactus-core";

import {
  IPluginLedgerConnector,
  ConsensusAlgorithmFamily,
  IPluginWebService,
  IWebServiceEndpoint,
  ICactusPlugin,
  ICactusPluginOptions,
} from "@hyperledger/cactus-core-api";

import {
  Logger,
  Checks,
  LogLevelDesc,
  LoggerProvider,
} from "@hyperledger/cactus-common";
import { promisify } from "util";
import {
  DeployContractInkRequest,
  DeployContractInkResponse,
  RawTransactionRequest,
  RawTransactionResponse,
  RunTransactionRequest,
  RunTransactionResponse,
  SignRawTransactionRequest,
  SignRawTransactionResponse,
  TransactionInfoRequest,
  TransactionInfoResponse,
  Web3SigningCredentialCactusKeychainRef,
  Web3SigningCredentialMnemonicString,
  Web3SigningCredentialType,
} from "./generated/openapi/typescript-axios/index";
import {
  GetTransactionInfoEndpoint,
  IGetTransactionInfoEndpointOptions,
} from "./web-services/get-transaction-info-endpoint";

import {
  RunTransactionEndpoint,
  IRunTransactionEndpointOptions,
} from "./web-services/run-transaction-endpoint";
import {
  GetRawTransactionEndpoint,
  IGetRawTransactionEndpointOptions,
} from "./web-services/get-raw-transaction-endpoint";
import {
  ISignRawTransactionEndpointOptions,
  SignRawTransactionEndpoint,
} from "./web-services/sign-raw-transaction-endpoint";
import {
  DeployContractInkEndpoint,
  IDeployContractInkEndpointOptions,
} from "./web-services/deploy-contract-ink-endpoint";
import {
  isWeb3SigningCredentialCactusRef,
  isWeb3SigningCredentialMnemonicString,
  isWeb3SigningCredentialNone,
} from "./model-type-guards";

export interface IPluginLedgerConnectorPolkadotOptions
  extends ICactusPluginOptions {
  logLevel?: LogLevelDesc;
  pluginRegistry: PluginRegistry;
  prometheusExporter?: PrometheusExporter;
  wsProviderUrl: string;
  instanceId: string;
  autoConnect?: boolean;
}

export interface ReadStorageRequest {
  transferSubmittable: SubmittableExtrinsic<"promise">;
}

interface ReadStorageResponse {
  success: boolean;
  hash: Hash | undefined;
}

export interface WriteStorageRequest {
  transferSubmittable: SubmittableExtrinsic<"promise">;
}

interface WriteStorageResponse {
  success: boolean;
  hash: Hash | undefined;
}

export interface ResponseContainer {
  response_data: SignerOptions;
  succeeded: boolean;
  message: string;
  error: unknown;
}

export class PluginLedgerConnectorPolkadot
  implements
    IPluginLedgerConnector<
      DeployContractInkRequest,
      DeployContractInkResponse,
      RunTransactionRequest,
      RunTransactionResponse
    >,
    ICactusPlugin,
    IPluginWebService
{
  public static readonly CLASS_NAME = "PluginLedgerConnectorPolkadot";
  private readonly instanceId: string;
  private readonly log: Logger;
  private readonly pluginRegistry: PluginRegistry;
  public wsProvider: WsProvider | undefined;
  public api: ApiPromise | undefined;
  public prometheusExporter: PrometheusExporter;
  private endpoints: IWebServiceEndpoint[] | undefined;
  private autoConnect: false | number | undefined;

  public getOpenApiSpec(): unknown {
    return OAS;
  }

  public get className(): string {
    return PluginLedgerConnectorPolkadot.CLASS_NAME;
  }

  constructor(public readonly opts: IPluginLedgerConnectorPolkadotOptions) {
    const fnTag = `${this.className}#constructor()`;
    Checks.truthy(opts, `${fnTag} arg options`);
    Checks.truthy(opts.pluginRegistry, `${fnTag} options.pluginRegistry`);
    if (typeof opts.logLevel !== "undefined") {
      Checks.truthy(opts.logLevel, `${fnTag} options.logLevelDesc`);
    }
    Checks.truthy(opts.wsProviderUrl, `${fnTag} options.wsProviderUrl`);
    Checks.truthy(opts.instanceId, `${fnTag} options.instanceId`);
    this.pluginRegistry = opts.pluginRegistry;
    this.prometheusExporter =
      opts.prometheusExporter ||
      new PrometheusExporter({ pollingIntervalInMin: 1 });
    Checks.truthy(
      this.prometheusExporter,
      `${fnTag} options.prometheusExporter`,
    );

    const level = this.opts.logLevel || "INFO";
    const label = this.className;
    this.log = LoggerProvider.getOrCreate({ level, label });

    this.instanceId = opts.instanceId;
    if (opts.autoConnect) {
      this.autoConnect = 1;
    }
    this.setProvider(opts.wsProviderUrl);
    this.prometheusExporter.startMetricsCollection();
  }

  public setProvider(wsProviderUrl: string): void {
    try {
      this.wsProvider = new WsProvider(wsProviderUrl, this.autoConnect);
    } catch (e) {
      throw Error(`Could not create wsProvider. InnerException: + ${e}`);
    }
  }

  public async createAPI(): Promise<void> {
    try {
      this.api = await ApiPromise.create({ provider: this.wsProvider });
    } catch (e) {
      throw Error("Could not create API");
    }
  }

  public async getOrCreateWebServices(): Promise<IWebServiceEndpoint[]> {
    if (Array.isArray(this.endpoints)) {
      return this.endpoints;
    }

    const { log } = this;
    log.info(`Installing web services for plugin ${this.getPackageName()}...`);

    const endpoints: IWebServiceEndpoint[] = [];
    {
      const opts: IGetPrometheusExporterMetricsEndpointV1Options = {
        connector: this,
        logLevel: this.opts.logLevel,
      };

      const endpoint = new GetPrometheusExporterMetricsEndpointV1(opts);
      endpoints.push(endpoint);
    }
    {
      const opts: IGetTransactionInfoEndpointOptions = {
        connector: this,
        logLevel: this.opts.logLevel,
      };

      const endpoint = new GetTransactionInfoEndpoint(opts);
      endpoints.push(endpoint);
    }
    {
      const opts: IRunTransactionEndpointOptions = {
        connector: this,
        logLevel: this.opts.logLevel,
      };

      const endpoint = new RunTransactionEndpoint(opts);
      endpoints.push(endpoint);
    }
    {
      const opts: IGetRawTransactionEndpointOptions = {
        connector: this,
        logLevel: this.opts.logLevel,
      };

      const endpoint = new GetRawTransactionEndpoint(opts);
      endpoints.push(endpoint);
    }
    {
      const opts: ISignRawTransactionEndpointOptions = {
        connector: this,
        logLevel: this.opts.logLevel,
      };

      const endpoint = new SignRawTransactionEndpoint(opts);
      endpoints.push(endpoint);
    }
    {
      const opts: IDeployContractInkEndpointOptions = {
        connector: this,
        logLevel: this.opts.logLevel,
      };

      const endpoint = new DeployContractInkEndpoint(opts);
      endpoints.push(endpoint);
    }

    this.endpoints = endpoints;

    const pkg = this.getPackageName();
    log.info(`Installed web services for plugin ${pkg} OK`, { endpoints });
    return endpoints;
  }

  async registerWebServices(app: Express): Promise<IWebServiceEndpoint[]> {
    const webServices = await this.getOrCreateWebServices();
    await Promise.all(webServices.map((ws) => ws.registerExpress(app)));
    return webServices;
  }

  public async shutdown(): Promise<void> {
    const serverMaybe = this.getHttpServer();
    if (serverMaybe.isPresent()) {
      const server = serverMaybe.get();
      await promisify(server.close.bind(server))();
    }
  }

  public getInstanceId(): string {
    return this.instanceId;
  }

  public getPackageName(): string {
    return `@hyperledger/cactus-plugin-ledger-connector-polkadot`;
  }

  public getHttpServer(): Optional<Server | SecureServer> {
    return Optional.empty();
  }

  public async onPluginInit(): Promise<unknown> {
    return;
  }

  public async getConsensusAlgorithmFamily(): Promise<ConsensusAlgorithmFamily> {
    return ConsensusAlgorithmFamily.Stake;
  }

  public async hasTransactionFinality(): Promise<boolean> {
    const currentConsensusAlgorithmFamily =
      await this.getConsensusAlgorithmFamily();

    return consensusHasTransactionFinality(currentConsensusAlgorithmFamily);
  }

  public rawTransaction(req: RawTransactionRequest): RawTransactionResponse {
    const fnTag = `${this.className}#rawTx()`;
    Checks.truthy(req, `${fnTag} req`);
    if (!this.api) {
      throw Error(
        "The operation has failed because the API is not connected to Substrate Node",
      );
    }
    try {
      const accountAddress = req.to;
      const transferValue = req.value;
      const rawTransaction = this.api.tx["balances"]["transfer"](
        accountAddress,
        transferValue,
      );
      const responseContainer = {
        response_data: {
          rawTransaction: rawTransaction.toHex(),
        },
        succeeded: true,
        message: "obtainRawTransaction",
        error: null,
      };

      const response: RawTransactionResponse = {
        responseContainer: responseContainer,
      };
      return response;
    } catch (e) {
      throw Error(
        `${fnTag} Obtaining raw transaction has failed. ` +
          `InnerException: ${e}`,
      );
    }
  }

  public async signTransaction(
    req: SignRawTransactionRequest,
  ): Promise<SignRawTransactionResponse> {
    const fnTag = `${this.className}#signTx()`;
    Checks.truthy(req, `${fnTag} req`);
    if (!this.api) {
      throw Error(
        "The operation has failed because the API is not connected to Substrate Node",
      );
    }
    try {
      const keyring = new Keyring({ type: "sr25519" });
      const accountPair = keyring.createFromUri(req.mnemonic);
      const deserializedRawTransaction = this.api.tx(req.rawTransaction);
      const signedTransaction = await deserializedRawTransaction.signAsync(
        accountPair,
        req.signingOptions,
      );
      const serializedSignedTransaction = signedTransaction.toHex();
      const response: SignRawTransactionResponse = {
        success: true,
        signedTransaction: serializedSignedTransaction,
      };
      return response;
    } catch (e) {
      throw Error(
        `${fnTag} signing raw transaction has failed. ` +
          `InnerException: ${e}`,
      );
    }
  }

  // Perform a monetary transaction to Polkadot;
  public async transact(
    req: RunTransactionRequest,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#transact()`;
    switch (req.web3SigningCredential.type) {
      case Web3SigningCredentialType.CactusKeychainRef: {
        return this.transactCactusKeychainRef(req);
      }
      case Web3SigningCredentialType.MnemonicString: {
        return this.transactMnemonicString(req);
      }
      case Web3SigningCredentialType.None: {
        if (req.transactionConfig.transferSubmittable) {
          return this.transactSigned(req);
        } else {
          throw new Error(
            `${fnTag} Expected pre-signed raw transaction ` +
              ` since signing credential is specified as` +
              `Web3SigningCredentialType.NONE`,
          );
        }
      }
      default: {
        throw new Error(
          `${fnTag} Unrecognized Web3SigningCredentialType: ` +
            `${req.web3SigningCredential.type} Supported ones are: ` +
            `${Object.values(Web3SigningCredentialType).join(";")}`,
        );
      }
    }
  }
  public async transactCactusKeychainRef(
    req: RunTransactionRequest,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#transactCactusKeychainRef()`;
    const { transactionConfig, web3SigningCredential } = req;
    const { keychainEntryKey, keychainId } =
      web3SigningCredential as Web3SigningCredentialCactusKeychainRef;

    // locate the keychain plugin that has access to the keychain backend
    // denoted by the keychainID from the request.
    const keychainPlugin = this.pluginRegistry.findOneByKeychainId(keychainId);

    Checks.truthy(keychainPlugin, `${fnTag} keychain for ID:"${keychainId}"`);

    // Now use the found keychain plugin to actually perform the lookup of
    // the private key that we need to run the transaction.
    const mnemonic = await keychainPlugin?.get(keychainEntryKey);
    return this.transactMnemonicString({
      web3SigningCredential: {
        type: Web3SigningCredentialType.MnemonicString,
        mnemonic,
      },
      transactionConfig,
    });
  }
  public async transactMnemonicString(
    req: RunTransactionRequest,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#transactMnemonicString()`;
    Checks.truthy(req, `${fnTag} req`);
    if (!this.api) {
      throw Error(
        "The operation has failed because the API is not connected to Substrate Node",
      );
    }
    const { transactionConfig, web3SigningCredential } = req;
    const { mnemonic } =
      web3SigningCredential as Web3SigningCredentialMnemonicString;
    let success = false;
    let transactionHash: string | undefined;
    let blockHash: string | undefined;
    try {
      const keyring = new Keyring({ type: "sr25519" });
      const accountPair = keyring.createFromUri(mnemonic);
      const accountAddress = transactionConfig.to;
      const transferValue = transactionConfig.value;
      const txResult = await new Promise<{
        success: boolean;
        transactionHash: string;
        blockhash: string;
      }>((resolve, reject) =>
        this.api?.tx.balances
          .transfer(accountAddress, transferValue)
          .signAndSend(accountPair, ({ events = [], status, txHash }) => {
            if (status.isInBlock) {
              // Check if the system.ExtrinsicSuccess event is present
              const successEvent = events.find(
                ({ event: { section, method } }) =>
                  section === "system" && method === "ExtrinsicSuccess",
              );
              if (successEvent) {
                resolve({
                  success: true,
                  blockhash: status.asInBlock.toHex(),
                  transactionHash: txHash.toHex(),
                });
              } else {
                reject("transaction not successful");
                throw Error(
                  `Transaction Failed: The expected system.ExtrinsicSuccess event was not detected.` +
                    `events emitted are ${events}`,
                );
              }
            }
          }),
      );
      success = txResult.success;
      transactionHash = txResult.transactionHash;
      blockHash = txResult.blockhash;
    } catch (e) {
      throw Error(`${fnTag} The transaction failed. ` + `InnerException: ${e}`);
    }
    return {
      success,
      txHash: transactionHash,
      blockHash: blockHash,
    };
  }
  public async transactSigned(
    req: RunTransactionRequest,
  ): Promise<RunTransactionResponse> {
    const fnTag = `${this.className}#transactSigned()`;
    Checks.truthy(
      req.transactionConfig.transferSubmittable,
      `${fnTag}:req.transactionConfig.transferSubmittable`,
    );
    const signedTx = req.transactionConfig.transferSubmittable as string;

    this.log.debug(
      "Starting api.rpc.author.submitAndWatchExtrinsic(transferSubmittable) ",
    );
    let success = false;
    let txHash: string | undefined;
    let blockHash: string | undefined;

    Checks.truthy(req, `${fnTag} req`);
    if (!this.api) {
      throw Error(
        "The operation has failed because the API is not connected to Substrate Node",
      );
    }
    const deserializedTransaction = this.api.tx(signedTx);
    const signature = deserializedTransaction.signature.toHex();
    if (!signature) {
      throw Error(`${fnTag} Transaction is not signed. `);
    }

    if (!isHex(signature)) {
      throw Error(`${fnTag} Transaction signature is not valid. `);
    }

    try {
      const txResult = await new Promise<{
        success: boolean;
        transactionHash: string;
        blockhash: string;
      }>((resolve, reject) => {
        this.api?.rpc.author.submitAndWatchExtrinsic(
          deserializedTransaction,
          ({ isInBlock, hash, asInBlock, type }) => {
            if (isInBlock) {
              resolve({
                success: true,
                blockhash: asInBlock.toHex(),
                transactionHash: hash.toHex(),
              });
            } else {
              reject("transaction not successful");
              throw Error(`transaction not submitted with status: ${type}`);
            }
          },
        );
      });

      success = txResult.success;
      txHash = txResult.transactionHash;
      blockHash = txResult.blockhash;
      success = true;
      this.prometheusExporter.addCurrentTransaction();
    } catch (e) {
      throw Error(
        `${fnTag} The transaction submission failed. ` + `InnerException: ${e}`,
      );
    }

    return { success, txHash, blockHash };
  }

  // Deploy and instantiate a smart contract in Polkadot
  public async deployContract(
    req: DeployContractInkRequest,
  ): Promise<DeployContractInkResponse> {
    const fnTag = `${this.className}#deployContract()`;
    Checks.truthy(req, `${fnTag} req`);
    if (!this.api) {
      throw Error(
        "The operation has failed because the API is not connected to Substrate Node",
      );
    }

    if (isWeb3SigningCredentialNone(req.web3SigningCredential)) {
      throw new Error(`${fnTag} Cannot deploy contract with pre-signed TX`);
    }
    let mnemonic: string;
    if (isWeb3SigningCredentialMnemonicString(req.web3SigningCredential)) {
      const web3SigningCredential =
        req.web3SigningCredential as Web3SigningCredentialMnemonicString;
      mnemonic = web3SigningCredential.mnemonic;
    } else if (isWeb3SigningCredentialCactusRef(req.web3SigningCredential)) {
      const web3SigningCredential =
        req.web3SigningCredential as Web3SigningCredentialCactusKeychainRef;
      const { keychainEntryKey, keychainId } = web3SigningCredential;
      // locate the keychain plugin that has access to the keychain backend
      // denoted by the keychainID from the request.
      const keychainPlugin =
        this.pluginRegistry.findOneByKeychainId(keychainId);

      Checks.truthy(keychainPlugin, `${fnTag} keychain for ID:"${keychainId}"`);

      // Now use the found keychain plugin to actually perform the lookup of
      // the private key that we need to run the transaction.
      mnemonic = await keychainPlugin?.get(keychainEntryKey);
    } else {
      throw new Error(
        `${fnTag} Unrecognized Web3SigningCredentialType: ` +
          `Supported ones are: ` +
          `${Object.values(Web3SigningCredentialType).join(";")}`,
      );
    }
    let success = false;
    let address: string | undefined;
    const contractAbi = new Abi(
      req.metadata,
      this.api.registry.getChainProperties(),
    );
    const contractCode = new CodePromise(
      this.api,
      contractAbi,
      Buffer.from(req.wasm, "base64"),
    );
    const gasLimit: WeightV2 = this.api.registry.createType("WeightV2", {
      refTime: req.gasLimit.refTime,
      proofSize: req.gasLimit.proofSize,
    });
    try {
      const keyring = new Keyring({ type: "sr25519" });
      const accountPair = keyring.createFromUri(mnemonic);
      const tx =
        req.params && req.params.length > 0
          ? contractCode.tx[contractAbi.constructors[0].method](
              {
                gasLimit,
                storageDepositLimit: req.storageDepositLimit,
                salt: req.salt,
                value: req.balance,
              },
              ...req.params,
            )
          : contractCode.tx[contractAbi.constructors[0].method](
              {
                gasLimit,
                storageDepositLimit: req.storageDepositLimit,
                salt: req.salt,
                value: req.balance,
              },
              undefined,
            );
      if (tx) {
        // Use Promise to ensure signAndSend completes before continuing
        const txResult = await new Promise<{
          success: boolean;
          address: string | undefined;
        }>((resolve, reject) => {
          tx?.signAndSend(
            accountPair,
            //https://github.com/polkadot-js/api/issues/5722
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            ({ contract, status, dispatchError }) => {
              if (!this.api) {
                throw Error(
                  "The operation has failed because the API is not connected to Substrate Node",
                );
              }
              if (status.isInBlock || status.isFinalized) {
                if (dispatchError) {
                  reject("deployment not successful");
                  if (dispatchError.isModule) {
                    const decoded = this.api.registry.findMetaError(
                      dispatchError.asModule,
                    );
                    const { docs, name, section } = decoded;
                    throw Error(`${section}.${name}: ${docs.join(" ")}`);
                  } else {
                    throw Error(dispatchError.toString());
                  }
                }
                address = contract.address.toString();
                resolve({ success: true, address });
              }
            },
          );
        });
        success = txResult.success;
        address = txResult.address;
      }
    } catch (e) {
      throw Error(
        `${fnTag} The contract upload and deployment failed. ` +
          `InnerException: ${e}`,
      );
    }
    if (!address) {
      this.prometheusExporter.addCurrentTransaction();
    }

    return {
      success: success,
      address: address,
    };
  }

  // Read from the smart contract's storage
  public async readStorage(
    req: ReadStorageRequest,
  ): Promise<ReadStorageResponse> {
    const fnTag = `${this.className}#readStorage()`;
    Checks.truthy(req, `${fnTag} req`);

    let success = false;
    let hash: Hash | undefined;

    Checks.truthy(req, `${fnTag} req`);

    const signature = req.transferSubmittable.signature.toHex();
    if (!signature) {
      throw Error(`${fnTag} Transaction is not signed. `);
    }

    if (!isHex(signature)) {
      throw Error(`${fnTag} Transaction signature is not valid. `);
    }

    try {
      if (this.api) {
        hash = await req.transferSubmittable.send();
        success = true;
        this.prometheusExporter.addCurrentTransaction();
      }
    } catch (e) {
      throw Error(
        `${fnTag} The read from smart contract storage operation failed. ` +
          `InnerException: ${e}`,
      );
    }

    return { success, hash };
  }

  // Write in a deployed smart contract's storage
  public async writeStorage(
    req: WriteStorageRequest,
  ): Promise<WriteStorageResponse> {
    const fnTag = `${this.className}#writeStorage()`;
    Checks.truthy(req, `${fnTag} req`);

    let success = false;
    let hash: Hash | undefined;

    Checks.truthy(req, `${fnTag} req`);

    const signature = req.transferSubmittable.signature.toHex();
    if (!signature) {
      throw Error(`${fnTag} Transaction is not signed. `);
    }

    if (!isHex(signature)) {
      throw Error(`${fnTag} Transaction signature is not valid. `);
    }

    try {
      if (this.api) {
        hash = await req.transferSubmittable.send();
        success = true;
        this.prometheusExporter.addCurrentTransaction();
      }
    } catch (e) {
      throw Error(
        `${fnTag} The write in smart contract storage operation failed. ` +
          `InnerException: ${e}`,
      );
    }

    return { success, hash };
  }

  public getPrometheusExporter(): PrometheusExporter {
    return this.prometheusExporter;
  }

  public async getPrometheusExporterMetrics(): Promise<string> {
    const res: string = await this.prometheusExporter.getPrometheusMetrics();
    this.log.debug(`getPrometheusExporterMetrics() response: %o`, res);
    return res;
  }

  // Obtains information to sign a transaction
  public async obtainTransactionInformation(
    req: TransactionInfoRequest,
  ): Promise<TransactionInfoResponse> {
    const fnTag = `${this.className}#obtainTxInformation()`;
    Checks.truthy(req, `${fnTag} req`);

    this.log.info(`getTxFee`);
    try {
      if (this.api) {
        const accountAddress = req.accountAddress as KeyringPair;
        const transactionExpiration =
          (req.transactionExpiration as number) || 50;
        const signedBlock = await this.api.rpc.chain.getBlock();

        const nonce = (
          await this.api.derive.balances.account(accountAddress.address)
        ).accountNonce;
        const blockHash = signedBlock.block.header.hash;
        const era = this.api.createType("ExtrinsicEra", {
          current: signedBlock.block.header.number,
          period: transactionExpiration,
        });

        const options = {
          nonce: nonce,
          blockHash: blockHash,
          era: era,
        };

        const responseContainer = {
          response_data: options,
          succeeded: true,
          message: "obtainTransactionInformation",
          error: null,
        };

        const response: TransactionInfoResponse = {
          responseContainer: responseContainer,
        };

        return response;
      } else {
        throw Error(
          "The operation has failed because the api is not connected to Substrate Node",
        );
      }
    } catch (e) {
      throw Error(
        `${fnTag} Obtaining info for this transaction has failed. ` +
          `InnerException: ${e}`,
      );
    }
  }

  public async shutdownConnectionToSubstrate(): Promise<void> {
    try {
      if (this.api) {
        this.log.info("Shutting down connection to substrate...");
        this.api.disconnect();
      } else {
        this.log.warn(
          "Trying to shutdown connection to substrate, but no connection is available",
        );
      }
    } catch (error) {
      this.log.error("Could not disconnect from Substrate Ledger");
      throw new Error("Could not disconnect from Substrate Ledger");
    }
  }
}

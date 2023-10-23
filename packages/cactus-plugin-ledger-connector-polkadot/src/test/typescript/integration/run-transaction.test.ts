import { PrometheusExporter } from "../../../main/typescript/prometheus-exporter/prometheus-exporter";
import { AddressInfo } from "net";
import { v4 as uuidv4 } from "uuid";
import type { SignerOptions } from "@polkadot/api/submittable/types";
import type {
  CodecHash,
  ExtrinsicEra,
  Index,
} from "@polkadot/types/interfaces";
import { Configuration } from "@hyperledger/cactus-core-api";
import { Keyring } from "@polkadot/api";
import http from "http";
import express from "express";
import test, { Test } from "tape-promise/tape";
import { pruneDockerAllIfGithubAction } from "@hyperledger/cactus-test-tooling";
import {
  IListenOptions,
  LogLevelDesc,
  Servers,
} from "@hyperledger/cactus-common";
import { SubstrateTestLedger } from "../../../../../cactus-test-tooling/src/main/typescript/substrate-test-ledger/substrate-test-ledger";
import {
  PluginLedgerConnectorPolkadot,
  IPluginLedgerConnectorPolkadotOptions,
  DefaultApi as PolkadotApi,
} from "../../../main/typescript/public-api";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";

const testCase = "transact through all available methods  ";
const logLevel: LogLevelDesc = "TRACE";
const DEFAULT_WSPROVIDER = "ws://127.0.0.1:9944";
const instanceId = "test-polkadot-connector";
const prometheus: PrometheusExporter = new PrometheusExporter({
  pollingIntervalInMin: 1,
});

test("BEFORE " + testCase, async (t: Test) => {
  const pruning = pruneDockerAllIfGithubAction({ logLevel });
  await t.doesNotReject(pruning, "Pruning didn't throw OK");
  t.end();
});

test(testCase, async (t: Test) => {
  test.onFinish(async () => {
    await ledger.stop();
    await plugin.shutdownConnectionToSubstrate();
    await pruneDockerAllIfGithubAction({ logLevel });
  });
  const ledgerOptions = {
    publishAllPorts: false,
    logLevel: logLevel,
    emitContainerLogs: true,
  };
  const ledger = new SubstrateTestLedger(ledgerOptions);
  await ledger.start();
  t.ok(ledger);
  const keychainEntryKey = uuidv4();
  const keychainEntryValue = "//Alice";
  const keychainPlugin = new PluginKeychainMemory({
    instanceId: uuidv4(),
    keychainId: uuidv4(),
    // pre-provision keychain with mock backend holding the private key of the
    // test account that we'll reference while sending requests with the
    // signing credential pointing to this keychain entry.
    backend: new Map([[keychainEntryKey, keychainEntryValue]]),
    logLevel,
  });
  const connectorOptions: IPluginLedgerConnectorPolkadotOptions = {
    logLevel: logLevel,
    prometheusExporter: prometheus,
    pluginRegistry: new PluginRegistry({ plugins: [keychainPlugin] }),
    wsProviderUrl: DEFAULT_WSPROVIDER,
    instanceId: instanceId,
  };
  const plugin = new PluginLedgerConnectorPolkadot(connectorOptions);
  await plugin.createAPI();
  const expressApp = express();

  expressApp.use(express.json());
  expressApp.use(express.urlencoded({ extended: false }));

  const server = http.createServer(expressApp);
  const listenOptions: IListenOptions = {
    hostname: "0.0.0.0",
    port: 0,
    server,
  };
  const addressInfo = (await Servers.listen(listenOptions)) as AddressInfo;
  test.onFinish(async () => await Servers.shutdown(server));

  const { address, port } = addressInfo;
  const apiHost = `http://${address}:${port}`;

  const apiConfig = new Configuration({ basePath: apiHost });
  const apiClient = new PolkadotApi(apiConfig);

  await plugin.getOrCreateWebServices();
  await plugin.registerWebServices(expressApp);

  if (!plugin.api) {
    t.fail("failed to create api instance");
    return;
  }

  test("transact using pre-signed transaction", async (t2: Test) => {
    const keyring = new Keyring({ type: "sr25519" });
    const alicePair = keyring.createFromUri("//Alice");
    const bobPair = keyring.createFromUri("//Bob");

    const infoForSigningTransaction = await apiClient.getTransactionInfo({
      accountAddress: alicePair.address,
      transactionExpiration: 500,
    });
    t2.equal(infoForSigningTransaction.status, 200);
    const response = infoForSigningTransaction.data;
    t2.ok(response);
    const nonce = response.responseContainer.response_data.nonce as Index;
    t2.ok(nonce);
    const blockHash = response.responseContainer.response_data
      .blockHash as CodecHash;
    t2.ok(blockHash);
    const era = response.responseContainer.response_data.era as ExtrinsicEra;
    t2.ok(era);

    const signingOptions: SignerOptions = {
      nonce: nonce,
      blockHash: blockHash,
      era: era,
    };

    const transaction = await apiClient.getRawTransaction({
      to: bobPair.address,
      value: 20,
    });
    const rawTransaction =
      transaction.data.responseContainer.response_data.rawTransaction;

    const signedTransactionResponse = await apiClient.signRawTransaction({
      rawTransaction: rawTransaction,
      mnemonic: "//Alice",
      signingOptions: signingOptions,
    });
    t2.ok(signedTransactionResponse.data.success);
    t2.ok(signedTransactionResponse.data.signedTransaction);
    t2.comment(`Signed transaction is: ${rawTransaction}`);

    t2.ok(rawTransaction);
    const signedTransaction = signedTransactionResponse.data.signedTransaction;
    const TransactionDetails = await apiClient.runTransaction({
      web3SigningCredential: { type: "NONE" },
      transactionConfig: {
        transferSubmittable: signedTransaction,
      },
    });
    t2.equal(TransactionDetails.status, 200);
    const transactionResponse = TransactionDetails.data;
    t2.ok(transactionResponse);
    t2.ok(transactionResponse.success);
    t2.ok(transactionResponse.txHash);
    t2.ok(transactionResponse.blockHash);
    t2.end();
  });

  test("transact using passing mnemonic string", async (t3: Test) => {
    const keyring = new Keyring({ type: "sr25519" });
    const bobPair = keyring.createFromUri("//Bob");
    const TransactionDetails = await apiClient.runTransaction({
      web3SigningCredential: { type: "MNEMONIC_STRING", mnemonic: "//Alice" },
      transactionConfig: {
        to: bobPair.address,
        value: 30,
      },
    });
    t3.equal(TransactionDetails.status, 200);
    const transactionResponse = TransactionDetails.data;
    t3.ok(transactionResponse);
    t3.ok(transactionResponse.success);
    t3.ok(transactionResponse.txHash);
    t3.ok(transactionResponse.blockHash);
    t3.end();
  });
  test("transact using passing cactus keychain ref", async (t4: Test) => {
    const keyring = new Keyring({ type: "sr25519" });
    const bobPair = keyring.createFromUri("//Bob");
    const TransactionDetails = await apiClient.runTransaction({
      web3SigningCredential: {
        type: "CACTUS_KEYCHAIN_REF",
        keychainEntryKey: keychainEntryKey,
        keychainId: keychainPlugin.getKeychainId(),
      },
      transactionConfig: {
        to: bobPair.address,
        value: 30,
      },
    });
    t4.equal(TransactionDetails.status, 200);
    const transactionResponse = TransactionDetails.data;
    t4.ok(transactionResponse);
    t4.ok(transactionResponse.success);
    t4.ok(transactionResponse.txHash);
    t4.ok(transactionResponse.blockHash);
    t4.end();
  });
  t.end();
});

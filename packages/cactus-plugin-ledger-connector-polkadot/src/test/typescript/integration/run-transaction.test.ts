import { PrometheusExporter } from "../../../main/typescript/prometheus-exporter/prometheus-exporter";
import { AddressInfo } from "net";
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

const testCase = "Instantiate plugin";
const logLevel: LogLevelDesc = "TRACE";
const pluginRegistry = undefined;
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
  const connectorOptions: IPluginLedgerConnectorPolkadotOptions = {
    logLevel: logLevel,
    prometheusExporter: prometheus,
    pluginRegistry: pluginRegistry,
    wsProviderUrl: DEFAULT_WSPROVIDER,
    instanceId: instanceId,
  };

  const ledgerOptions = {
    publishAllPorts: false,
    logLevel: logLevel,
    emitContainerLogs: true,
  };

  const tearDown = async () => {
    await ledger.stop();
    await plugin.shutdownConnectionToSubstrate();
    await pruneDockerAllIfGithubAction({ logLevel });
  };

  test.onFinish(tearDown);
  const ledger = new SubstrateTestLedger(ledgerOptions);
  await ledger.start();
  t.ok(ledger);

  const plugin = new PluginLedgerConnectorPolkadot(connectorOptions);
  await plugin.createAPI();

  const keyring = new Keyring({ type: "sr25519" });
  const alicePair = keyring.createFromUri("//Alice");
  const bobPair = keyring.createFromUri("//Bob");

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
  const infoForSigningTransaction = await apiClient.getTransactionInfo({
    accountAddress: alicePair,
    transactionExpiration: 500,
  });
  t.equal(infoForSigningTransaction.status, 200);
  const response = infoForSigningTransaction.data;
  t.ok(response);
  const nonce = response.responseContainer.response_data.nonce as Index;
  t.ok(nonce);
  const blockHash = response.responseContainer.response_data
    .blockHash as CodecHash;
  t.ok(blockHash);
  const era = response.responseContainer.response_data.era as ExtrinsicEra;
  t.ok(era);

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
  t.ok(signedTransactionResponse.data.success);
  t.ok(signedTransactionResponse.data.signedTransaction);
  t.comment(`Signed transaction is: ${rawTransaction}`);

  t.ok(rawTransaction);
  const signedTransaction = signedTransactionResponse.data.signedTransaction;
  const TransactionDetails = await apiClient.runTransaction({
    transferSubmittable: signedTransaction,
  });
  t.equal(TransactionDetails.status, 200);
  const transactionResponse = TransactionDetails.data;
  t.ok(transactionResponse);
  t.ok(transactionResponse.success);
  t.ok(transactionResponse.hash);
  t.end();
});

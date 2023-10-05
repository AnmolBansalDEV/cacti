import { PrometheusExporter } from "../../../main/typescript/prometheus-exporter/prometheus-exporter";
import { LogLevelDesc } from "@hyperledger/cactus-common";
import { SubstrateTestLedger } from "../../../../../cactus-test-tooling/src/main/typescript/substrate-test-ledger/substrate-test-ledger";
import type {
  CodecHash,
  ExtrinsicEra,
  Index,
} from "@polkadot/types/interfaces";
import test, { Test } from "tape-promise/tape";
import { pruneDockerAllIfGithubAction } from "@hyperledger/cactus-test-tooling";
import {
  PluginLedgerConnectorPolkadot,
  IPluginLedgerConnectorPolkadotOptions,
} from "../../../main/typescript";
import { Keyring } from "@polkadot/api";

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
  await plugin.getOrCreateWebServices();
  if (!plugin.api) {
    t.fail("failed to create api instance");
    return;
  }
  const keyring = new Keyring({ type: "sr25519" });
  const alicePair = keyring.createFromUri("//Alice");
  const bobPair = keyring.createFromUri("//Bob");

  const result = await plugin.obtainTransactionInformation({
    accountAddress: alicePair,
    transactionExpiration: 50,
  });
  t.ok(result);
  const signingOptions = {
    nonce: result.responseContainer.response_data.nonce as Index,
    blockHash: result.responseContainer.response_data.blockHash as CodecHash,
    era: result.responseContainer.response_data.era as ExtrinsicEra,
  };
  const transaction = plugin.rawTransaction({
    to: bobPair.address,
    value: 23,
  });
  t.ok(transaction.responseContainer.succeeded);
  const rawTransaction =
    transaction.responseContainer.response_data.rawTransaction;
  const sign = await plugin.signTransaction({
    mnemonic: "//Alice",
    rawTransaction,
    signingOptions,
  });
  t.ok(sign.success);
  t.ok(sign.signedTransaction);
  if (!sign.signedTransaction) {
    throw new Error("failed");
  }
  const resul = await plugin.transact({
    transferSubmittable: sign.signedTransaction,
  });
  t.ok(result);
  t.ok(resul.success);
  t.end();
});

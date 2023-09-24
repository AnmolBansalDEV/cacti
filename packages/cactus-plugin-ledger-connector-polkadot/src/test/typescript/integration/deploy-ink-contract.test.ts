import { PrometheusExporter } from "../../../main/typescript/prometheus-exporter/prometheus-exporter";
import { LogLevelDesc } from "@hyperledger/cactus-common";
import { SubstrateTestLedger } from "../../../../../cactus-test-tooling/src/main/typescript/substrate-test-ledger/substrate-test-ledger";
import abi from "../../rust/fixtures/ink/metadata.json";
import fs from "fs";

import test, { Test } from "tape-promise/tape";

import { pruneDockerAllIfGithubAction } from "@hyperledger/cactus-test-tooling";

import {
  PluginLedgerConnectorPolkadot,
  IPluginLedgerConnectorPolkadotOptions,
  DeployContractInkBytecodeRequest,
} from "../../../main/typescript";
import { WeightV2 } from "@polkadot/types/interfaces";
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

  const rawWasm = fs.readFileSync(
    "packages/cactus-plugin-ledger-connector-polkadot/src/test/rust/fixtures/ink/flipper.wasm",
  );

  const proofSize = 131072;
  const refTime = 6219235328;
  if (!plugin.api) {
    t.fail("failed to create api instance");
    return;
  }
  const gasLimit: WeightV2 = plugin.api.registry.createType("WeightV2", {
    refTime,
    proofSize,
  });

  const keyring = new Keyring({ type: "sr25519" });
  const alicePair = keyring.createFromUri("//Alice");

  const result = plugin.deployContract({
    wasm: rawWasm,
    abi: abi,
    gasLimit: gasLimit,
    storageDepositLimit: null,
    account: alicePair,
    params: [true],
  } as DeployContractInkBytecodeRequest);

  t.ok(result);
  t.ok((await result).success);
  t.end();
});

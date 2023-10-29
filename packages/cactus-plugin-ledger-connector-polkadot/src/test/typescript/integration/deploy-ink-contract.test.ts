import {
  IListenOptions,
  LogLevelDesc,
  Servers,
} from "@hyperledger/cactus-common";
import { SubstrateTestLedger } from "../../../../../cactus-test-tooling/src/main/typescript/substrate-test-ledger/substrate-test-ledger";
import metadata from "../../rust/fixtures/ink/metadata.json";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import test, { Test } from "tape-promise/tape";
import { pruneDockerAllIfGithubAction } from "@hyperledger/cactus-test-tooling";
import express from "express";
import http from "http";
import {
  PluginLedgerConnectorPolkadot,
  IPluginLedgerConnectorPolkadotOptions,
  DefaultApi as PolkadotApi,
} from "../../../main/typescript/public-api";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { AddressInfo } from "net";
import { Configuration } from "@hyperledger/cactus-core-api";

const testCase = "deploy contract through all available methods";
const logLevel: LogLevelDesc = "TRACE";
const DEFAULT_WSPROVIDER = "ws://127.0.0.1:9944";
const instanceId = "test-polkadot-connector";

test("BEFORE " + testCase, async (t: Test) => {
  const pruning = pruneDockerAllIfGithubAction({ logLevel });
  await t.doesNotReject(pruning, "Pruning didn't throw OK");
  t.end();
});

test(testCase, async (t: Test) => {
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
  const keychainEntryKey = uuidv4();
  const keychainEntryValue = "//Bob";
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
  await plugin.registerWebServices(expressApp);
  await plugin.getOrCreateWebServices();
  if (!plugin.api) {
    t.fail("failed to create api instance");
    return;
  }
  const rawWasm = fs.readFileSync(
    "packages/cactus-plugin-ledger-connector-polkadot/src/test/rust/fixtures/ink/flipper.wasm",
  );
  const proofSize = 131072;
  const refTime = 6219235328;
  const gasLimit = {
    refTime,
    proofSize,
  };
  test("deploy contract with pre-signed TX", async (t2: Test) => {
    const result = apiClient.deployContractInk({
      wasm: rawWasm.toString("base64"),
      metadata: JSON.stringify(metadata),
      gasLimit: gasLimit,
      storageDepositLimit: null,
      salt: new Uint8Array().toString(),
      web3SigningCredential: { type: "NONE" },
      params: [false],
    });
    await t2.rejects(result, "cannot deploy contract with pre signed TX");
    t2.end();
  });
  test("deploy contract using passing mnemonic string", async (t3: Test) => {
    const result = await apiClient.deployContractInk({
      wasm: rawWasm.toString("base64"),
      metadata: JSON.stringify(metadata),
      gasLimit: gasLimit,
      storageDepositLimit: null,
      salt: new Uint8Array().toString(),
      web3SigningCredential: { type: "MNEMONIC_STRING", mnemonic: "//Alice" },
      params: [false],
    });
    t3.ok(result);
    t3.ok(result.data.success);
    t3.ok(result.data.contractAddress);
    t3.end();
  });
  test("deploy contract using passing cactus keychain ref", async (t4: Test) => {
    const result = await apiClient.deployContractInk({
      wasm: rawWasm.toString("base64"),
      metadata: JSON.stringify(metadata),
      gasLimit: gasLimit,
      storageDepositLimit: null,
      salt: new Uint8Array().toString(),
      web3SigningCredential: {
        type: "CACTUS_KEYCHAIN_REF",
        keychainEntryKey: keychainEntryKey,
        keychainId: keychainPlugin.getKeychainId(),
      },
      params: [false],
    });
    t4.ok(result);
    t4.ok(result.data.success);
    t4.ok(result.data.contractAddress);
    t4.end();
  });
  t.end();
});

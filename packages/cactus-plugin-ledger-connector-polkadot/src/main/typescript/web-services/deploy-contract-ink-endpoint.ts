import type { Express, Request, Response } from "express";
import {
  Logger,
  LoggerProvider,
  LogLevelDesc,
  Checks,
  IAsyncProvider,
} from "@hyperledger/cactus-common";

import {
  IWebServiceEndpoint,
  IExpressRequestHandler,
  IEndpointAuthzOptions,
} from "@hyperledger/cactus-core-api";

import { handleRestEndpointException, registerWebServiceEndpoint } from "@hyperledger/cactus-core";

import { PluginLedgerConnectorPolkadot } from "../plugin-ledger-connector-polkadot";
import OAS from "../../json/openapi.json";

export interface IDeployContractInkEndpointOptions {
  logLevel?: LogLevelDesc;
  connector: PluginLedgerConnectorPolkadot;
}

export class DeployContractInkEndpoint implements IWebServiceEndpoint {
  private readonly log: Logger;
  public static readonly CLASS_NAME = "DeployContractInkEndpoint";

  constructor(public readonly opts: IDeployContractInkEndpointOptions) {
    const fnTag = "DeployContractInkEndpoint#constructor()";

    Checks.truthy(opts, `${fnTag} options`);
    Checks.truthy(opts.connector, `${fnTag} arg options.connector`);

    const level = this.opts.logLevel || "INFO";
    const label = this.className;
    this.log = LoggerProvider.getOrCreate({ level, label });
  }

  public get className(): string {
    return DeployContractInkEndpoint.CLASS_NAME;
  }

  getAuthorizationOptionsProvider(): IAsyncProvider<IEndpointAuthzOptions> {
    // TODO: make this an injectable dependency in the constructor
    return {
      get: async () => ({
        isProtected: true,
        requiredRoles: [],
      }),
    };
  }

  public getExpressRequestHandler(): IExpressRequestHandler {
    return this.handleRequest.bind(this);
  }

  public getPath(): string {
    return this.oasPath.post["x-hyperledger-cactus"].http.path;
  }

  public getVerbLowerCase(): string {
    return this.oasPath.post["x-hyperledger-cactus"].http.verbLowerCase;
  }

  public getOperationId(): string {
    return this.oasPath.post.operationId;
  }

  public get oasPath(): (typeof OAS.paths)["/api/v1/plugins/@hyperledger/cactus-plugin-ledger-connector-polkadot/deploy-contract-ink"] {
    return OAS.paths[
      "/api/v1/plugins/@hyperledger/cactus-plugin-ledger-connector-polkadot/deploy-contract-ink"
    ];
  }

  public async registerExpress(
    expressApp: Express,
  ): Promise<IWebServiceEndpoint> {
    await registerWebServiceEndpoint(expressApp, this);
    return this;
  }

  async handleRequest(req: Request, res: Response): Promise<void> {
    const fnTag = `${this.className}#handleRequest()`;
    const reqTag = `${this.getVerbLowerCase()} - ${this.getPath()}`;
    this.log.debug(reqTag);
    const reqBody = req.body;
    try {
      const resBody = await this.opts.connector.deployContract(reqBody);
      res.json(resBody);
    } catch (ex) {
      const errorMsg = `${reqTag} ${fnTag} Failed to deploy contract:`;
      handleRestEndpointException({ errorMsg, log: this.log, error: ex, res });
    }
  }
}

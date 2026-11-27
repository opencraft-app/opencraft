import { generateKeyPair, randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { publicOrigin } from "@opencraft/hub-network";
import { parseRelayConfiguration, type RelayConfiguration } from "./application.js";

const generateKeyPairAsync = promisify(generateKeyPair);

export interface InitializeSelfHostedRelayOptions {
  readonly origin: string;
  readonly port?: number;
  readonly host?: "127.0.0.1" | "0.0.0.0";
  readonly instanceId?: string;
  readonly targetPort?: number;
  readonly issuer?: string;
}

export interface InitializedSelfHostedRelay {
  readonly directory: string;
  readonly relayConfigPath: string;
  readonly connectionConfigPath: string;
  readonly operatorCredentialPath: string;
  readonly machineGatewayCredentialPath: string;
  readonly origin: string;
  readonly instanceId: string;
  readonly routeCredential: string;
}

async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
}

/**
 * One-command async bootstrapper for self-hosted `opencraft-relay` deployments.
 * Eliminates manual Ed25519 key generation, 43-char token formatting, and `0600`
 * file permission setup while keeping zero synchronous IO on the Node event loop.
 */
export async function initializeSelfHostedRelayDirectory(
  directory: string,
  options: InitializeSelfHostedRelayOptions,
): Promise<InitializedSelfHostedRelay> {
  if (!isAbsolute(directory) || directory.includes("\0")) {
    throw new Error("Self-hosted relay directory must be an absolute path");
  }
  const normalizedOrigin = publicOrigin(options.origin);
  const originUrl = new URL(normalizedOrigin);
  const port = options.port ?? (originUrl.port ? Number(originUrl.port) : 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid relay port");
  }
  const isLoopback = originUrl.hostname === "127.0.0.1" || originUrl.hostname === "localhost";
  const host = options.host ?? (isLoopback ? "127.0.0.1" : "0.0.0.0");
  const instanceId = options.instanceId ?? "primary-workstation";
  const issuer = options.issuer ?? "opencraft-self-hosted-relay";
  const targetPort = options.targetPort ?? 4200;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const { publicKey, privateKey } = await generateKeyPairAsync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const routeCredential = randomBytes(32).toString("base64url");
  const operatorCredential = randomBytes(32).toString("base64url");
  const machineGatewayCredential = randomBytes(32).toString("base64url");

  const relayConfigPath = join(directory, "relay.json");
  const connectionConfigPath = join(directory, "connection.json");
  const operatorCredentialPath = join(directory, "operator-credential.json");
  const machineGatewayCredentialPath = join(directory, "machine-gateway-credential.json");

  const relayConfig: RelayConfiguration = parseRelayConfiguration({
    schemaVersion: 1,
    host,
    port,
    ...(host === "0.0.0.0" ? { tlsTermination: "trusted-proxy" as const } : {}),
    authentication: {
      issuer,
      privateKey,
      origin: normalizedOrigin,
      providers: ["local"],
    },
    routes: [
      {
        instanceId,
        name: "Primary Workstation",
        origin: normalizedOrigin,
        credential: routeCredential,
      },
    ],
    machineGateway: {
      credentialFile: machineGatewayCredentialPath,
      origin: normalizedOrigin,
    },
    hubNetwork: {
      stateFile: join(directory, "hub-state.json"),
      operatorCredentialFile: operatorCredentialPath,
    },
  });

  const connectionConfig = {
    schemaVersion: 1,
    relay: normalizedOrigin,
    credential: routeCredential,
    targetPort,
    ...(isLoopback && originUrl.protocol === "http:" ? { allowLoopbackInsecure: true } : {}),
    issuer,
    instanceId,
    origin: normalizedOrigin,
    publicKey,
  };

  await Promise.all([
    writePrivateJsonAtomic(operatorCredentialPath, { schemaVersion: 1, credential: operatorCredential }),
    writePrivateJsonAtomic(machineGatewayCredentialPath, { schemaVersion: 1, credential: machineGatewayCredential }),
    writePrivateJsonAtomic(relayConfigPath, relayConfig),
    writePrivateJsonAtomic(connectionConfigPath, connectionConfig),
  ]);

  return {
    directory,
    relayConfigPath,
    connectionConfigPath,
    operatorCredentialPath,
    machineGatewayCredentialPath,
    origin: normalizedOrigin,
    instanceId,
    routeCredential,
  };
}

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  dockerEngine,
  parseDockerProvisionerPolicy,
  serveDockerProvisioner,
} from "@opencraft/sandbox-node/docker-provisioner-service";

/** The Compose `provisioner` service: the only container holding the Docker socket. It
 * serves the docker-provisioner protocol to the Gateway on a private control volume and
 * creates workspace containers from its own policy (deploy/docker/README.md
 * "Multiple workspaces"). The policy is either an operator JSON file
 * (`OPENCRAFT_PROVISIONER_POLICY_FILE`) or the default below: one `workspace` alias, the
 * deployment's own image running `workspace-agent --role hands`. */

const WORKSPACE_ROOT = "/var/lib/opencraft-workspace";

const positive = (name, raw, fallback) => {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

export function defaultProvisionerPolicy(env = process.env) {
  const required = (name) => {
    const value = env[name];
    if (!value) throw new Error(`Set ${name}`);
    return value;
  };
  const uid = required("OPENCRAFT_UID"),
    gid = required("OPENCRAFT_GID");
  const cpuMillis = Math.round(positive("OPENCRAFT_WORKSPACE_CPUS", env.OPENCRAFT_WORKSPACE_CPUS, "4") * 1000);
  const memoryBytes = positive("OPENCRAFT_WORKSPACE_MEMORY_BYTES", env.OPENCRAFT_WORKSPACE_MEMORY_BYTES, 8 * 1024 ** 3);
  const data = `${WORKSPACE_ROOT}/data`,
    execution = `${data}/execution`;
  return {
    deployment: env.OPENCRAFT_PROVISIONER_DEPLOYMENT || "opencraft",
    maxWorkspaces: positive("OPENCRAFT_PROVISIONER_MAX_WORKSPACES", env.OPENCRAFT_PROVISIONER_MAX_WORKSPACES, 8),
    network: env.OPENCRAFT_PROVISIONER_NETWORK || "opencraft-workspaces",
    links: { volume: required("OPENCRAFT_PROVISIONER_LINK_VOLUME") },
    linkDirectory: env.OPENCRAFT_PROVISIONER_LINK_DIR || "/run/opencraft-provisioner-links",
    images: {
      workspace: {
        image: required("OPENCRAFT_PROVISIONER_WORKSPACE_IMAGE"),
        command: ["/opt/opencraft/bin/node", "/opt/opencraft/runtime/workspace-agent.mjs", "--role", "hands"],
        user: `${uid}:${gid}`,
        cpuMillis,
        memoryBytes,
        pidsLimit: 4096,
        volumeTarget: WORKSPACE_ROOT,
        // The workspace volume is a cache (Git is the content truth): data and checkouts live in it.
        env: {
          OPENCRAFT_DATA_DIR: data,
          OPENCRAFT_WORKSPACE_DIR: `${WORKSPACE_ROOT}/workspace`,
          OPENCRAFT_EXECUTION_DIR: execution,
          OPENCRAFT_LOG_DIR: `${WORKSPACE_ROOT}/logs`,
          OPENCRAFT_HANDS_EXECUTION_SOCKET: `${execution}/exec-owner.sock`,
          OPENCRAFT_HANDS_EXECUTION_TOKEN: `${execution}/exec-owner.token`,
          OPENCRAFT_CODEX_EXECUTABLE: "/opt/opencraft/runtime/codex/bin/codex",
          OPENCRAFT_HANDS_CPUS: String(cpuMillis / 1000),
          OPENCRAFT_HANDS_MEMORY_BYTES: String(memoryBytes),
          HOME: execution,
        },
      },
    },
  };
}

export async function startProvisioner(env = process.env) {
  const directory = env.OPENCRAFT_PROVISIONER_DIR || "/run/opencraft-provisioner";
  const socket = env.OPENCRAFT_PROVISIONER_DOCKER_SOCKET || "/var/run/docker.sock";
  if (!isAbsolute(directory) || !isAbsolute(socket)) throw new Error("Provisioner paths must be absolute");
  const policy = parseDockerProvisionerPolicy(
    env.OPENCRAFT_PROVISIONER_POLICY_FILE
      ? JSON.parse(await readFile(env.OPENCRAFT_PROVISIONER_POLICY_FILE, "utf8"))
      : defaultProvisionerPolicy(env),
  );
  return serveDockerProvisioner({ directory, policy, docker: dockerEngine(socket) });
}

import { LocalAttachmentStore } from "../adapters/filesystem/attachment-store.mjs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryFileAuthority } from "../adapters/memory/file-authority.mjs";
import { SqliteMemoryIndex, memoryFileCommitReceipt } from "../adapters/sqlite/memory-index.mjs";
import { fault } from "../adapters/local/profile.mjs";
import { LocalCredentialVault } from "../adapters/local/credential-vault.mjs";
import { Assistant } from "../domain/assistant.mjs";
import { ScopePolicy } from "../application/scope-policy.mjs";
import { AssistantApplication } from "../application/assistant-application.mjs";
import { SqliteUnitOfWork } from "../adapters/sqlite/database.mjs";
import { sqliteRepositories } from "../adapters/sqlite/repositories.mjs";
import { SqliteReceptionReadModel } from "../adapters/sqlite/reception-read-model.mjs";

/** Composition only: application services do not import these concrete adapters. */
export function createLocalDomain(
  profile,
  knowledgeSource = null,
  {
    now = Date.now,
    claimWriter = false,
    attachmentMaxBytes,
    assertAuthority,
    platformReads = null,
    platformThreads = null,
    executionEnvironment = null,
  } = {},
) {
  const assistant = new Assistant(profile.config),
    scope = new ScopePolicy(
      assistant,
      [
        ...(knowledgeSource ? [knowledgeSource.reference()] : []),
        ...(platformThreads ? [platformThreads] : []),
        ...(executionEnvironment ? [executionEnvironment] : []),
        ...(platformReads && profile.config.botBinding
          ? [
              {
                id: "platform.reads",
                binding: JSON.stringify(profile.config.botBinding),
              },
            ]
          : []),
      ],
      () => memoryFiles?.resources() ?? [],
    );
  let memoryFiles;
  const uow = new SqliteUnitOfWork(profile);
  try {
    if (claimWriter) uow.claimWriter();
    uow.authorityGuard = assertAuthority;
    const vault = new LocalCredentialVault(profile);
    let app;
    const index = new SqliteMemoryIndex(uow);
    memoryFiles = new MemoryFileAuthority(profile, uow, index, {
      committed: (j) => memoryFileCommitReceipt(DatabaseSync, j.profile, j),
      fault: (stage) => fault(profile, stage),
      onExternalChange: (fence) => app.memory.filesChanged(fence),
    });
    const reads = new SqliteReceptionReadModel(uow);
    const refreshedReads = Object.freeze(
      Object.fromEntries(
        Object.getOwnPropertyNames(SqliteReceptionReadModel.prototype)
          .filter((k) => k !== "constructor")
          .map((k) => [
            k,
            (...args) => {
              memoryFiles.synchronize();
              return reads[k](...args);
            },
          ]),
      ),
    );
    const attachmentStore = new LocalAttachmentStore(join(profile.path, "attachments"), {
      maxBytes: attachmentMaxBytes,
    });
    app = new AssistantApplication({
      now,
      attachments: Object.freeze({
        describe: (id) => attachmentStore.describe(id),
        list: (params) => attachmentStore.list(params),
      }),
      memoryFiles: Object.freeze(
        Object.fromEntries(
          ["synchronize", "resources", "projects", "project", "locations", "browserFiles", "read"].map((k) => [
            k,
            (...args) => memoryFiles[k](...args),
          ]),
        ),
      ),
      memoryDefaultScope: profile.config.memoryDefaultScope,
      credentials: Object.freeze({
        describe: (reference) => vault.describe(reference),
      }),
      assistant,
      scope,
      uow,
      repositories: sqliteRepositories(uow),
      mode: profile.config.mode,
      executionHarness: profile.config.harnesses?.execution ?? "pi",
      timeZone: profile.config.timeZone,
      memoryPolicy: profile.config.memoryPolicy,
      receptionReads: refreshedReads,
      platformReads,
      receptionMaterials: knowledgeSource
        ? Object.freeze({
            reference: () => knowledgeSource.reference(),
            list: (directory) => knowledgeSource.list(directory),
            read: (path) => knowledgeSource.read(path),
          })
        : null,
    });
    uow.participate(memoryFiles);
    memoryFiles.synchronize();
    return { app, uow, attachmentStore };
  } catch (error) {
    uow.close();
    throw error;
  }
}

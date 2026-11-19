import { createMemoryBrowser } from "./memory-browser.mjs";
import { assistantHostExtension } from './host-extension.mjs';
import { LocalAttachmentStore } from "../adapters/filesystem/attachment-store.mjs";
import { join } from "node:path";
import { workObservation } from "./work-observation.mjs";
import { startPersonalAssistant } from "./personal-assistant.mjs";
import { LocalRunner } from "./local-runner.mjs";
import { loadProfile } from "../adapters/local/profile.mjs";
import { platformAssistantPort } from "../adapters/local/platform-assistant-port.mjs";

/** One runtime lifetime; transport and platform authorization remain separate owners. */
export function createAssistantSession(peer, onStopped) {
  let auxiliary, runner, memoryBrowser,
    stopping = false,
    timer,
    work,
    start;
  const lifetime = new AbortController();
  const request = (method, params, signal = lifetime.signal) =>
    peer.request("platform/" + method, params, { signal, ...(method === "environment/run" ? {timeoutMs:180000} : {}) });
  async function close() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    lifetime.abort();
    await start?.catch(() => {});
    await work?.catch(() => {});
    try {
      await Promise.allSettled([auxiliary?.close(),runner?.close()]);
    } finally {
      onStopped();
    }
  }
  return {
    close,
    async handle(method, params) {
      if (method === "initialize") {
        if (start || stopping) throw Error("Already initialized");
        if (
          params?.protocolVersion !== 1 ||
          (typeof params.profile === "string") ===
            (typeof params.directory === "string")
        )
          throw Error("Invalid initialization");
        start = launch(params);
        await start;
        if (stopping || !runner) throw Error("Initialization failed");
        return {
          protocolVersion: 1,
          capabilities: { dispatch: true, observe: true },
          pid: process.pid,
        };
      }
      if(method==='memory'&&memoryBrowser&&!stopping)return memoryBrowser(params);
      if (method === "observe" && runner && !stopping) return observe();
      if (method === "dispatch" && runner && !stopping)
        return runner.dispatch(params);
      throw Error("Method unavailable");
    },
  };
  async function observe() {
    const status = await runner.dispatch({ op: "status", params: {} });
    if (runner.stopping || status?.healthError) throw Error("Assistant runtime unavailable");
    return { value: status.reception, works: workObservation(status.works) };
  }
  async function launch(config) {
    const port = platformAssistantPort({ request });
    try {
      runner = config.profile
        ? await LocalRunner.open(loadProfile(config.profile))
        : await startPersonalAssistant({
            serverDirectory: config.directory,
            profileOptions: config.profileOptions,
            port,
            signal: lifetime.signal,
            overrides: {
              ...(config.executionEnvironment
                ? {
                    executionEnvironment: config.executionEnvironment,
                    runEnvironment: async (params, signal) => {
                      const cancel = () => {
                        void peer
                          .request(
                            "platform/environment/cancel",
                            { workId: params.workId, callId: params.callId },
                            { timeoutMs: 1000 },
                          )
                          .catch(() => {});
                      };
                      signal?.throwIfAborted();
                      signal?.addEventListener("abort", cancel, { once: true });
                      try {
                        return await request("environment/run", params, signal);
                      } catch {
                        throw Object.assign(
                          Error(
                            "Environment command outcome is unknown; do not replay",
                          ),
                          { code: "ENVIRONMENT_OUTCOME_UNKNOWN" },
                        );
                      } finally {
                        signal?.removeEventListener("abort", cancel);
                      }
                    },
                  }
                : {}),
              resolveModel: (config, context) =>
                request("resolve-model", {
                  providerId: config.providerId,
                  modelId: config.modelId,
                  purpose: context?.purpose ?? "execution",
                }),
              resolveModelFailure: (purpose) =>
                request("model-failure", { purpose }),
              messageTransport: {
                async deliver(message, signal) {
                  if (
                    message.body.files?.length ||
                    message.body.type === "secret-request" ||
                    message.body.type === "authorization-request"
                  )
                    throw Error(
                      "This message requires a dedicated secure or attachment transport",
                    );
                  const text =
                    message.body.content ?? message.body.question?.prompt;
                  if (typeof text !== "string" || !text.trim())
                    throw Error("No native text representation");
                  const receipt = await request(
                    "reply",
                    { id: message.id, text },
                    signal,
                  );
                  return {
                    messageId: message.id,
                    channel: message.body.channel,
                    level: "accepted",
                    remoteId: receipt.messageId,
                  };
                },
              },
            },
          });
      if(!config.profile)memoryBrowser=createMemoryBrowser({memory:runner.app.memory,history:runner.app.history,transact:f=>runner.uow.transaction(f),authorize:()=>request('opencraft/personal-assistant/authorize',{})});
      if (stopping) {
        await runner.close();
        onStopped();
      } else {
        if(!config.profile)auxiliary=assistantHostExtension()?.createRuntime?.({directory:config.directory,profileOptions:config.profileOptions,request,signal:lifetime.signal});
        const cursorKey = "host:native-inbox:sequence";
        async function poll() {
          if (!config.profile) {
            const after = Number(
              runner.uow.db
                .prepare("SELECT value FROM meta WHERE key=?")
                .get(cursorKey)?.value ?? 0,
            );
            let rows;
            try {
              rows = await request("own-messages", { after });
            } catch {
              // A failed read is not runtime corruption. Keep the durable cursor and
              // retry on the next poll only if the original binding is still authorized.
              if (runner.stopping) throw Error("Assistant runtime unavailable");
              await port.authorize(
                runner.profile.config.botBinding,
                lifetime.signal,
              );
              peer.notify("activity-unavailable");
              return;
            }
            for (const row of rows) {
              if (stopping) return;
              if (row.author_id === runner.profile.config.botBinding.owner.id) {
                let attachments;
                if(row.attachment){
                  let offset=0,name,expectedSize,total=0;const chunks=[];
                  do{
                    const file=await request('attachment',{messageId:row.id,offset});
                    if(!file||file.size>8*1024*1024||file.size<0||(expectedSize!==undefined&&expectedSize!==file.size))throw Error('Attachment unavailable');
                    name=file.name;expectedSize=file.size;const chunk=Buffer.from(file.base64,'base64');total+=chunk.length;
                    if(total>expectedSize||file.next!==null&&(file.next!==offset+65536||chunk.length!==65536))throw Error('Invalid attachment chunk');
                    chunks.push(chunk);offset=file.next;
                  }while(offset!==null);
                  if(total!==expectedSize)throw Error('Incomplete attachment');
                  const stored=new LocalAttachmentStore(join(runner.profile.path,'attachments')).importBytes(name,Buffer.concat(chunks,total));
                  attachments=[stored.attachmentId];
                }
                const response = await runner.dispatch({
                  op: "say",
                  id: "native:" + row.id,
                  params: { text: row.content, ...(attachments?{attachments}:{}) },
                });
                if (response?.ok === false)
                  throw Error("Assistant intake rejected");
              }
              runner.uow.transaction(() =>
                runner.uow.db
                  .prepare(
                    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  )
                  .run(cursorKey, String(row.seq)),
              );
            }
          }
          await auxiliary?.poll();
          peer.notify("activity", await observe());
        }
        const tick = () => {
          if (!work && !stopping)
            work = poll()
              .catch(() => {
                peer.notify("failed");
                queueMicrotask(() => void close());
              })
              .finally(() => {
                work = undefined;
              });
        };
        timer = setInterval(tick, 1000);
        tick();
        peer.notify("ready");
      }
    } catch (error) {
      peer.notify("startup-failure",{reason:String(error?.message??error).replace(/\s+/gu," ").slice(0,200)});
      peer.notify("failed");
      await Promise.allSettled([auxiliary?.close(),runner?.close()]);
      onStopped();
    }
  }
}

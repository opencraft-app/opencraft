import { registerDshSubprocessSandbox } from "./dsh-subprocess-sandbox.mjs";
import { registerDshExecutionEnvironment } from './dsh-execution-environment.mjs';
import { createAcpExecutionThreadResolver } from '@opencraft/plugin-acp-engine/execution-thread-resolver';

export async function apply(ctx, config) {
  await registerDshSubprocessSandbox(ctx);
  registerDshExecutionEnvironment(ctx, createAcpExecutionThreadResolver(config.routesDirectory));
}

import { registerDshSubprocessSandbox } from "./dsh-subprocess-sandbox.mjs";
import { registerDshExecutionEnvironment } from './dsh-execution-environment.mjs';
import { createAcpExecutionThreadResolver } from '../../../plugins/acp-engine/src/execution-thread-resolver.mjs';

export async function apply(ctx, config) {
  await registerDshSubprocessSandbox(ctx);
  registerDshExecutionEnvironment(ctx, createAcpExecutionThreadResolver(config.routesDirectory));
}

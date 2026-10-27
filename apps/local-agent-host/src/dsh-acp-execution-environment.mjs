import { registerDshExecutionEnvironment } from './dsh-execution-environment.mjs';
import { createAcpExecutionThreadResolver } from '../../../plugins/acp-engine/src/execution-thread-resolver.mjs';

export function apply(ctx, config) {
  registerDshExecutionEnvironment(ctx, createAcpExecutionThreadResolver(config.routesDirectory));
}

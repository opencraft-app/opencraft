import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PiEngine, piModel } from '@opencraft/plugin-pi-engine';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { OnboardingDeps } from './agent-onboarding.js';

class NativePiEngine extends PiEngine {
  constructor(options: ConstructorParameters<typeof PiEngine>[0], private readonly nativeModels: ModelRuntime) { super(options); }
  override async models() {
    await this.nativeModels.refresh({allowNetwork:false});
    return super.models();
  }
}

/** Borrow native Pi authentication and catalog; OpenCraft owns its new sessions
 * and preferences. Existing Pi transcripts and credential files are not copied. */
export async function createConnectedPi(directory: string, cwd: string, deps: Pick<OnboardingDeps, 'env' | 'homedir'>, modelPolicyPath?:string, executionCli?: import("@opencraft/session-capabilities/execution-cli").ScopedExecutionCliPort): Promise<PiEngine> {
  const native = deps.env.PI_CODING_AGENT_DIR || join(deps.homedir, '.pi', 'agent');
  const models = await ModelRuntime.create({authPath: join(native, 'auth.json'), modelsPath: join(native, 'models.json'), modelsStorePath:join(directory,'native-model-cache.json'), allowModelNetwork: false});
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (typeof settings.defaultProvider === 'string' && typeof settings.defaultModel === 'string') {
    const model = models.getAvailableSnapshot().find(model => model.provider === settings.defaultProvider && model.id === settings.defaultModel);
    if (model) try {
      await writeFile(join(directory, 'defaults.json'), JSON.stringify({model: piModel(model.provider, model.id),
        ...(typeof settings.defaultThinkingLevel === 'string' ? {effort: settings.defaultThinkingLevel} : {})}), {flag:'wx',mode:0o600});
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  return new NativePiEngine({directory, cwd, models,modelPolicyPath,executionCli}, models);
}

import { Service, type Context } from "@deepseek-ai/cordis";
import { EnvironmentDirectory } from "./directory";
declare module "@deepseek-ai/cordis" { interface Context { environmentDirectory: EnvironmentDirectoryService } }
export class EnvironmentDirectoryService extends Service {
  readonly directory = new EnvironmentDirectory();
  constructor(ctx: Context) {
    super(ctx, "environmentDirectory");
    ctx.effect(() => () => this.directory.close());
  }
}

import { routeSessionPersistence } from "./dsh-thread-storage.mjs";
export const inject = ["sessions"];
export async function apply(ctx, { moduleUrl, ...config }) {
  const { default: Base } = await import(moduleUrl);
  await ctx.plugin(routeSessionPersistence(Base), config);
}

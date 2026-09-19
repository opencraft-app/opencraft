import { routeProjectionCache } from "./dsh-thread-storage.mjs";
export const inject = ["sessionProjections", "storageDomain"];
export async function apply(ctx, { moduleUrl, ...config }) {
  const { default: Base } = await import(moduleUrl);
  await ctx.plugin(routeProjectionCache(Base), config);
}

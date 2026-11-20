/** Authorization probe only. Settings DOM and catalog readers load on demand. */
export interface ModelPolicyDocument {
  canManage: boolean; revision: number;
  rules: { engine: string; model?: string; effort?: string }[];
}
export async function readModelPolicy(fetcher: typeof fetch = globalThis.fetch): Promise<ModelPolicyDocument> {
  const response = await fetcher('/__opencraft_model_policy', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw Error('Unable to load model restrictions');
  return await response.json() as ModelPolicyDocument;
}

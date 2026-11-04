export const limits: Record<string,number>;
export const components: readonly string[];
export function sanitizeEvent(input: unknown,now?: number): Record<string,any> | null;

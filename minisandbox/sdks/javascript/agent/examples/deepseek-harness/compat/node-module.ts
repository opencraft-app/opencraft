declare const DSH_LLM_VERSION: string;

/**
 * dsh-llm reads its package version through createRequire(import.meta.url) to
 * build an attribution header. Dynamic workerd modules intentionally have no
 * file URL, so provide only that exact metadata lookup and fail closed for any
 * future CommonJS dependency.
 */
export function createRequire(_url: unknown): (path: string) => { version: string } {
	return (path: string) => {
		if (path !== "../package.json") {
			throw new Error(`Unsupported Harness CommonJS import: ${path}`);
		}
		return { version: DSH_LLM_VERSION };
	};
}

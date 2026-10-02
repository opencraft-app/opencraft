import { Context } from "@deepseek-ai/cordis";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolResultPruner, {
	PRUNE_MARKER,
} from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import { afterEach, describe, expect, it } from "vitest";

let context: Context | undefined;

afterEach(async () => {
	await context?.fiber.dispose();
	context = undefined;
});

describe("DeepSeek Harness compaction wiring", () => {
	it("prunes oversized tool output without splitting Unicode code points", async () => {
		context = new Context();
		await context.plugin(SessionProjectionRegistry);
		await context.plugin(TokenMeter);
		await context.plugin(ToolResultPruner);

		const original = `head-${"🧪".repeat(9_000)}-tail`;
		const pruned = context.toolResultPruner.pruneContent([
			{ type: "text", text: original },
		]);

		expect(pruned).not.toBeNull();
		const text = pruned?.[0]?.type === "text" ? pruned[0].text : "";
		expect(text).toContain(PRUNE_MARKER);
		expect(text).toContain("head-");
		expect(text).toContain("-tail");
		expect(Array.from(text).length).toBeLessThanOrEqual(8_192);
	});
});

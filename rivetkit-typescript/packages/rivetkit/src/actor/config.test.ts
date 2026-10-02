import { describe, expect, test } from "vitest";
import { ActorOptionsSchema } from "./config";

describe("ActorOptionsSchema", () => {
	test("keeps the Actor Runtime Socket opt-in", () => {
		expect(ActorOptionsSchema.parse({}).enableActorRuntimeSocket).toBe(
			false,
		);
		expect(
			ActorOptionsSchema.parse({ enableActorRuntimeSocket: true })
				.enableActorRuntimeSocket,
		).toBe(true);
	});
});

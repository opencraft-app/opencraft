import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import ToolResultPruner from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import {
	createUserMessage,
	LlmAdapter,
	LlmRuntime,
	type GenerateOptions,
	type LlmResolvedModelInfo,
	type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { DurableObject } from "cloudflare:workers";

const SESSION_KEY = "deepseek-harness-session-v1";
const MAX_MESSAGE_BYTES = 64 * 1024;
const CLOUDAGENTS_ENDPOINT = "https://tokenhub.tencentmaas.com/v1/chat/completions";
const CLOUDAGENTS_MODEL = "minimax-m2.7";
const CLOUDAGENTS_CONTEXT_WINDOW = 204_800;
const ECHO_CONTEXT_WINDOW = 1_024;

interface TurnRequest {
	message?: unknown;
}

interface TurnResult {
	output: string;
	events: readonly SessionEvent[];
}

interface SessionStats {
	event_count: number;
	compaction_count: number;
	pruned_tool_result_count: number;
}

interface ChatCompletionResponse {
	choices?: Array<{ message?: { content?: unknown } }>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

class EchoAdapter extends LlmAdapter {
	resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
		return Promise.resolve({
			provider,
			id: model,
			name: model,
			inputModalities: ["text"],
			context: { contextWindow: ECHO_CONTEXT_WINDOW },
			defaultMaxTokens: 256,
		});
	}

	async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
		if (options.purpose === "compaction") {
			yield* completedText(
				"The earlier deterministic-test conversation was compacted.",
				16,
				8,
			);
			return;
		}
		const input = textContent(options.messages.at(-1)?.content ?? []);
		yield* completedText(`echo:${input}`, 1, 1);
	}
}

class CloudAgentsAdapter extends LlmAdapter {
	constructor(private readonly apiKey: string) {
		super();
	}

	resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
		return Promise.resolve({
			provider,
			id: model,
			name: model,
			inputModalities: ["text"],
			context: { contextWindow: CLOUDAGENTS_CONTEXT_WINDOW },
			defaultMaxTokens: 4_096,
		});
	}

	async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
		const messages = [
			...(options.system === undefined
				? []
				: [{ role: "system", content: options.system }]),
			...options.messages.map((message) => ({
				role: message.role,
				content: textContent(message.content),
			})),
		];
		const response = await fetch(CLOUDAGENTS_ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: options.model,
				messages,
				stream: false,
				...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
			}),
		});
		if (!response.ok) {
			throw new Error(`CloudAgents model request failed with HTTP ${response.status}`);
		}
		const result = (await response.json()) as ChatCompletionResponse;
		const output = result.choices?.[0]?.message?.content;
		if (typeof output !== "string") {
			throw new Error("CloudAgents returned no assistant content");
		}
		yield* completedText(
			output,
			result.usage?.prompt_tokens ?? 0,
			result.usage?.completion_tokens ?? 0,
		);
	}
}

function* completedText(
	text: string,
	inputTokens: number,
	outputTokens: number,
): Iterable<StreamChunk> {
	yield { type: "block-start", index: 0, blockType: "text" };
	yield { type: "text-delta", index: 0, text };
	yield { type: "block-end", index: 0, block: { type: "text", text } };
	yield { type: "usage", usage: { inputTokens, outputTokens } };
	yield { type: "finish", reason: { kind: "stop" } };
}

function textContent(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((block): block is { type: string; text: string } =>
			(block.type === "text" || block.type === "reasoning") && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

async function runTurn(
	message: string,
	seed: readonly SessionEvent[],
	apiKey: string | undefined,
): Promise<TurnResult> {
	const { ctx, provider } = await createHarness(apiKey);

	try {
		const handle = await ctx.agents.create({
			sessionId: SessionId("agent"),
			seed,
			agentOptions: {
				provider,
				model: apiKey === undefined ? "echo" : CLOUDAGENTS_MODEL,
			},
		});
		try {
			handle.agent.followup(
				createUserMessage({
					content: [{ type: "text", text: message }],
					source: { kind: "user" },
				}),
			);
			await handle.agent.whenIdle();
			const events = handle.agent.session.snapshotEvents();
			const assistant = events
				.slice(seed.length)
				.filter((event) => event.type === "assistant/message")
				.at(-1);
			if (assistant?.type !== "assistant/message") {
				throw new Error("DeepSeek Harness produced no assistant message");
			}
			return { output: textContent(assistant.data.message.content), events };
		} finally {
			await handle.dispose();
		}
	} finally {
		await ctx.fiber.dispose();
	}
}

async function compactSession(
	seed: readonly SessionEvent[],
	apiKey: string | undefined,
): Promise<{ events: readonly SessionEvent[]; summary: string | null }> {
	const { ctx, provider } = await createHarness(apiKey);
	try {
		const handle = await ctx.agents.create({
			sessionId: SessionId("agent"),
			seed,
			agentOptions: {
				provider,
				model: apiKey === undefined ? "echo" : CLOUDAGENTS_MODEL,
			},
		});
		try {
			const result = await ctx.compaction.compactNow(
				handle.agent,
				new AbortController().signal,
			);
			return {
				events: handle.agent.session.snapshotEvents(),
				summary: result === null ? null : textContent(result.summary),
			};
		} finally {
			await handle.dispose();
		}
	} finally {
		await ctx.fiber.dispose();
	}
}

async function createHarness(
	apiKey: string | undefined,
): Promise<{ ctx: Context; provider: "echo" | "cloudagents" }> {
	const ctx = new Context();
	await ctx.plugin(LlmRuntime);
	await ctx.plugin(SessionStore);
	await ctx.plugin(SessionProjectionRegistry);
	await ctx.plugin(SystemPrompt, {
		persona: "You are a concise, helpful persistent agent.",
	});
	await ctx.plugin(ToolRuntime);
	await ctx.plugin(AgentRegistry);
	await ctx.plugin(AgentLoop, { agents: [] });
	await ctx.plugin(TokenMeter);
	await ctx.plugin(ToolResultPruner);
	await ctx.plugin(BasicCompactionEngine, {
		auto: true,
		modelPolicies: [
			{
				provider: "echo",
				model: "echo",
				thresholdRatio: 0.5,
				retainTokens: 96,
				maxTokens: 128,
				compactionRetries: 1,
				maxOverflowRetries: 1,
			},
		],
	});

	const provider = apiKey === undefined ? "echo" : "cloudagents";
	ctx.llm.registerAdapter(
		[provider],
		apiKey === undefined ? new EchoAdapter() : new CloudAgentsAdapter(apiKey),
	);
	return { ctx, provider };
}

function sessionStats(events: readonly SessionEvent[]): SessionStats {
	return {
		event_count: events.length,
		compaction_count: events.filter((event) => event.type === "compaction/summary").length,
		pruned_tool_result_count: events.filter((event) => event.type === "compaction/prune")
			.length,
	};
}

export class DeepSeekHarnessAgent extends DurableObject {
	#tail: Promise<void> = Promise.resolve();

	async fetch(request: Request): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (request.method !== "POST" || (pathname !== "/messages" && pathname !== "/compact")) {
			return Response.json({ error: "POST /messages or POST /compact is required" }, {
				status: 404,
			});
		}
		const declaredLength = Number(request.headers.get("content-length") ?? 0);
		if (declaredLength > MAX_MESSAGE_BYTES) {
			return Response.json({ error: "request is too large" }, { status: 413 });
		}

		let input: TurnRequest = {};
		if (pathname === "/messages") {
			try {
				const encoded = await request.text();
				if (new TextEncoder().encode(encoded).byteLength > MAX_MESSAGE_BYTES) {
					return Response.json({ error: "request is too large" }, { status: 413 });
				}
				input = JSON.parse(encoded) as TurnRequest;
			} catch {
				return Response.json({ error: "request body must be JSON" }, { status: 400 });
			}
			if (
				typeof input.message !== "string" ||
				input.message.length === 0 ||
				new TextEncoder().encode(input.message).byteLength > MAX_MESSAGE_BYTES
			) {
				return Response.json({ error: "message must be a non-empty string up to 64 KiB" }, {
					status: 400,
				});
			}
		}

		const authorization = request.headers.get("authorization");
		const echoMode = request.headers.get("x-harness-test-provider") === "echo";
		if (!echoMode && !authorization?.startsWith("Bearer ")) {
			return Response.json({ error: "a model credential is required" }, { status: 401 });
		}
		const apiKey = echoMode ? undefined : authorization?.slice("Bearer ".length);
		const result = this.#tail.then(async () => {
			const encoded = await this.ctx.storage.get<string>(SESSION_KEY);
			const seed = encoded === undefined ? [] : (JSON.parse(encoded) as SessionEvent[]);
			if (pathname === "/compact") {
				const compacted = await compactSession(seed, apiKey);
				await this.ctx.storage.put(SESSION_KEY, JSON.stringify(compacted.events));
				return Response.json({
					compacted: compacted.summary !== null,
					summary: compacted.summary,
					...sessionStats(compacted.events),
					model: apiKey === undefined ? "echo" : CLOUDAGENTS_MODEL,
				});
			}
			const turn = await runTurn(input.message as string, seed, apiKey);
			await this.ctx.storage.put(SESSION_KEY, JSON.stringify(turn.events));
			return Response.json({
				output: turn.output,
				...sessionStats(turn.events),
				model: apiKey === undefined ? "echo" : CLOUDAGENTS_MODEL,
			});
		});
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await result;
		} catch (error) {
			console.error("DeepSeek Harness turn failed", error);
			return Response.json({ error: "agent turn failed" }, { status: 502 });
		}
	}
}

export default {
	fetch(): Response {
		return new Response("ready");
	},
};

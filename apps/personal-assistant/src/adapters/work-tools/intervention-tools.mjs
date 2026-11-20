import { Type } from "@earendil-works/pi-ai";
const defineTool = (definition) => definition;

export function interventionTool({ request, guard, onWait }) {
  return defineTool({
    name: "request_intervention",
    description:
      "Suspend for owner intervention: authorization (owner supplies a credential for a named provider), secret (secure local input), or handoff (owner performs an external action). Never ask for secret values in chat. Returns metadata/reference or owner report, not proof of external success; grants no new tool authority.",
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("authorization"),
        Type.Literal("secret"),
        Type.Literal("handoff"),
      ]),
      question: Type.String({ minLength: 1, maxLength: 10000 }),
      provider: Type.Optional(Type.String()),
      expiresInMs: Type.Optional(
        Type.Integer({ minimum: 1000, maximum: 86400000 }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      guard("request_intervention");
      const interaction = request(api.callId, args);
      if (interaction.state === "answered")
        return { output: [{ type: "text", text: interaction.answer }] };
      return context.suspend(interaction);
    },
  });
}

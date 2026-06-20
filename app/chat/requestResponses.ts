import type { ClientInputEvent } from "../../packages/vela-chat-client/src";
import type { RequestDockResponse } from "../../packages/vela-chat-web/src/components/requests/RequestDock";

export function buildRequestResponseInputEvent(response: RequestDockResponse): ClientInputEvent {
  switch (response.kind) {
    case "confirmation":
      return {
        type: "user.tool_confirmation",
        request_id: response.requestId,
        result: response.result,
      };
    case "answer":
      return {
        type: "user.request_answer",
        request_id: response.requestId,
        answer: response.answer,
      };
  }
}

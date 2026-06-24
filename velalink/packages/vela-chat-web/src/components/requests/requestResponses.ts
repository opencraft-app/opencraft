import type { ClientInputEvent } from "../../../../vela-chat-client/src";
import type { RequestDockResponse } from "./RequestDock";

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

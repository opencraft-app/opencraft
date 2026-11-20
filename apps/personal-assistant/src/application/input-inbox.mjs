import { requireText, stable } from "../domain/values.mjs";

/** Admission owner. The receipt and all synchronous command changes commit together. */
export class InputInbox {
  delivered(id) {
    this.inputs.delivered(id, this.now());
  }
  constructor(uow, inputs, events, now = Date.now) {
    Object.assign(this, { uow, inputs, events, now });
  }
  accept(id, op, params, apply) {
    requireText(id, "id", 160);
    return this.uow.transaction(() => {
      const previous = this.inputs.get(id),
        payload = { op, params };
      if (previous) {
        if (previous.payload !== stable(payload))
          throw new Error("Input id reused with different payload");
        return { ...JSON.parse(previous.response), duplicate: true };
      }
      const response = apply();
      this.inputs.add(id, payload, response, this.now());
      this.events.append(
        "input.received",
        response.workId,
        { inputId: id, op },
        this.now(),
      );
      return response;
    });
  }
}

import { attachmentSourceFromAsset } from "./attachment-picker";

describe("attachmentSourceFromAsset", () => {
  it("prefers the browser File object and keeps native URI as a fallback", () => {
    const file = { name: "diagram.png" };

    expect(
      attachmentSourceFromAsset({
        file,
        mimeType: "image/png",
        name: "diagram.png",
        size: 456,
        uri: "blob:https://example.invalid/diagram",
      }),
    ).toEqual({
      file,
      kind: "platform-file",
      mimeType: "image/png",
      name: "diagram.png",
      size: 456,
    });
    expect(
      attachmentSourceFromAsset({
        mimeType: "application/pdf",
        name: "spec.pdf",
        uri: "file:///private/spec.pdf",
      }),
    ).toEqual({
      kind: "uri",
      mimeType: "application/pdf",
      name: "spec.pdf",
      uri: "file:///private/spec.pdf",
    });
  });
});

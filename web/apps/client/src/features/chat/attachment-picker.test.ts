import { attachmentSourceFromAsset } from "./attachment-picker";

describe("attachmentSourceFromAsset", () => {
  it("prefers the browser File object and keeps native URI as a fallback", () => {
    const file = { name: "diagram.png" };

    expect(
      attachmentSourceFromAsset({
        file,
        height: 480,
        mimeType: "image/png",
        name: "diagram.png",
        size: 456,
        uri: "blob:https://example.invalid/diagram",
        width: 640,
      }),
    ).toEqual({
      file,
      height: 480,
      kind: "platform-file",
      mimeType: "image/png",
      name: "diagram.png",
      previewUri: "blob:https://example.invalid/diagram",
      size: 456,
      width: 640,
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

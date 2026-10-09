import { findCredentialLeaks } from "./credential-scan";

describe("credential scan", () => {
  it("detects bearer tokens, JWTs and private keys without returning secret text", () => {
    const findings = findCredentialLeaks({
      "src/token.ts":
        'const authorization = "Bearer example_secret_token_1234567890";',
      "src/session.ts":
        'const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature_value";',
      "src/key.ts":
        "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
    });

    expect(findings).toEqual([
      { file: "src/key.ts", kind: "private-key" },
      { file: "src/session.ts", kind: "jwt" },
      { file: "src/token.ts", kind: "bearer-token" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(
      "example_secret_token",
    );
  });

  it("ignores normal identifiers and hashes", () => {
    expect(
      findCredentialLeaks({
        "src/model.ts":
          'const serverId = "019fb625-bea4-7042-b383-cbe9dae9c9b1";',
        "src/hash.ts":
          'const revision = "620f6ee663e06d1a50570bd2a5755d8b22c689b6b6b593faf54de0f3c0bed442";',
      }),
    ).toEqual([]);
  });
});

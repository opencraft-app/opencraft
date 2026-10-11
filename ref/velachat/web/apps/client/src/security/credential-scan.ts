export type CredentialLeakKind =
  | "bearer-token"
  | "jwt"
  | "private-key";

export interface CredentialLeak {
  file: string;
  kind: CredentialLeakKind;
}

const credentialPatterns: ReadonlyArray<{
  kind: CredentialLeakKind;
  pattern: RegExp;
}> = [
  {
    kind: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/,
  },
  {
    kind: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    kind: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

export function findCredentialLeaks(
  files: Readonly<Record<string, string>>,
): CredentialLeak[] {
  return Object.entries(files)
    .flatMap(([file, source]) =>
      credentialPatterns
        .filter(({ pattern }) => pattern.test(source))
        .map(({ kind }) => ({ file, kind })),
    )
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.kind.localeCompare(right.kind),
    );
}

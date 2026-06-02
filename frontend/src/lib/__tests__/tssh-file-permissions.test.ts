import { describe, expect, it } from "vitest";
import { canReadTsshFile, extractTsshUnixPermissions } from "@/lib/tssh-file-permissions";

const agentuser = {
  uid: 1000,
  gid: 1000,
  userName: "agentuser",
};

describe("tssh file permissions", () => {
  it("extracts symbolic and octal Unix read modes", () => {
    expect(extractTsshUnixPermissions({ rights: "-rw-------" })).toBe("rw-------");
    expect(extractTsshUnixPermissions({ rights: "0644" })).toBe("rw-r--r--");
    expect(extractTsshUnixPermissions({ longname: "-rwxr-x--- 1 agentuser agentuser 12 May 29 run.sh" })).toBe("rwxr-x---");
  });

  it("allows files readable by owner, group, or others", () => {
    expect(canReadTsshFile({ rights: "-rw-------", owner: 1000, group: 1000 }, agentuser)).toBe(true);
    expect(canReadTsshFile({ rights: "-rw-r-----", owner: 0, group: 1000 }, agentuser)).toBe(true);
    expect(canReadTsshFile({ rights: "-rw-r--r--", owner: 0, group: 0 }, agentuser)).toBe(true);
    expect(canReadTsshFile({ longname: "-rw------- 1 agentuser staff 12 May 29 private.txt" }, agentuser)).toBe(true);
  });

  it("blocks root-owned owner-only files for agentuser", () => {
    expect(canReadTsshFile({ rights: "-rw-------", owner: 0, group: 0 }, agentuser)).toBe(false);
    expect(canReadTsshFile({ rights: "0600", owner: 0, group: 0 }, agentuser)).toBe(false);
    expect(canReadTsshFile({ longname: "-rw------- 1 root root 4096 May 29 swap.img" }, agentuser)).toBe(false);
  });

  it("allows unknown modes so the TAT file channel can return the authoritative error", () => {
    expect(canReadTsshFile({}, agentuser)).toBe(true);
    expect(canReadTsshFile({ rights: "unknown" }, agentuser)).toBe(true);
  });
});

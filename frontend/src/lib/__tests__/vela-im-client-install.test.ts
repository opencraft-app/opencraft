import { describe, expect, it } from "vitest";
import { buildImClientInstallCommand, buildImClientInstallStartCommand, didInstallImClient, VELA_IM_CLIENT_RELEASE } from "@/lib/vela-im-client-install";

describe("IM client install command", () => {
  it("pins both checksums and executes only a verified installer", () => {
    const command = buildImClientInstallCommand();
    expect(command).toContain(VELA_IM_CLIENT_RELEASE.installerSha256);
    expect(command).toContain(VELA_IM_CLIENT_RELEASE.binarySha256);
    expect(command.indexOf("sha256sum -c -")).toBeLessThan(command.indexOf('sh "$vela_im_stage/install.sh"'));
    expect(command).not.toContain("sudo");
    expect(command).not.toContain("daemon run");
  });
  it("rejects URL and version shell injection", () => {
    expect(() => buildImClientInstallCommand({ ...VELA_IM_CLIENT_RELEASE, binaryUrl: "https://example.test/'; rm -rf x" })).toThrow();
    expect(() => buildImClientInstallCommand({ ...VELA_IM_CLIENT_RELEASE, version: "v1.0.0; evil" })).toThrow();
  });
  it("detaches the long download from short Bot execution and locks duplicate launches", () => {
    const command = buildImClientInstallStartCommand();
    expect(command).toContain("flock -n 9");
    expect(command).toContain('nohup sh "$vela_im_job/run.sh"');
    expect(command).toContain('>"$vela_im_job/state.next"');
  });
  it("requires exact completion and a successful exit", () => {
    const output = `VELA_IM_CLIENT_INSTALLED ${VELA_IM_CLIENT_RELEASE.version}`;
    expect(didInstallImClient({ exitCode: 0, output })).toBe(true);
    expect(didInstallImClient({ exitCode: 1, output })).toBe(false);
    expect(didInstallImClient({ exitCode: 0, output: `unexpected ${output}` })).toBe(false);
  });
});

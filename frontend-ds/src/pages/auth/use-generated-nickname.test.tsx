import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGeneratedNickname } from "@/pages/auth/use-generated-nickname";

describe("useGeneratedNickname", () => {
  it("creates an initial nickname and can refresh it", () => {
    const generateNickname = vi.fn().mockReturnValueOnce("海盐小猫").mockReturnValueOnce("晨雾小狐");

    const { result } = renderHook(() => useGeneratedNickname(generateNickname));

    expect(result.current.name).toBe("海盐小猫");

    act(() => {
      result.current.refreshName();
    });

    expect(result.current.name).toBe("晨雾小狐");
    expect(generateNickname).toHaveBeenCalledTimes(2);
  });

  it("avoids returning the same nickname immediately after refresh when possible", () => {
    const generateNickname = vi
      .fn()
      .mockReturnValueOnce("海盐小猫")
      .mockReturnValueOnce("海盐小猫")
      .mockReturnValueOnce("晨雾小狐");

    const { result } = renderHook(() => useGeneratedNickname(generateNickname));

    act(() => {
      result.current.refreshName();
    });

    expect(result.current.name).toBe("晨雾小狐");
    expect(generateNickname).toHaveBeenCalledTimes(3);
  });
});

import React from "react";
import {act, render} from "@testing-library/react-native";

var mockGlobalParams: {computerId?: string} = {computerId: "computer-a"};
var mockLocalParams: {computerId?: string} = {computerId: "computer-a"};
var mockMountCount = 0;
var mockUnmountCount = 0;
var mockSelectedComputerIds: Array<string | null | undefined> = [];

jest.mock("expo-router", () => ({
  Slot: () => null,
  useGlobalSearchParams: () => mockGlobalParams,
  useLocalSearchParams: () => mockLocalParams,
}));

jest.mock("../management/expo-management-route-surface", () => ({
  ExpoManagementRouteSurface: (props: {selectedComputerId?: string | null}) => {
    require("react").useEffect(() => {
      mockMountCount += 1;
      return () => {
        mockUnmountCount += 1;
      };
    }, []);
    mockSelectedComputerIds.push(props.selectedComputerId);
    return null;
  },
}));

import ComputersLayout from "@/app/(app)/s/[serverId]/computers/_layout";

function LayoutHarness({tick}: {tick: string}) {
  void tick;
  return <ComputersLayout />;
}

describe("Computers retained route layout", () => {
  beforeEach(() => {
    mockGlobalParams = {computerId: "computer-a"};
    mockLocalParams = {computerId: "computer-a"};
    mockMountCount = 0;
    mockUnmountCount = 0;
    mockSelectedComputerIds = [];
  });

  it("projects global child-route changes without remounting the management surface", async () => {
    const screen = await render(<LayoutHarness tick="a" />);
    expect(mockSelectedComputerIds.at(-1)).toBe("computer-a");
    expect(mockMountCount).toBe(1);

    await act(async () => {
      mockGlobalParams.computerId = "computer-b";
      screen.rerender(<LayoutHarness tick="b" />);
    });

    expect(mockSelectedComputerIds.at(-1)).toBe("computer-b");
    expect(mockMountCount).toBe(1);
    expect(mockUnmountCount).toBe(0);
  });
});

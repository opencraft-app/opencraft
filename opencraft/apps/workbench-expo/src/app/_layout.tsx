import { Slot } from "expo-router";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    return <SafeAreaProvider><StatusBar style="dark" /><Slot /></SafeAreaProvider>;
  }
  const { NativeAccountLayout } = require("../components/native-account-layout.ios") as typeof import("../components/native-account-layout.ios");
  return <NativeAccountLayout />;
}

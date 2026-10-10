import Constants from "expo-constants";
import { createMobileLightVelaAccount } from "./lightvela-account";
import { NATIVE_LOGIN_INTL_REDIRECT, NATIVE_LOGIN_REDIRECT } from "./native-login";

// The account outlives route changes, including the native login callback.
export const mobileAccount = createMobileLightVelaAccount(
  Constants.expoConfig?.extra?.lightvelaRegion === "cn" ? "cn" : "intl",
  Constants.expoConfig?.extra?.lightvelaLoginRedirect === NATIVE_LOGIN_INTL_REDIRECT
    ? NATIVE_LOGIN_INTL_REDIRECT : NATIVE_LOGIN_REDIRECT,
);

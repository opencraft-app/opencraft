export {};

declare global {
  interface Window {
    show_phone_login?: () => boolean;
    __LIGHTVELA_SHOW_PHONE_LOGIN__?: boolean;
  }
}

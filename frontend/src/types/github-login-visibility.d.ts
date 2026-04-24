export {};

declare global {
  interface Window {
    show_github_login?: () => boolean;
    __LIGHTVELA_SHOW_GITHUB_LOGIN__?: boolean;
  }
}

import { redirect } from 'next/navigation';

/**
 * Legacy 备用后台入口。运营后台已迁移到 `/support/lv-console-0925/`，
 * 此处仅做 307 兼容跳转以防历史书签失效。
 * 生产静态导出时 CDN 层需另行配置 301；此文件保证 dev 环境行为一致。
 */
export default function LegacyFeedbackConsole(): never {
  redirect('/support/lv-console-0925/');
}

/**
 * 企业微信（WeCom）官方 logo 图标
 *
 * 迁移前 SDK 使用 @tencent/tea-icons-react 的 LogoWecomIcon，mono2 未引入该图标包，
 * 故按企业微信官方品牌视觉重绘 SVG（品牌蓝圆底 #2F7DFF + 白色双人对话图形），
 * 与 FeishuIcon / YuanbaoIcon 保持同一组织方式，单独成文件保持主面板可读性。
 *
 * 品牌主色：#2F7DFF（企业微信官方蓝）。
 */

import React from 'react';

export function WecomIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="24" fill="#2F7DFF" />
      {/* 左侧较大人形 */}
      <path
        d="M18.5 13.5c-5.4 0-9.8 3.6-9.8 8.1 0 2.5 1.4 4.7 3.5 6.2-.2.7-.7 2.2-.8 2.5-.1.3.1.6.4.5.2 0 2.3-1.2 3.1-1.6 1.1.3 2.3.5 3.6.5.3 0 .6 0 .9-.1-.3-.9-.5-1.9-.5-2.9 0-4.6 4.4-8.3 9.9-8.5-.9-4.1-5.2-7.2-10.3-7.2z"
        fill="#fff"
      />
      {/* 右侧较小人形（对话气泡） */}
      <path
        d="M39.3 27.6c0-3.7-3.6-6.7-8.1-6.7s-8.1 3-8.1 6.7 3.6 6.7 8.1 6.7c.9 0 1.8-.1 2.6-.4.6.3 2.1 1.1 2.3 1.2.2.1.4-.1.3-.4-.1-.2-.5-1.4-.6-1.9 1.5-1.2 2.5-2.9 2.5-4.9-.1-.1 1-.1 1-.1z"
        fill="#fff"
      />
      {/* 左人形眼点 */}
      <circle cx="14.8" cy="20.6" r="1.3" fill="#2F7DFF" />
      <circle cx="22.2" cy="20.6" r="1.3" fill="#2F7DFF" />
      {/* 右人形眼点 */}
      <circle cx="28.6" cy="26.4" r="1" fill="#2F7DFF" />
      <circle cx="33.6" cy="26.4" r="1" fill="#2F7DFF" />
    </svg>
  );
}

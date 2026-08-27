/**
 * 社群入口常量（Discord / 微信群二维码与邀请链接）
 *
 * 集中定义原因：Discord 邀请链接与二维码图片同时出现在
 * legal-footer / about-page / lightvela-footer
 * 等多个位置，散落硬编码时换群链接容易漏改，导致「二维码」与「点击跳转」
 * 指向不同的服务器。
 */

/** Discord 邀请链接（页脚社区入口、二维码点击跳转共用）。 */
export const DISCORD_INVITE_URL = "https://discord.gg/Myh58xEMe2";

/** Discord 入群二维码（扫码结果与 DISCORD_INVITE_URL 一致）。 */
export const DISCORD_QR_IMAGE = "/assets/landing/about/disc_LV.png";

/** 国内站微信交流群二维码。 */
export const CN_COMMUNITY_QR_IMAGE = "/assets/landing/about/community-qr.png";

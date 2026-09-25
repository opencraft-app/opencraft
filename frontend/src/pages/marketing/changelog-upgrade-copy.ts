import type { LocaleCode } from "@/i18n/locales.config";

const upgradeCopies = {
  "zh-CN": {
    month: "2026 年 9 月",
    title: "LightVela 支持订阅升配",
    desc: "现有订阅可升配至更高规格，实际应付价格以最终支付页显示为准。",
  },
  "zh-SG": {
    month: "2026 年 9 月",
    title: "LightVela 支持订阅升配",
    desc: "现有订阅可升配至更高规格，实际应付价格以最终支付页显示为准。",
  },
  "zh-Hant": {
    month: "2026 年 9 月",
    title: "LightVela 支援訂閱升級",
    desc: "現有訂閱可升級至更高規格，實際應付價格以最終支付頁顯示為準。",
  },
  "en-US": {
    month: "September 2026",
    title: "LightVela Now Supports Subscription Upgrades",
    desc: "Upgrade an active subscription to a higher plan. The actual amount due is the final price shown at checkout.",
  },
  "id-ID": {
    month: "September 2026",
    title: "LightVela Kini Mendukung Peningkatan Paket Langganan",
    desc: "Tingkatkan langganan aktif ke paket yang lebih tinggi. Jumlah yang harus dibayar mengikuti harga akhir di halaman pembayaran.",
  },
  es: {
    month: "Septiembre de 2026",
    title: "LightVela ya permite mejorar tu suscripción",
    desc: "Puedes mejorar una suscripción activa a un plan superior. El importe a pagar será el precio final mostrado en la página de pago.",
  },
  "ja-JP": {
    month: "2026年9月",
    title: "LightVela でサブスクリプションのアップグレードに対応",
    desc: "現在のサブスクリプションを上位プランにアップグレードできます。お支払い金額は最終決済ページに表示される価格をご確認ください。",
  },
  "ko-KR": {
    month: "2026년 9월",
    title: "LightVela에서 구독 업그레이드 지원",
    desc: "현재 구독을 상위 요금제로 업그레이드할 수 있습니다. 실제 결제 금액은 최종 결제 페이지에 표시된 가격을 기준으로 합니다.",
  },
} satisfies Record<LocaleCode, { month: string; title: string; desc: string }>;

export function getChangelogUpgradeCopy(locale: string, global: boolean) {
  return Object.prototype.hasOwnProperty.call(upgradeCopies, locale)
    ? upgradeCopies[locale as LocaleCode]
    : upgradeCopies[global ? "en-US" : "zh-CN"];
}

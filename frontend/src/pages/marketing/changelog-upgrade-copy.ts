import type { LocaleCode } from "@/i18n/locales.config";

const upgradeCopies = {
  "zh-CN": {
    month: "2026 年 9 月",
    title: "LightVela 支持套餐升配",
    desc: "现有套餐可升配至更高规格，实际应付价格以最终支付页显示为准。",
  },
  "zh-SG": {
    month: "2026 年 9 月",
    title: "LightVela 支持套餐升配",
    desc: "现有套餐可升配至更高规格，实际应付价格以最终支付页显示为准。",
  },
  "zh-Hant": {
    month: "2026 年 9 月",
    title: "LightVela 支援套餐升級",
    desc: "現有套餐可升級至更高規格，實際應付價格以最終支付頁顯示為準。",
  },
  "en-US": {
    month: "September 2026",
    title: "LightVela Now Supports Plan Upgrades",
    desc: "Upgrade your current plan to a higher tier. The actual amount due is the final price shown at checkout.",
  },
  "id-ID": {
    month: "September 2026",
    title: "LightVela Kini Mendukung Peningkatan Paket",
    desc: "Tingkatkan paket saat ini ke paket yang lebih tinggi. Jumlah yang harus dibayar mengikuti harga akhir di halaman pembayaran.",
  },
  es: {
    month: "Septiembre de 2026",
    title: "LightVela ya permite mejorar tu plan",
    desc: "Puedes mejorar tu plan actual a uno superior. El importe a pagar será el precio final mostrado en la página de pago.",
  },
  "ja-JP": {
    month: "2026年9月",
    title: "LightVela でプランのアップグレードに対応",
    desc: "現在のプランを上位プランにアップグレードできます。お支払い金額は最終決済ページに表示される価格をご確認ください。",
  },
  "ko-KR": {
    month: "2026년 9월",
    title: "LightVela에서 요금제 업그레이드 지원",
    desc: "현재 요금제를 상위 요금제로 업그레이드할 수 있습니다. 실제 결제 금액은 최종 결제 페이지에 표시된 가격을 기준으로 합니다.",
  },
} satisfies Record<LocaleCode, { month: string; title: string; desc: string }>;

export function getChangelogUpgradeCopy(locale: string, global: boolean) {
  return Object.prototype.hasOwnProperty.call(upgradeCopies, locale)
    ? upgradeCopies[locale as LocaleCode]
    : upgradeCopies[global ? "en-US" : "zh-CN"];
}

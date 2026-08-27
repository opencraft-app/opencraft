"use client";

import { useMemo, type ReactNode } from "react";
import { LegalFooter } from "@/components/site/legal-footer";
import { termsOfServiceText } from "@/content/legal/terms-of-service-text";
import { useLocaleOverride } from "@/i18n/t";
import { AppLink } from "@/lib/app-navigation";
import { localizedPath } from "@/lib/region";
import { PUBLIC_SITE_LOCALES, PUBLIC_URL_LANGS, type PublicSiteLocaleCode } from "@/lib/public-site-routing";
import { isZhLocale, useZhHantDeep } from "@/lib/zh-hant";

type TermsCopy = {
  backHome: string;
  brand: string;
  title: string;
  description: string;
  note: string;
};

const copy = {
  en: {
    backHome: "Back to Home",
    brand: "LightVela",
    title: "Terms of Service",
    description: "These Terms govern your access to and use of the LightVela service.",
    note: "The legal terms below are provided from the official LightVela Terms of Service document.",
  },
  zh: {
    backHome: "返回首页",
    brand: "LightVela",
    title: "服务条款",
    description: "本条款适用于您访问和使用 LightVela 服务。",
    note: "以下法律条款来自 LightVela 服务条款正式文件。",
  },
  id: {
    backHome: "Kembali ke Beranda",
    brand: "LightVela",
    title: "Ketentuan Layanan",
    description: "Ketentuan ini mengatur akses dan penggunaan Anda atas layanan LightVela.",
    note: "Ketentuan hukum di bawah ini berasal dari dokumen resmi LightVela Terms of Service.",
  },
  es: {
    backHome: "Volver al inicio",
    brand: "LightVela",
    title: "Términos del servicio",
    description: "Estos Términos rigen su acceso y uso del servicio LightVela.",
    note: "La traducción al español que aparece a continuación procede del documento oficial de Términos del servicio de LightVela.",
  },
} satisfies Record<"en" | "zh" | "id" | "es", TermsCopy>;

export function getTermsOfServiceChrome(locale: PublicSiteLocaleCode): TermsCopy {
  if (locale === PUBLIC_SITE_LOCALES.ES) return copy.es;
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return copy.id;
  return isZhLocale(locale) ? copy.zh : copy.en;
}

const primaryHeadings = new Set([
  "Introduction",
  "Eligibility",
  "Additional applicable terms",
  "Changes or Modifications to these Terms",
  "Definitions and Interpretation",
  "Your Account",
  "The Service",
  "BYOK and Third Party Services",
  "Subscription, Fees and Payment",
  "User Obligations",
  "Ownership; Proprietary Rights",
  "Confidentiality",
  "Privacy",
  "Term and Termination",
  "Disclaimers; No Warranties",
  "Indemnity",
  "Limitation of Liability",
  "Governing Law and Dispute Resolution",
  "General Terms",
  "Contact Information",
  "Jurisdiction-specific Addendum",
]);

const secondaryHeadings = new Set([
  "Account Registration",
  "Provision of Information",
  "Retrieve your Account",
  "Accounts Created via Third Party Platforms",
  "Security of Service",
  "Nature, risks and limitations of the Service",
  "Limits on AI Output Volume",
  "Service Modification",
  "Service Interruption",
  "Service Maintenance",
  "Restrictions",
  "Open Source Software",
  "Data Security",
  "Payment Terms",
  "Taxes",
  "User Data",
  "Content",
  "Input and Output",
  "Feedback",
  "Publicity",
  "Suspension",
  "Termination",
  "Effect of Termination",
]);

type TermsBlock =
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "warning"; text: string }
  | { kind: "paragraph"; text: string };

const zhTermsBlocks: TermsBlock[] = [
  { kind: "h2", text: "引言" },
  { kind: "paragraph", text: "欢迎并感谢您关注 LightVela 服务（“服务”）。" },
  { kind: "paragraph", text: "本 LightVela 服务条款（“本条款”）是您（“用户”或“您”）与 Tencent Cloud International Pte. Ltd.（一家注册于新加坡的实体，注册地址为 10 Anson Road, #21-07, International Plaza, Singapore 079903，“腾讯”“我们”）之间，就您使用本服务订立的具有法律约束力的合同。" },
  { kind: "warning", text: "使用本服务即表示您确认已阅读、理解并同意受本条款约束。若您不符合资格或不同意本条款，您无权使用本服务。" },
  { kind: "h2", text: "资格" },
  { kind: "paragraph", text: "您必须达到所在司法辖区的法定成年年龄，并具有订立本条款和使用本服务所需的法律行为能力；如果您未达到该年龄或因任何原因不具备相应能力，您的父母或法定监护人必须已代表您阅读并同意本条款。" },
  { kind: "paragraph", text: "您声明并保证：您此前未被暂停或移除本服务；您的注册和使用本服务符合所有适用法律；如您代表组织、公司或其他实体接受本条款，您必须具备约束该实体的合法权限。" },
  { kind: "h2", text: "附加适用条款" },
  { kind: "paragraph", text: "根据您注册信息中指定的国家/地区，可能适用附加或不同条款。若您从本条款末尾“特定司法辖区附录”涵盖的司法辖区访问或使用本服务，该附录对应条款将适用于您，并在与本条款其他部分冲突或不一致时优先适用。" },
  { kind: "h2", text: "条款变更" },
  { kind: "paragraph", text: "我们可能会不时变更或更新本条款，以反映适用法律或最佳实践的变化、改进本服务，或处理新增功能。发生重大变更时，我们会尽合理努力提前通知您，例如通过电子邮件或网站显著通知。" },
  { kind: "warning", text: "在适用法律允许的范围内，如您未在变更生效前反对或终止使用本服务，将被视为接受该等变更；如您反对变更，必须停止使用本服务并在生效日前通知我们。" },
  { kind: "h2", text: "定义与解释" },
  { kind: "paragraph", text: "本条款中的“账户”“关联方”“AI Agent”“AI 功能”“适用法律”“内容”“输入”“输出”“软件”“用户数据”等术语具有英文原文中对应定义。文档、隐私政策和开源声明分别可通过以下站内页面查看：[https://lightvela.ai/docs/overview/]、[https://lightvela.ai/zh-sg/privacy-policy/]、[https://lightvela.ai/zh-sg/open-source-licenses/]。" },
  { kind: "paragraph", text: "条款标题仅为便于引用，不影响条款解释；“包括”“例如”等表述均不具有限制含义。" },
  { kind: "h2", text: "您的账户" },
  { kind: "h3", text: "账户注册与信息提供" },
  { kind: "paragraph", text: "注册账户后，您负责妥善保管所有账户详情和访问凭证，并对您账户下发生的所有活动、行为或遗漏负责。除非系我们违反本条款导致，腾讯及其关联方不对未经授权访问您的账户负责。" },
  { kind: "paragraph", text: "您在使用本服务时向我们提供的用户数据（例如账户信息）应真实、准确且完整；如信息发生变化，您应及时通知腾讯。" },
  { kind: "h3", text: "账户找回与第三方平台账户" },
  { kind: "paragraph", text: "如您因账户信息丢失或忘记密码而请求找回账户，您需要按照我们公布的流程提供必要信息和验证材料，并确保该等信息和材料合法、真实、有效。通过 Google、Apple 等第三方平台创建的间接账户，其第三方平台账户及相关信息由相应第三方平台负责。" },
  { kind: "h3", text: "服务安全" },
  { kind: "paragraph", text: "如您发现账户被非法使用或存在安全问题，应立即通知我们。您不得绕过我们为防止未经授权使用、违反本条款或恶意程序而设置的技术措施，也不得通过本服务传输病毒、有害代码、破坏性数据或其他恶意程序。" },
  { kind: "h2", text: "服务" },
  { kind: "h3", text: "AI 服务的性质、风险与限制" },
  { kind: "paragraph", text: "腾讯可能通过本服务托管 AI Agent、提供计算基础设施，并提供由大语言模型支持的 AI 功能。您启用、访问或使用 AI Agent 或 AI 功能，即明确理解并接受 AI 技术固有且不可避免的风险。" },
  { kind: "warning", text: "输出可能包含事实错误、编造内容、遗漏或偏见；AI Agent 可能错误执行工具调用、API 请求或自主操作；第三方 LLM、插件或 API 可能适用其自身条款；AI 不具备人类判断、同理心、常识或伦理推理能力。您应自行承担使用后果并采取人工监督、验证流程和测试协议等保障措施。" },
  { kind: "paragraph", text: "本服务输出仅供参考，不构成法律、金融、医疗或其他专业建议。本服务不应用于在无人类适当监督的情况下作出对个人具有法律或类似重大影响的决定，也不设计用于关键基础设施、生命支持、医疗诊断或执法决策等高风险场景。" },
  { kind: "h3", text: "输出限制、服务变更与中断" },
  { kind: "paragraph", text: "腾讯可对您使用 AI 功能生成输出的数量、频率或性质设置合理限制，包括用量上限、速率限制或基于订阅计划的限制。在适用法律允许的最大范围内，腾讯可变更、限制、暂停或停止本服务或其任何部分，并可因维护、不可抗力、监管命令或适用法律要求中断服务。" },
  { kind: "h3", text: "第三方材料" },
  { kind: "paragraph", text: "本服务可能集成或允许您访问第三方 AI 模型、工具、API、插件、内容、产品或服务。除本条款明确说明外，腾讯不开发、运营或控制第三方材料，也不对其行为、性能、安全性、可用性、输出或内容负责。您应自行选择、启用、配置并遵守相关第三方条款、许可和隐私政策。" },
  { kind: "h3", text: "开源材料" },
  { kind: "paragraph", text: "您必须确保您使用第三方材料或软件时，不会导致任何软件必须以源代码形式披露、分发、免费再分发，或因 Copyleft 许可而受到不适当约束。本服务涉及的开源协议、版权声明及相关信息可在开源声明页面查看：[https://lightvela.ai/zh-sg/open-source-licenses/]。" },
  { kind: "h2", text: "您对服务的使用" },
  { kind: "paragraph", text: "在遵守本条款的前提下，腾讯授予您有限的、非独占、不可转让、不可再许可且可撤销的许可，用于下载软件副本并为个人目的使用本服务，且不得超过适用的使用限制、期限或地域范围。" },
  { kind: "paragraph", text: "您不得复制、修改、改编、分发、公开展示、转售、再许可、反向工程、反编译、翻译、反汇编或试图提取本服务源代码；不得上传或传播侵权、违法、欺诈、恶意、危害系统安全、侵犯他人合法权益或违反本条款的内容；不得绕过限制或保护措施。" },
  { kind: "h2", text: "BYOK 与第三方服务" },
  { kind: "paragraph", text: "如本服务允许您自带密钥（BYOK）或接入第三方服务，您应自行确保拥有必要权利、权限和同意，并遵守相应第三方服务条款。第三方服务的可用性、处理方式、费用、数据保留和安全措施可能由第三方决定，腾讯不对此承担责任。" },
  { kind: "h2", text: "订阅、费用与付款" },
  { kind: "paragraph", text: "部分服务或功能可能需要订阅、预付费、按量计费或其他费用安排。您应按照服务页面、订单、账单或付款流程所列价格、税费、付款方式和期限支付相关费用。除适用法律另有要求或本条款另有说明外，已支付费用可能不予退还。" },
  { kind: "paragraph", text: "您应确保付款方式有效并授权我们或第三方支付处理方扣款。您负责承担与购买或使用服务相关的税费、关税、手续费及其他政府收费（不包括腾讯所得税）。" },
  { kind: "h2", text: "用户义务" },
  { kind: "paragraph", text: "您应遵守所有适用法律、监管要求、本条款、文档和服务限制，并对您的输入、输出、用户数据、配置、第三方集成和下游使用负责。您不得使用本服务进行违法、高风险、欺诈、侵权、骚扰、仇恨、恶意软件、规避安全措施、未经授权访问、滥用系统资源或其他损害腾讯、用户、第三方或公众利益的行为。" },
  { kind: "h2", text: "所有权与知识产权" },
  { kind: "paragraph", text: "除本条款明确授予您的有限使用权外，腾讯及其许可方保留本服务、软件、文档、商标、标识、技术、系统和相关知识产权的全部权利、所有权和利益。您保留对您合法拥有的用户数据、输入及内容的权利；输出的使用仍需受适用法律、第三方权利及本条款限制。" },
  { kind: "h2", text: "保密" },
  { kind: "paragraph", text: "您可能在使用本服务过程中接触腾讯的非公开信息、技术、产品计划、接口、凭证或其他保密信息。除为使用本服务且符合本条款外，未经腾讯书面同意，您不得披露、复制、转让或滥用该等保密信息。" },
  { kind: "h2", text: "隐私" },
  { kind: "paragraph", text: "我们将按照适用于本服务的隐私政策处理个人信息。隐私政策说明我们如何收集、使用、存储、共享和保护个人信息，以及您可行使的相关权利。请参阅：[https://lightvela.ai/zh-sg/privacy-policy/]。" },
  { kind: "h2", text: "期限与终止" },
  { kind: "paragraph", text: "本条款自您接受或首次访问、下载、安装或使用本服务时生效，并持续至根据本条款终止。我们可在您违反本条款、存在安全或法律风险、监管要求、服务停止或其他本条款允许情形下暂停或终止您的访问。终止后，您应停止使用本服务，并根据要求删除或返还相关软件和保密信息。" },
  { kind: "h2", text: "免责声明与无保证" },
  { kind: "paragraph", text: "在适用法律允许的最大范围内，本服务按“现状”和“可用”提供。腾讯不就本服务不中断、无错误、安全、准确、完整、适合特定目的或满足您的需求作出任何明示、默示或法定保证。" },
  { kind: "h2", text: "赔偿" },
  { kind: "paragraph", text: "因您违反本条款、违法使用本服务、您的用户数据或内容、第三方集成、侵犯第三方权利或您的下游使用而引起的任何索赔、损失、责任、费用和支出，您应按照本条款对腾讯及其关联方进行赔偿和保护。" },
  { kind: "h2", text: "责任限制" },
  { kind: "paragraph", text: "在适用法律允许的最大范围内，腾讯不对间接、附带、特殊、惩罚性、后果性损害、利润损失、收入损失、商誉损失、数据丢失、业务中断或替代服务成本承担责任。腾讯的总责任以本条款及适用法律允许的责任上限为准。" },
  { kind: "h2", text: "适用法律与争议解决" },
  { kind: "paragraph", text: "除特定司法辖区附录或适用强制性法律另有规定外，本条款的适用法律、仲裁或争议解决安排以英文原文规定为准。任何不能通过协商解决的争议，应按照本条款约定的方式处理。" },
  { kind: "h2", text: "一般条款" },
  { kind: "paragraph", text: "本条款包含转让、通知、不可抗力、可分割性、无第三方受益人、完整协议、语言等一般条款。我们可将本条款翻译为其他语言；如英文版本与其他语言版本存在不一致，应以英文版本为准，除非适用法律另有强制规定。" },
  { kind: "h2", text: "客户支持与联系我们" },
  { kind: "paragraph", text: "如您对本条款或本服务有任何问题、咨询、投诉或反馈，可通过 [lightvela@tencent.com] 联系我们。我们会在收到反馈后尽快回复，并在适用法律要求的期限内响应您的请求。" },
  { kind: "h2", text: "特定司法辖区附录" },
  { kind: "h3", text: "肯尼亚" },
  { kind: "paragraph", text: "若您选择肯尼亚作为注册国家/地区，肯尼亚附录将补充适用。该附录说明消费者保护法、最低年龄、AI 披露、责任限制、争议解决和内容合规等要求；如与本条款冲突，以附录为准。" },
  { kind: "h3", text: "越南" },
  { kind: "paragraph", text: "若您从越南访问或使用本服务，越南附录将补充适用。该附录说明适用范围、最低年龄、AI 透明度与内容标识、事件处理、数据治理与本地化、网络安全、个人数据保护、使用限制、部署者义务、消费者保护、制裁与处罚、适用法律和监管更新等要求；如与本条款冲突，以越南强制性法律及附录为准。" },
];

const idTermsBlocks: TermsBlock[] = [
  { kind: "h2", text: "Pengantar" },
  { kind: "paragraph", text: "Selamat datang dan terima kasih atas minat Anda pada layanan LightVela (“Layanan”)." },
  { kind: "paragraph", text: "Ketentuan Layanan LightVela ini (“Ketentuan”) merupakan kontrak yang mengikat secara hukum antara Anda (“Pengguna” atau “Anda”) dan Tencent Cloud International Pte. Ltd., entitas yang terdaftar di Singapura dengan alamat terdaftar di 10 Anson Road, #21-07, International Plaza, Singapore 079903 (“Tencent” atau “kami”), terkait penggunaan Layanan oleh Anda." },
  { kind: "warning", text: "Dengan menggunakan Layanan, Anda menyatakan bahwa Anda telah membaca, memahami, dan setuju untuk terikat oleh Ketentuan ini. Jika Anda tidak memenuhi syarat atau tidak menyetujui Ketentuan ini, Anda tidak berhak menggunakan Layanan." },
  { kind: "h2", text: "Kelayakan" },
  { kind: "paragraph", text: "Anda harus telah mencapai usia dewasa menurut hukum di yurisdiksi Anda dan memiliki kapasitas hukum yang diperlukan untuk menyetujui Ketentuan ini dan menggunakan Layanan. Jika Anda belum mencapai usia tersebut atau tidak memiliki kapasitas hukum karena alasan apa pun, orang tua atau wali hukum Anda harus membaca dan menyetujui Ketentuan ini atas nama Anda." },
  { kind: "paragraph", text: "Anda menyatakan dan menjamin bahwa Anda belum pernah ditangguhkan atau dikeluarkan dari Layanan, dan bahwa pendaftaran serta penggunaan Layanan oleh Anda mematuhi semua Hukum yang Berlaku. Anda tidak boleh menyetujui Ketentuan ini atas nama organisasi, perusahaan, atau entitas lain kecuali Anda memiliki kewenangan hukum untuk mengikat entitas tersebut." },
  { kind: "h2", text: "Ketentuan tambahan yang berlaku" },
  { kind: "paragraph", text: "Bergantung pada negara yang Anda cantumkan dalam informasi pendaftaran, ketentuan tambahan atau berbeda dapat berlaku. Jika Anda mengakses atau menggunakan Layanan dari yurisdiksi yang tercakup dalam Addendum Khusus Yurisdiksi di bagian akhir Ketentuan ini, ketentuan untuk yurisdiksi tersebut akan berlaku dan mengesampingkan bagian lain dari Ketentuan ini jika terdapat konflik atau ketidaksesuaian." },
  { kind: "h2", text: "Perubahan Ketentuan" },
  { kind: "paragraph", text: "Kami dapat mengubah atau memperbarui Ketentuan ini dari waktu ke waktu untuk mencerminkan perubahan Hukum yang Berlaku atau praktik terbaik, meningkatkan Layanan, atau menangani fitur baru. Untuk perubahan material, kami akan menggunakan upaya yang wajar untuk memberi tahu Anda sebelumnya, misalnya melalui email atau pemberitahuan yang jelas di situs web kami." },
  { kind: "warning", text: "Sepanjang diizinkan oleh hukum yang berlaku, jika Anda tidak menolak perubahan atau tidak menghentikan penggunaan Layanan sebelum perubahan berlaku, Anda dianggap menerima perubahan tersebut. Jika Anda menolak perubahan, Anda harus berhenti menggunakan Layanan dan memberi tahu kami sebelum tanggal efektif perubahan." },
  { kind: "h2", text: "Definisi dan Penafsiran" },
  { kind: "paragraph", text: "Istilah seperti “Akun”, “Afiliasi”, “AI Agent”, “Fungsi AI”, “Hukum yang Berlaku”, “Konten”, “Input”, “Output”, “Software”, dan “Data Pengguna” memiliki arti sebagaimana dijelaskan dalam versi bahasa Inggris resmi. Dokumentasi, Kebijakan Privasi, dan Pemberitahuan Sumber Terbuka tersedia di halaman berikut: [https://lightvela.ai/docs/overview/], [https://lightvela.ai/zh-sg/privacy-policy/], dan [https://lightvela.ai/zh-sg/open-source-licenses/]." },
  { kind: "paragraph", text: "Judul bagian hanya untuk kemudahan rujukan dan tidak membatasi penafsiran Ketentuan. Kata seperti “termasuk” atau contoh apa pun tidak dimaksudkan sebagai pembatasan." },
  { kind: "h2", text: "Akun Anda" },
  { kind: "h3", text: "Pendaftaran akun dan informasi yang diberikan" },
  { kind: "paragraph", text: "Setelah mendaftarkan akun, Anda bertanggung jawab menjaga semua detail akun dan kredensial akses, serta bertanggung jawab atas penggunaan akun atau Layanan dan semua aktivitas, tindakan, atau kelalaian yang terjadi di bawah akun Anda. Kecuali disebabkan oleh pelanggaran kami atas Ketentuan ini, Tencent dan afiliasinya tidak bertanggung jawab atas akses tidak sah ke akun Anda." },
  { kind: "paragraph", text: "Data Pengguna yang Anda berikan saat menggunakan Layanan, seperti informasi akun, harus benar, akurat, dan lengkap. Jika informasi tersebut berubah, Anda harus segera memberi tahu Tencent." },
  { kind: "h3", text: "Pemulihan akun dan akun melalui platform pihak ketiga" },
  { kind: "paragraph", text: "Jika Anda meminta pemulihan akun karena kehilangan informasi akun atau lupa kata sandi, Anda harus memberikan informasi dan dokumen verifikasi sesuai proses yang kami publikasikan, serta memastikan semuanya sah, benar, dan valid. Untuk akun tidak langsung yang dibuat melalui Google, Apple, atau platform pihak ketiga lainnya, platform pihak ketiga terkait bertanggung jawab atas akun dan informasi platform tersebut." },
  { kind: "h3", text: "Keamanan Layanan" },
  { kind: "paragraph", text: "Jika Anda mengetahui penggunaan ilegal akun atau masalah keamanan akun, segera beri tahu kami. Anda tidak boleh menghindari tindakan teknis kami, termasuk tindakan untuk mencegah penggunaan tidak sah, pelanggaran Ketentuan, atau program berbahaya. Anda juga tidak boleh mengirim virus, kode berbahaya, data destruktif, atau malware melalui Layanan." },
  { kind: "h2", text: "Layanan" },
  { kind: "h3", text: "Sifat, risiko, dan batasan layanan AI" },
  { kind: "paragraph", text: "Melalui Layanan, Tencent dapat menyediakan akses ke AI Agent, menghosting AI Agent, menyediakan infrastruktur komputasi, dan menyediakan Fungsi AI yang didukung model bahasa besar. Dengan mengaktifkan, mengakses, atau menggunakan AI Agent atau Fungsi AI, Anda memahami dan menerima risiko bawaan teknologi AI." },
  { kind: "warning", text: "Output dapat mengandung ketidakakuratan faktual, fabrikasi, penghilangan, atau bias. AI Agent dapat keliru menjalankan panggilan alat, permintaan API, atau tindakan otonom. LLM, plugin, atau API pihak ketiga tunduk pada ketentuan masing-masing. AI tidak memiliki penilaian manusia, empati, akal sehat, atau penalaran etis. Anda bertanggung jawab atas konsekuensi penggunaan dan harus menerapkan pengawasan manusia, alur validasi, serta protokol pengujian yang sesuai." },
  { kind: "paragraph", text: "Output hanya diberikan untuk tujuan informasi dan bukan nasihat hukum, keuangan, medis, atau profesional lainnya. Layanan tidak dimaksudkan untuk mengambil keputusan yang memiliki dampak hukum atau dampak signifikan serupa terhadap individu tanpa pengawasan manusia yang tepat, dan tidak dirancang untuk infrastruktur kritis, penunjang hidup, diagnosis medis, atau pengambilan keputusan penegakan hukum." },
  { kind: "h3", text: "Batas output, perubahan layanan, dan gangguan" },
  { kind: "paragraph", text: "Tencent dapat menetapkan batas wajar atas volume, frekuensi, atau sifat Output yang dapat Anda hasilkan, termasuk batas penggunaan, rate limit, atau batas berdasarkan paket langganan. Sepanjang diizinkan oleh hukum, Tencent dapat mengubah, membatasi, menangguhkan, atau menghentikan Layanan atau bagian mana pun, termasuk karena pemeliharaan, force majeure, perintah regulator, atau kewajiban hukum." },
  { kind: "h3", text: "Materi pihak ketiga" },
  { kind: "paragraph", text: "Layanan dapat mengintegrasikan atau memungkinkan Anda mengakses model AI, alat, API, plugin, konten, produk, atau layanan pihak ketiga. Kecuali dinyatakan secara tegas, Tencent tidak mengembangkan, mengoperasikan, atau mengendalikan Materi Pihak Ketiga dan tidak bertanggung jawab atas tindakan, kinerja, keamanan, ketersediaan, output, atau kontennya. Anda bertanggung jawab memilih, mengaktifkan, mengonfigurasi, dan mematuhi ketentuan, lisensi, serta kebijakan privasi pihak ketiga terkait." },
  { kind: "h3", text: "Materi open source" },
  { kind: "paragraph", text: "Anda harus memastikan penggunaan Materi Pihak Ketiga atau software tidak mengharuskan pengungkapan atau distribusi source code, lisensi untuk karya turunan, redistribusi gratis, atau kewajiban Copyleft yang tidak sesuai. Informasi lisensi, pemberitahuan hak cipta, dan detail open source yang relevan dapat dilihat di halaman Pemberitahuan Sumber Terbuka: [https://lightvela.ai/zh-sg/open-source-licenses/]." },
  { kind: "h2", text: "Penggunaan Layanan oleh Anda" },
  { kind: "paragraph", text: "Dengan tunduk pada kepatuhan Anda terhadap Ketentuan ini, Tencent memberikan kepada Anda lisensi terbatas, non-eksklusif, tidak dapat dialihkan, tidak dapat disublisensikan, dan dapat dicabut untuk mengunduh salinan Software dan menggunakan Layanan untuk tujuan pribadi, tanpa melebihi batas penggunaan, masa berlaku, atau wilayah yang berlaku." },
  { kind: "paragraph", text: "Anda tidak boleh menyalin, memodifikasi, mengadaptasi, mendistribusikan, menampilkan secara publik, menjual kembali, mensublisensikan, melakukan reverse engineering, dekompilasi, menerjemahkan, membongkar, atau mencoba mengekstrak source code Layanan. Anda juga tidak boleh mengunggah atau menyebarkan konten yang melanggar hukum, menipu, berbahaya, melanggar hak pihak lain, mengganggu sistem, menghindari perlindungan, atau melanggar Ketentuan ini." },
  { kind: "h2", text: "BYOK dan layanan pihak ketiga" },
  { kind: "paragraph", text: "Jika Layanan memungkinkan Anda membawa kunci sendiri (BYOK) atau menghubungkan layanan pihak ketiga, Anda bertanggung jawab memastikan Anda memiliki hak, izin, dan persetujuan yang diperlukan serta mematuhi ketentuan pihak ketiga terkait. Ketersediaan, pemrosesan, biaya, retensi data, dan keamanan layanan pihak ketiga dapat ditentukan oleh pihak ketiga tersebut, dan Tencent tidak bertanggung jawab atas hal tersebut." },
  { kind: "h2", text: "Langganan, biaya, dan pembayaran" },
  { kind: "paragraph", text: "Beberapa layanan atau fitur dapat memerlukan langganan, prabayar, biaya berdasarkan penggunaan, atau pengaturan biaya lainnya. Anda harus membayar biaya terkait sesuai harga, pajak, metode pembayaran, dan tenggat waktu yang ditampilkan di halaman layanan, pesanan, tagihan, atau proses pembayaran. Kecuali diwajibkan oleh hukum atau dinyatakan lain dalam Ketentuan, biaya yang telah dibayarkan mungkin tidak dapat dikembalikan." },
  { kind: "paragraph", text: "Anda harus memastikan metode pembayaran valid dan mengizinkan kami atau pemroses pembayaran pihak ketiga untuk menagih biaya. Anda bertanggung jawab atas pajak, bea, biaya, dan pungutan pemerintah lain yang terkait dengan pembelian atau penggunaan Layanan, selain pajak penghasilan Tencent." },
  { kind: "h2", text: "Kewajiban pengguna" },
  { kind: "paragraph", text: "Anda harus mematuhi semua Hukum yang Berlaku, persyaratan regulator, Ketentuan ini, Dokumentasi, dan batasan layanan, serta bertanggung jawab atas Input, Output, Data Pengguna, konfigurasi, integrasi pihak ketiga, dan penggunaan hilir Anda. Anda tidak boleh menggunakan Layanan untuk aktivitas ilegal, berisiko tinggi, menipu, melanggar hak, melecehkan, menyebarkan kebencian, malware, menghindari keamanan, mengakses tanpa izin, menyalahgunakan sistem, atau merugikan Tencent, pengguna, pihak ketiga, atau publik." },
  { kind: "h2", text: "Kepemilikan dan hak kekayaan intelektual" },
  { kind: "paragraph", text: "Kecuali lisensi terbatas yang secara tegas diberikan kepada Anda, Tencent dan pemberi lisensinya mempertahankan semua hak, kepemilikan, dan kepentingan atas Layanan, Software, Dokumentasi, merek, logo, teknologi, sistem, dan hak kekayaan intelektual terkait. Anda mempertahankan hak atas Data Pengguna, Input, dan konten yang secara sah Anda miliki; penggunaan Output tetap tunduk pada hukum yang berlaku, hak pihak ketiga, dan Ketentuan ini." },
  { kind: "h2", text: "Kerahasiaan" },
  { kind: "paragraph", text: "Dalam menggunakan Layanan, Anda dapat memperoleh akses ke informasi non-publik Tencent, teknologi, rencana produk, antarmuka, kredensial, atau informasi rahasia lainnya. Kecuali untuk menggunakan Layanan sesuai Ketentuan ini, Anda tidak boleh mengungkapkan, menyalin, mengalihkan, atau menyalahgunakan informasi rahasia tersebut tanpa persetujuan tertulis Tencent." },
  { kind: "h2", text: "Privasi" },
  { kind: "paragraph", text: "Kami memproses informasi pribadi sesuai Kebijakan Privasi yang berlaku untuk Layanan. Kebijakan Privasi menjelaskan cara kami mengumpulkan, menggunakan, menyimpan, membagikan, dan melindungi informasi pribadi, serta hak yang dapat Anda gunakan. Silakan lihat: [https://lightvela.ai/zh-sg/privacy-policy/]." },
  { kind: "h2", text: "Masa berlaku dan pengakhiran" },
  { kind: "paragraph", text: "Ketentuan ini berlaku sejak Anda menerima, atau pertama kali mengakses, mengunduh, menginstal, atau menggunakan Layanan, dan berlanjut sampai diakhiri sesuai Ketentuan ini. Kami dapat menangguhkan atau mengakhiri akses Anda jika Anda melanggar Ketentuan, menimbulkan risiko keamanan atau hukum, terdapat persyaratan regulator, penghentian layanan, atau keadaan lain yang diizinkan Ketentuan. Setelah pengakhiran, Anda harus berhenti menggunakan Layanan dan, jika diminta, menghapus atau mengembalikan Software dan informasi rahasia terkait." },
  { kind: "h2", text: "Penafian dan tanpa jaminan" },
  { kind: "paragraph", text: "Sepanjang diizinkan oleh hukum yang berlaku, Layanan disediakan “sebagaimana adanya” dan “sebagaimana tersedia”. Tencent tidak memberikan jaminan tersurat, tersirat, atau berdasarkan hukum bahwa Layanan akan tidak terputus, bebas kesalahan, aman, akurat, lengkap, cocok untuk tujuan tertentu, atau memenuhi kebutuhan Anda." },
  { kind: "h2", text: "Ganti rugi" },
  { kind: "paragraph", text: "Anda harus mengganti rugi dan melindungi Tencent serta afiliasinya dari klaim, kerugian, tanggung jawab, biaya, dan pengeluaran yang timbul dari pelanggaran Anda atas Ketentuan ini, penggunaan Layanan yang melanggar hukum, Data Pengguna atau konten Anda, integrasi pihak ketiga, pelanggaran hak pihak ketiga, atau penggunaan hilir Anda." },
  { kind: "h2", text: "Batasan tanggung jawab" },
  { kind: "paragraph", text: "Sepanjang diizinkan oleh hukum yang berlaku, Tencent tidak bertanggung jawab atas kerugian tidak langsung, insidental, khusus, punitif, konsekuensial, kehilangan laba, pendapatan, goodwill, data, gangguan bisnis, atau biaya layanan pengganti. Total tanggung jawab Tencent tunduk pada batas tanggung jawab yang diatur dalam Ketentuan ini dan hukum yang berlaku." },
  { kind: "h2", text: "Hukum yang berlaku dan penyelesaian sengketa" },
  { kind: "paragraph", text: "Kecuali dinyatakan lain dalam Addendum Khusus Yurisdiksi atau hukum wajib yang berlaku, hukum yang berlaku, arbitrase, atau mekanisme penyelesaian sengketa mengikuti versi resmi bahasa Inggris. Sengketa yang tidak dapat diselesaikan melalui diskusi akan diselesaikan sesuai mekanisme dalam Ketentuan." },
  { kind: "h2", text: "Ketentuan umum" },
  { kind: "paragraph", text: "Ketentuan ini mencakup ketentuan umum tentang pengalihan, pemberitahuan, force majeure, keterpisahan, tidak adanya penerima manfaat pihak ketiga, keseluruhan perjanjian, dan bahasa. Kami dapat menerjemahkan Ketentuan ini ke bahasa lain; jika terdapat ketidaksesuaian antara versi bahasa Inggris dan versi bahasa lain, versi bahasa Inggris berlaku, kecuali hukum wajib menentukan lain." },
  { kind: "h2", text: "Dukungan pelanggan dan hubungi kami" },
  { kind: "paragraph", text: "Jika Anda memiliki pertanyaan, konsultasi, keluhan, atau masukan terkait Ketentuan ini atau penggunaan Layanan, Anda dapat menghubungi kami di [lightvela@tencent.com]. Kami akan membalas sesegera mungkin setelah menerima masukan Anda dan, jika berlaku, dalam batas waktu yang ditentukan oleh Hukum yang Berlaku." },
  { kind: "h2", text: "Addendum khusus yurisdiksi" },
  { kind: "h3", text: "Kenya" },
  { kind: "paragraph", text: "Jika Anda memilih Kenya sebagai negara pendaftaran, addendum Kenya berlaku sebagai ketentuan tambahan. Addendum ini mencakup hukum perlindungan konsumen, usia minimum, pengungkapan AI, batasan tanggung jawab, penyelesaian sengketa, dan kepatuhan konten. Jika terdapat konflik dengan Ketentuan, addendum berlaku sejauh terdapat ketidaksesuaian." },
  { kind: "h3", text: "Vietnam" },
  { kind: "paragraph", text: "Jika Anda mengakses atau menggunakan Layanan dari Vietnam, addendum Vietnam berlaku sebagai ketentuan tambahan. Addendum ini mencakup ruang lingkup, usia minimum, transparansi dan pelabelan konten AI, penanganan insiden, tata kelola dan lokalisasi data, keamanan siber, perlindungan data pribadi, batasan penggunaan, kewajiban deployer, perlindungan konsumen, sanksi dan penalti, hukum yang berlaku, serta pembaruan regulator. Jika terdapat konflik, hukum wajib Vietnam dan addendum berlaku sejauh diperlukan." },
];

const esTermsBlocks: TermsBlock[] = [
  { kind: "h2", text: "Introducción" },
  { kind: "paragraph", text: "Le damos la bienvenida y le agradecemos su interés en el servicio LightVela (el “Servicio”)." },
  { kind: "paragraph", text: "Estos Términos del servicio de LightVela (los “Términos”) constituyen un contrato jurídicamente vinculante entre usted (el “Usuario” o “usted”) y Tencent Cloud International Pte. Ltd., entidad registrada en Singapur con domicilio social en 10 Anson Road, #21-07, International Plaza, Singapore 079903 (“Tencent” o “nosotros”), relativo al uso que usted haga del Servicio." },
  { kind: "warning", text: "AL UTILIZAR EL SERVICIO, CONFIRMA QUE HA LEÍDO Y COMPRENDIDO ESTOS TÉRMINOS Y QUE ACEPTA QUEDAR VINCULADO POR ELLOS. SI NO CUMPLE LOS REQUISITOS O NO ACEPTA ESTOS TÉRMINOS, NO ESTÁ AUTORIZADO A UTILIZAR EL SERVICIO." },
  { kind: "h2", text: "Requisitos" },
  { kind: "paragraph", text: "Debe haber alcanzado la mayoría de edad legal en su jurisdicción y disponer de la capacidad jurídica necesaria para aceptar estos Términos y utilizar el Servicio. Si no ha alcanzado dicha edad o carece de capacidad jurídica por cualquier motivo, su padre, madre o tutor legal deberá leer y aceptar estos Términos en su nombre." },
  { kind: "paragraph", text: "Usted declara y garantiza que no ha sido suspendido ni expulsado anteriormente del Servicio y que su registro y uso cumplen todas las leyes aplicables. No podrá aceptar estos Términos en nombre de una organización, empresa u otra entidad salvo que tenga autoridad legal para vincularla." },
  { kind: "h2", text: "Términos adicionales aplicables" },
  { kind: "paragraph", text: "En función del país que indique en la información de registro, podrán aplicarse términos adicionales o distintos. Si accede al Servicio o lo utiliza desde una jurisdicción incluida en el Anexo específico por jurisdicción situado al final de estos Términos, las disposiciones correspondientes a esa jurisdicción serán aplicables y prevalecerán sobre las demás partes de estos Términos en caso de conflicto o incoherencia." },
  { kind: "h2", text: "Cambios en estos Términos" },
  { kind: "paragraph", text: "Podremos modificar o actualizar estos Términos periódicamente para reflejar cambios en la legislación aplicable o en las mejores prácticas, mejorar el Servicio o abordar nuevas funciones. Cuando los cambios sean sustanciales, haremos esfuerzos razonables para avisarle con antelación, por ejemplo, por correo electrónico o mediante un aviso destacado en nuestro sitio web." },
  { kind: "warning", text: "EN LA MEDIDA PERMITIDA POR LA LEY, SI NO SE OPONE A LOS CAMBIOS NI DEJA DE UTILIZAR EL SERVICIO ANTES DE QUE ENTREN EN VIGOR, SE CONSIDERARÁ QUE LOS HA ACEPTADO. SI SE OPONE, DEBERÁ DEJAR DE UTILIZAR EL SERVICIO Y NOTIFICÁRNOSLO ANTES DE LA FECHA DE ENTRADA EN VIGOR." },
  { kind: "h2", text: "Definiciones e interpretación" },
  { kind: "paragraph", text: "Los términos “Cuenta”, “Afiliada”, “Agente de IA”, “Funciones de IA”, “Legislación aplicable”, “Contenido”, “Entrada”, “Salida”, “Software” y “Datos del usuario” tienen el significado establecido en la versión oficial en inglés. La Documentación, la Política de privacidad y el Aviso de código abierto están disponibles en: [https://lightvela.ai/docs/overview/], [https://lightvela.ai/zh-sg/privacy-policy/] y [https://lightvela.ai/zh-sg/open-source-licenses/]." },
  { kind: "paragraph", text: "Los títulos de las secciones se incluyen únicamente para facilitar la consulta y no limitan la interpretación de estos Términos. Expresiones como “incluido” y los ejemplos no tienen carácter restrictivo." },
  { kind: "h2", text: "Su cuenta" },
  { kind: "h3", text: "Registro de la cuenta e información facilitada" },
  { kind: "paragraph", text: "Después de registrar una cuenta, usted será responsable de proteger todos los datos de la cuenta y las credenciales de acceso, así como del uso de la cuenta o del Servicio y de todas las actividades, acciones u omisiones que se produzcan en ella. Salvo que el acceso no autorizado se deba a un incumplimiento de estos Términos por nuestra parte, Tencent y sus afiliadas no serán responsables de dicho acceso." },
  { kind: "paragraph", text: "Los Datos del usuario que facilite al utilizar el Servicio, como la información de la cuenta, deben ser verdaderos, exactos y completos. Si cambian, deberá informar de ello a Tencent sin demora." },
  { kind: "h3", text: "Recuperación de la cuenta y cuentas de plataformas de terceros" },
  { kind: "paragraph", text: "Si solicita recuperar la cuenta porque ha perdido sus datos o ha olvidado la contraseña, deberá proporcionar la información y los documentos de verificación exigidos por el proceso que publiquemos y asegurarse de que sean legales, verdaderos y válidos. En el caso de cuentas indirectas creadas mediante Google, Apple u otras plataformas de terceros, la plataforma correspondiente será responsable de la cuenta y de la información de dicha plataforma." },
  { kind: "h3", text: "Seguridad del Servicio" },
  { kind: "paragraph", text: "Si detecta un uso ilícito de la cuenta o un problema de seguridad, notifíquenoslo inmediatamente. No deberá eludir nuestras medidas técnicas, incluidas las destinadas a impedir usos no autorizados, incumplimientos de estos Términos o programas maliciosos. Tampoco deberá transmitir virus, código malicioso, datos destructivos ni malware mediante el Servicio." },
  { kind: "h2", text: "El Servicio" },
  { kind: "h3", text: "Naturaleza, riesgos y limitaciones de los servicios de IA" },
  { kind: "paragraph", text: "Mediante el Servicio, Tencent puede proporcionar acceso a Agentes de IA, alojarlos, ofrecer infraestructura informática y suministrar Funciones de IA basadas en modelos de lenguaje de gran tamaño. Al activar, acceder o utilizar un Agente de IA o una Función de IA, usted comprende y acepta los riesgos inherentes a la tecnología de IA." },
  { kind: "warning", text: "LAS SALIDAS PUEDEN CONTENER ERRORES FÁCTICOS, INFORMACIÓN INVENTADA, OMISIONES O SESGOS. LOS AGENTES DE IA PUEDEN EJECUTAR INCORRECTAMENTE LLAMADAS A HERRAMIENTAS, SOLICITUDES API O ACCIONES AUTÓNOMAS. LOS LLM, COMPLEMENTOS Y API DE TERCEROS SE RIGEN POR SUS PROPIOS TÉRMINOS. LA IA CARECE DE JUICIO HUMANO, EMPATÍA, SENTIDO COMÚN Y RAZONAMIENTO ÉTICO. USTED ES RESPONSABLE DE LAS CONSECUENCIAS DEL USO Y DEBE APLICAR SUPERVISIÓN HUMANA, FLUJOS DE VALIDACIÓN Y PROTOCOLOS DE PRUEBAS ADECUADOS." },
  { kind: "paragraph", text: "Las Salidas se ofrecen únicamente con fines informativos y no constituyen asesoramiento jurídico, financiero, médico ni profesional. El Servicio no está destinado a adoptar decisiones que produzcan efectos jurídicos o efectos significativos similares sobre personas sin una supervisión humana adecuada, ni está diseñado para infraestructuras críticas, sistemas de soporte vital, diagnósticos médicos o decisiones de las fuerzas del orden." },
  { kind: "h3", text: "Límites de las Salidas, cambios en el Servicio e interrupciones" },
  { kind: "paragraph", text: "Tencent podrá establecer límites razonables sobre el volumen, la frecuencia o la naturaleza de las Salidas que usted genere, incluidos límites de uso, de velocidad o vinculados al plan de suscripción. En la medida permitida por la ley, Tencent podrá modificar, limitar, suspender o interrumpir el Servicio o cualquiera de sus partes, entre otros motivos, por mantenimiento, fuerza mayor, órdenes regulatorias u obligaciones legales." },
  { kind: "h3", text: "Materiales de terceros" },
  { kind: "paragraph", text: "El Servicio puede integrar o permitirle acceder a modelos de IA, herramientas, API, complementos, contenido, productos o servicios de terceros. Salvo que se indique expresamente lo contrario, Tencent no desarrolla, opera ni controla los Materiales de terceros y no es responsable de sus actos, rendimiento, seguridad, disponibilidad, Salidas o contenido. Usted es responsable de seleccionar, activar y configurar dichos materiales y de cumplir los términos, licencias y políticas de privacidad aplicables." },
  { kind: "h3", text: "Materiales de código abierto" },
  { kind: "paragraph", text: "Debe asegurarse de que el uso de Materiales de terceros o Software no exija divulgar o distribuir código fuente, licenciar obras derivadas, redistribuir gratuitamente ni asumir obligaciones Copyleft incompatibles. La información sobre licencias, los avisos de derechos de autor y los datos pertinentes de código abierto están disponibles en el Aviso de código abierto: [https://lightvela.ai/zh-sg/open-source-licenses/]." },
  { kind: "h2", text: "Uso del Servicio por su parte" },
  { kind: "paragraph", text: "Siempre que cumpla estos Términos, Tencent le concede una licencia limitada, no exclusiva, intransferible, no sublicenciable y revocable para descargar una copia del Software y utilizar el Servicio con fines personales, sin superar los límites de uso, el periodo de vigencia o el territorio aplicables." },
  { kind: "paragraph", text: "No podrá copiar, modificar, adaptar, distribuir, mostrar públicamente, revender, sublicenciar, realizar ingeniería inversa, descompilar, traducir, desensamblar ni intentar extraer el código fuente del Servicio. Tampoco podrá cargar o difundir contenido ilegal, engañoso, perjudicial, que vulnere derechos de terceros, interfiera con sistemas, eluda protecciones o infrinja estos Términos." },
  { kind: "h2", text: "BYOK y servicios de terceros" },
  { kind: "paragraph", text: "Si el Servicio le permite aportar su propia clave (BYOK) o conectar servicios de terceros, usted será responsable de disponer de los derechos, permisos y consentimientos necesarios y de cumplir los términos aplicables de esos terceros. La disponibilidad, el tratamiento, los costes, la conservación de datos y la seguridad de los servicios de terceros pueden depender de ellos, y Tencent no será responsable de esos aspectos." },
  { kind: "h2", text: "Suscripciones, tarifas y pagos" },
  { kind: "paragraph", text: "Determinados servicios o funciones pueden requerir una suscripción, un pago anticipado, tarifas basadas en el uso u otros acuerdos de pago. Deberá abonar las tarifas correspondientes conforme a los precios, impuestos, métodos de pago y plazos indicados en la página del servicio, el pedido, la factura o el proceso de pago. Salvo que la ley lo exija o estos Términos dispongan lo contrario, las cantidades pagadas podrán no ser reembolsables." },
  { kind: "paragraph", text: "Debe asegurarse de que el método de pago sea válido y autorizarnos a nosotros o al procesador de pagos externo a cobrar las tarifas. Usted será responsable de los impuestos, aranceles, tasas y demás gravámenes públicos relacionados con la adquisición o el uso del Servicio, salvo los impuestos sobre la renta de Tencent." },
  { kind: "h2", text: "Obligaciones del usuario" },
  { kind: "paragraph", text: "Debe cumplir todas las leyes aplicables, los requisitos regulatorios, estos Términos, la Documentación y los límites del Servicio, y será responsable de sus Entradas, Salidas, Datos del usuario, configuraciones, integraciones de terceros y usos posteriores. No podrá utilizar el Servicio para actividades ilegales, de alto riesgo, engañosas, que vulneren derechos, impliquen acoso u odio, distribuyan malware, eludan medidas de seguridad, accedan sin autorización, abusen de sistemas o perjudiquen a Tencent, sus usuarios, terceros o el público." },
  { kind: "h2", text: "Titularidad y derechos de propiedad intelectual" },
  { kind: "paragraph", text: "Salvo por la licencia limitada que se le concede expresamente, Tencent y sus licenciantes conservan todos los derechos, títulos e intereses sobre el Servicio, el Software, la Documentación, las marcas, los logotipos, la tecnología, los sistemas y los derechos de propiedad intelectual relacionados. Usted conserva sus derechos sobre los Datos del usuario, las Entradas y el contenido que posea legítimamente; el uso de las Salidas seguirá sujeto a la legislación aplicable, los derechos de terceros y estos Términos." },
  { kind: "h2", text: "Confidencialidad" },
  { kind: "paragraph", text: "Al utilizar el Servicio podrá acceder a información no pública de Tencent, tecnología, planes de productos, interfaces, credenciales u otra información confidencial. Salvo para utilizar el Servicio conforme a estos Términos, no podrá divulgar, copiar, transferir ni utilizar indebidamente dicha información sin el consentimiento previo y por escrito de Tencent." },
  { kind: "h2", text: "Privacidad" },
  { kind: "paragraph", text: "Tratamos la información personal de acuerdo con la Política de privacidad aplicable al Servicio. Dicha política explica cómo recopilamos, utilizamos, almacenamos, compartimos y protegemos la información personal, así como los derechos que puede ejercer. Consulte: [https://lightvela.ai/zh-sg/privacy-policy/]." },
  { kind: "h2", text: "Vigencia y terminación" },
  { kind: "paragraph", text: "Estos Términos entran en vigor cuando los acepta o cuando accede, descarga, instala o utiliza por primera vez el Servicio, y continúan vigentes hasta que se resuelvan conforme a ellos. Podremos suspender o terminar su acceso si incumple los Términos, genera un riesgo jurídico o de seguridad, existe una exigencia regulatoria, se interrumpe el servicio o concurre otra circunstancia permitida. Tras la terminación, deberá dejar de utilizar el Servicio y, si se le solicita, eliminar o devolver el Software y la información confidencial relacionada." },
  { kind: "h2", text: "Exclusiones de responsabilidad y ausencia de garantías" },
  { kind: "paragraph", text: "En la medida permitida por la legislación aplicable, el Servicio se ofrece “tal cual” y “según disponibilidad”. Tencent no garantiza, de forma expresa, implícita o legal, que el Servicio sea ininterrumpido, esté libre de errores, sea seguro, exacto o completo, resulte adecuado para una finalidad concreta o satisfaga sus necesidades." },
  { kind: "h2", text: "Indemnización" },
  { kind: "paragraph", text: "Deberá indemnizar y mantener indemnes a Tencent y sus afiliadas frente a reclamaciones, pérdidas, responsabilidades, costes y gastos derivados de su incumplimiento de estos Términos, el uso ilícito del Servicio, sus Datos del usuario o contenido, las integraciones de terceros, la vulneración de derechos de terceros o sus usos posteriores." },
  { kind: "h2", text: "Limitación de responsabilidad" },
  { kind: "paragraph", text: "En la medida permitida por la legislación aplicable, Tencent no será responsable de pérdidas indirectas, incidentales, especiales, punitivas o consecuentes, lucro cesante, pérdida de ingresos, fondo de comercio o datos, interrupciones del negocio ni costes de servicios sustitutivos. La responsabilidad total de Tencent estará sujeta a los límites establecidos en estos Términos y en la legislación aplicable." },
  { kind: "h2", text: "Legislación aplicable y resolución de controversias" },
  { kind: "paragraph", text: "Salvo que el Anexo específico por jurisdicción o una norma imperativa aplicable disponga lo contrario, la legislación aplicable, el arbitraje y los mecanismos de resolución de controversias serán los establecidos en la versión oficial en inglés. Las controversias que no puedan resolverse mediante conversaciones se resolverán conforme al mecanismo previsto en estos Términos." },
  { kind: "h2", text: "Disposiciones generales" },
  { kind: "paragraph", text: "Estos Términos incluyen disposiciones generales sobre cesión, notificaciones, fuerza mayor, divisibilidad, ausencia de terceros beneficiarios, acuerdo completo e idioma. Podemos traducirlos a otros idiomas; en caso de incoherencia entre la versión en inglés y cualquier otra versión, prevalecerá la versión en inglés, salvo que una norma imperativa disponga lo contrario." },
  { kind: "h2", text: "Atención al cliente y contacto" },
  { kind: "paragraph", text: "Si tiene preguntas, consultas, reclamaciones o comentarios relacionados con estos Términos o con el uso del Servicio, puede ponerse en contacto con nosotros en [lightvela@tencent.com]. Le responderemos lo antes posible después de recibir su comunicación y, cuando corresponda, dentro del plazo exigido por la legislación aplicable." },
  { kind: "h2", text: "Anexo específico por jurisdicción" },
  { kind: "h3", text: "Kenia" },
  { kind: "paragraph", text: "Si selecciona Kenia como país de registro, el anexo de Kenia se aplicará como término adicional. Abarca la legislación de protección del consumidor, la edad mínima, la información sobre IA, los límites de responsabilidad, la resolución de controversias y el cumplimiento relativo al contenido. En caso de conflicto con estos Términos, el anexo prevalecerá en la medida de la incoherencia." },
  { kind: "h3", text: "Vietnam" },
  { kind: "paragraph", text: "Si accede al Servicio o lo utiliza desde Vietnam, el anexo de Vietnam se aplicará como término adicional. Abarca el ámbito de aplicación, la edad mínima, la transparencia y el etiquetado de contenido de IA, la gestión de incidentes, el gobierno y la localización de datos, la ciberseguridad, la protección de datos personales, las restricciones de uso, las obligaciones del responsable del despliegue, la protección del consumidor, las sanciones, la legislación aplicable y las actualizaciones regulatorias. En caso de conflicto, las normas imperativas de Vietnam y el anexo prevalecerán en la medida necesaria." },
  { kind: "h2", text: "Idioma" },
  { kind: "paragraph", text: "En caso de discrepancia o incoherencia entre la versión en inglés y esta traducción al español, prevalecerá la versión en inglés, salvo que la legislación aplicable disponga lo contrario." },
];

function normalizeLine(line: string): string {
  return line.replace(/·{2,}\d*$/g, "").trim();
}

function isWarning(line: string): boolean {
  return line.length > 36 && /[A-Z]/.test(line) && line === line.toUpperCase();
}

function parseTermsBlocks(text: string): TermsBlock[] {
  return text
    .split(/\n{2,}/)
    .map(normalizeLine)
    .filter((line) => line && line !== "LightVela Terms of Service" && line !== ".")
    .map((line) => {
      if (primaryHeadings.has(line)) return { kind: "h2", text: line };
      if (secondaryHeadings.has(line)) return { kind: "h3", text: line };
      if (isWarning(line)) return { kind: "warning", text: line };
      return { kind: "paragraph", text: line };
    });
}

export function getTermsOfServiceBlocks(
  locale: PublicSiteLocaleCode,
  englishBlocks: TermsBlock[],
): TermsBlock[] {
  if (locale === PUBLIC_SITE_LOCALES.ES) return esTermsBlocks;
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return idTermsBlocks;
  return isZhLocale(locale) ? zhTermsBlocks : englishBlocks;
}

const lightVelaLegalPaths: Record<string, string> = {
  "https://lightvela.ai/docs/overview/": "/docs/overview",
  "https://lightvela.ai/zh-sg/privacy-policy/": "/privacy-policy",
  "https://lightvela.ai/zh-sg/open-source-licenses/": "/open-source-licenses",
};

function withTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function publicLocalePrefix(locale: PublicSiteLocaleCode): string {
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return `/${PUBLIC_URL_LANGS.ID_ID}`;
  if (locale === PUBLIC_SITE_LOCALES.ZH_HANT) return `/${PUBLIC_URL_LANGS.ZH_HANT}`;
  if (locale === PUBLIC_SITE_LOCALES.ES) return `/${PUBLIC_URL_LANGS.ES}`;
  if (locale.startsWith("zh")) return `/${PUBLIC_URL_LANGS.ZH_SG}`;
  return `/${PUBLIC_URL_LANGS.EN_US}`;
}

export function localizedLegalPath(path: string, locale: PublicSiteLocaleCode, forceLocalePrefix: boolean): string {
  if (!forceLocalePrefix) return withTrailingSlash(localizedPath(path, locale));
  return withTrailingSlash(`${publicLocalePrefix(locale)}${path}`);
}

export function localizedLightVelaUrl(
  url: string,
  locale: PublicSiteLocaleCode,
  forceLocalePrefix: boolean,
): { href: string; label: string } | null {
  const barePath = lightVelaLegalPaths[url];
  if (!barePath) return null;
  const href = localizedLegalPath(barePath, locale, forceLocalePrefix);
  return {
    href,
    label: `https://lightvela.ai${href}`,
  };
}

function LegalRichText({
  text,
  locale,
  forceLocalePrefix,
}: {
  text: string;
  locale: PublicSiteLocaleCode;
  forceLocalePrefix: boolean;
}) {
  const parts = text.split(/(https?:\/\/[^\]\s]+|lightvela@tencent\.com)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        if (part === "lightvela@tencent.com") {
          return (
            <a key={`${part}-${index}`} href="mailto:lightvela@tencent.com" className="font-semibold text-blue-600 underline underline-offset-2">
              {part}
            </a>
          );
        }
        if (part.startsWith("http")) {
          const localizedUrl = localizedLightVelaUrl(part, locale, forceLocalePrefix);
          if (localizedUrl) {
            return (
              <a key={`${part}-${index}`} href={localizedUrl.href} className="font-semibold text-blue-600 underline underline-offset-2">
                {localizedUrl.label}
              </a>
            );
          }
          return (
            <a key={`${part}-${index}`} href={part} target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-600 underline underline-offset-2">
              {part}
            </a>
          );
        }
        return part;
      })}
    </>
  );
}

function renderBlock(block: TermsBlock, index: number, locale: PublicSiteLocaleCode, forceLocalePrefix: boolean): ReactNode {
  if (block.kind === "h2") {
    return (
      <h2 key={`${block.text}-${index}`} className="border-t border-slate-200 pt-12 text-2xl font-semibold tracking-[-0.04em] text-slate-950 first:border-t-0 first:pt-0">
        {block.text}
      </h2>
    );
  }
  if (block.kind === "h3") {
    return (
      <h3 key={`${block.text}-${index}`} className="pt-2 text-xl font-semibold tracking-[-0.03em] text-slate-950">
        {block.text}
      </h3>
    );
  }
  if (block.kind === "warning") {
    return (
      <p key={`${block.text}-${index}`} className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-semibold leading-7 text-slate-900">
        <LegalRichText text={block.text} locale={locale} forceLocalePrefix={forceLocalePrefix} />
      </p>
    );
  }
  return (
    <p key={`${block.text}-${index}`} className="text-base leading-9 text-slate-700">
      <LegalRichText text={block.text} locale={locale} forceLocalePrefix={forceLocalePrefix} />
    </p>
  );
}

export const TermsOfServicePage = () => {
  const localeOverride = useLocaleOverride();
  const currentLocale: PublicSiteLocaleCode =
    localeOverride === PUBLIC_SITE_LOCALES.ID_ID
      ? PUBLIC_SITE_LOCALES.ID_ID
      : localeOverride === PUBLIC_SITE_LOCALES.ES
        ? PUBLIC_SITE_LOCALES.ES
      : localeOverride === PUBLIC_SITE_LOCALES.ZH_HANT
        ? PUBLIC_SITE_LOCALES.ZH_HANT
        : localeOverride?.startsWith("zh")
          ? PUBLIC_SITE_LOCALES.ZH_SG
          : PUBLIC_SITE_LOCALES.EN_US;
  const selectedCopy = useZhHantDeep(getTermsOfServiceChrome(currentLocale));
  const englishBlocks = useMemo(() => parseTermsBlocks(termsOfServiceText), []);
  const localizedBlocks = getTermsOfServiceBlocks(currentLocale, englishBlocks);
  const blocks = useZhHantDeep(localizedBlocks);
  const forceLocalePrefix = Boolean(localeOverride);
  const homePath = forceLocalePrefix ? localizedLegalPath("/", currentLocale, true) : localizedPath("/", currentLocale);

  return (
    <div className="min-h-dvh bg-[#F7F8FA] text-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <AppLink to={homePath} className="text-xl font-semibold tracking-[-0.04em] text-slate-950">
            {selectedCopy.brand}
          </AppLink>
          <AppLink to={homePath} className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-950">
            {selectedCopy.backHome}
          </AppLink>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14 lg:py-16">
        <article className="rounded-[2rem] border border-slate-200 bg-white px-5 py-8 shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)] sm:px-8 sm:py-10 lg:px-12">
          <div className="border-b border-slate-200 pb-12 sm:pb-14">
            <h1 className="text-4xl font-semibold tracking-[-0.06em] text-slate-950 sm:text-5xl">{selectedCopy.title}</h1>
            <p className="mt-6 max-w-3xl text-base leading-8 text-slate-700">{selectedCopy.description}</p>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-500">{selectedCopy.note}</p>
          </div>

          <section className="space-y-7 pt-12 sm:pt-14">
            {blocks.map((block, index) => renderBlock(block, index, currentLocale, forceLocalePrefix))}
          </section>
        </article>
      </main>

      <LegalFooter />
    </div>
  );
};

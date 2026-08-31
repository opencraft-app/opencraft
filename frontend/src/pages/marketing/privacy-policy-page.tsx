"use client";

import { Fragment, type ReactNode } from "react";
import { LegalFooter } from "@/components/site/legal-footer";
import { useLocaleOverride } from "@/i18n/t";
import { AppLink } from "@/lib/app-navigation";
import { localizedPath } from "@/lib/region";
import { PUBLIC_SITE_LOCALES, PUBLIC_URL_LANGS, type PublicSiteLocaleCode } from "@/lib/public-site-routing";
import { isZhLocale, useZhHantDeep } from "@/lib/zh-hant";
import { JAPANESE_PRIVACY_POLICY_COPY } from "./legal-copy.ja";

interface PolicyCopy {
  backHome: string;
  brand: string;
  title: string;
  updated: string;
  intro: string[];
  sections: Array<{ title: string; paragraphs: string[]; bullets?: string[] }>;
  processTitle: string;
  processIntro: string[];
  processRows: Array<{ category: string; data: Array<{ personal: string; use: string; basis: string; useRows?: Array<{ use: string; basis: string }> }> }>;
  shareTitle: string;
  shareParagraphs: string[];
  shareBullets: Array<{ text: string; children?: string[] }>;
  retentionTitle: string;
  retentionIntro: string[];
  retentionRows: Array<{ personal: string; policy: string }>;
  rightsTitle: string;
  rightsIntro: string;
  rightsBullets: string[];
  contactTitle: string;
  contactParagraphs: string[];
  thirdPartyTitle: string;
  thirdPartyParagraph: string;
  changesTitle: string;
  changesParagraph: string;
  languageTitle: string;
  languageParagraph: string;
}

const en: PolicyCopy = {
  backHome: "Back to Home",
  brand: "LightVela",
  title: "Privacy Policy",
  updated: "Last Updated: August 2026",
  intro: [
    "Welcome to LightVela! This Privacy Policy explains the when, how, and why when it comes to the processing of your personal information in connection with the LightVela website and service (together, the “Service”), and sets out your choices and rights in relation to that information.",
    "For the purposes of data protection laws, the data controller of your personal information in relation to the Service is Tencent Cloud International Pte. Ltd. (“we”, “us”, “our”).",
    "Please note that this Privacy Policy only applies to the Service. If you use any other products or services, please refer to the privacy policy for that particular product or service.",
    "If you do not agree to the processing of your personal information in the way this Privacy Policy describes, please do not provide your information when requested and stop using the Service. By using the Service you are acknowledging how we process your personal information as described in this Privacy Policy and, to the extent performance of a contract or legitimate interest cannot be relied upon in your jurisdiction to process the personal information, you consent to the processing of your personal information as described in this Privacy Policy.",
    "If you have any questions about anything in this Privacy Policy, or want to exercise any rights you may have, our contact information can be found in Section 7 (Contact) below.",
  ],
  sections: [
    {
      title: "1. Children",
      paragraphs: [
        "Those under 18 years old are not permitted to use the Service for any purpose.",
        "We do not seek or knowingly collect personal information from children under 18 for any purpose. If you believe that we have personal information of anyone under the age of 18, or if you are the parent or guardian of the user and wish to notify us that a user is under 18 years old, please contact us as set out in Section 7 (Contact) below.",
      ],
    },
  ],
  processTitle: "2. How We Process Your Personal Information",
  processIntro: [
    "This section provides more detail on the types of personal information we collect from you, and why.",
    "It also identifies the legal basis under which we process your data to the extent required by the data protection laws in your jurisdiction. To the extent the laws in your jurisdiction do not recognise the legal basis of performance of a contract or legitimate interest, you consent to the processing of your personal information for that purpose by consenting to the processing in this Privacy Policy.",
  ],
  processRows: [
    {
      category: "Information you provide to us (either directly or through a third party)",
      data: [
        {
          personal: "Login and account information, and security credential information such as your email address, username/nickname, third-party login identifiers, IP address, oAuth token, session token, account status, and user IDs.",
          use: "We use this information to create, authenticate, and manage your account for the Service, and operate and provide the Service to you.",
          basis: "Necessary to perform our contract with you to provide the Service.",
        },
        {
          personal: "Inputs and Outputs: User prompts and instructions provided in your chat, coding, memory, and agentic sessions, and the responses and actions generated.\n\nWhen using Messaging Channels and AgentChat, we also process message relay data, such as timestamps, channel identifiers, and sender identifiers.\n\nIf you choose to integrate third-party applications, or upload any files and information, including personal information, as part of your Inputs, we will collect this information and this information may be reproduced in Outputs.",
          use: "We use this information to process your Inputs and provide you with Outputs in accordance with your instructions.\n\nWe use this information to relay your messages between Messaging Channels and AgentChat and the Service to provide you with the Service.\n\nWe also use this information to investigate and resolve any security issues and to perform security checks to ensure there are no security risks.",
          basis: "Necessary to perform our contract with you to provide the Service.\n\nIt is also in our legitimate interests to safeguard your data and our systems.",
        },
        {
          personal: "Payment information: If you choose to purchase access to the Service, we will process payment information such as payment order number, payment transaction serial number, payment amount, payment timestamp, payment channel, payment status returned by the payment processor, payment method metadata, and the last four digits of the credit card provided by the payment processor.\n\nOur third-party payment providers (e.g. credit card issuing banks) process related data on our behalf.",
          use: "We use this information to manage billing and payments for the Service.",
          basis: "Necessary to perform our contract with you to provide the Service.",
        },
        {
          personal: "Communication information: If you communicate with us or we provide announcements, we process information such as your name, contact information and the content of the communication that you send.",
          use: "We use this information to communicate with you regarding issues you raise.\n\nWe may from time to time send you announcements when we consider it necessary to do so (for example, when we temporarily suspend access to the Service for maintenance, or security, privacy, or administrative-related communications). These are essential system and service-related announcements and you are not able to opt out of these notifications, which are not promotional in nature.",
          basis: "Necessary to perform our contract with you to provide the Service.",
        },
        {
          personal: "Feedback information: If you choose to provide feedback and suggestions for improvement, or ratings on an Output, through the application or on our Discord server, we will store the related conversation as part of your feedback.",
          use: "We use this information to resolve any issues you may face, debug and repair any problems, and to improve the Services and conduct research.",
          basis: "We process this information with your consent.\n\nIt is also in our legitimate interests to maintain the functioning of our Services, diagnose errors, and to further improve and develop the Services.",
        },
      ],
    },
    {
      category: "Information generated as part of the Service",
      data: [
        {
          personal: "Device information such as device identifiers, types, models, operating system information, IP addresses, network and connection information, remote control session information, and plugin information.",
          use: "We use this information to:\n• provide you with the Service;\n• create and manage your account;\n• provide and maintain optional services and features that improve the Service’s functionality and your experience; and\n• detect and identify errors and bugs, and troubleshoot.",
          basis: "Necessary to perform our contract with you. It is also in our legitimate interests to maintain the functioning of our Services and diagnose errors.",
        },
        {
          personal: "Configuration information: We process information about how hardware, software and network components operate and interact, such as system and infrastructure configuration information, and Messaging Channel authorisation and configuration data and metadata.",
          use: "We use this information to maintain your configuration settings of the Service and to provide you with the Service.",
          basis: "Necessary to perform our contract with you to provide the Service.",
        },
        {
          personal: "Diagnostic and usage information, and log information: We process information about your use of the Services, such as your dates and times of login, access, and search, IP address, runtime environment information, network and security information, deployment and error logs, application and performance metrics and codes, and integrations, and other information on how you use the Services.",
          use: "We use this information to:\n• provide you with the Service;\n• monitor the Service's performance and quality;\n• detect and identify errors and bugs, and troubleshoot; and\n• improve, optimize, and develop the Service.",
          basis: "It is in our legitimate interest to monitor system performance, diagnose errors, and improve the product.",
        },
        {
          personal: "Billing and consumption information: We process information relating to billing, such as cardholder name and contact information, transaction amounts and timestamps, order numbers, and purchased services and features.",
          use: "We use this information to manage billing and payments for the Service.",
          basis: "Necessary to perform our contract with you to provide the Service.",
        },
        {
          personal: "Compliance records: Consent and withdrawal records, data deletion and export request records, and any other personal information required to be retained or disclosed pursuant to applicable laws, regulations, court orders, or government requests.",
          use: "We use this information to comply with applicable legal obligations, respond to regulatory requests, and fulfil data subject rights.",
          basis: "We process this information to fulfil our legal obligations.",
        },
        {
          personal: "Other information we have about you: such as device identifiers, device information, IP address, information about use of the Service, Inputs and Outputs and plugin data.",
          use: "We use this information to ensure the security of our services, including aggregating and anonymising the information for that purpose.",
          basis: "It is in our legitimate interest to ensure the security of our Service or our services.",
          useRows: [
            {
              use: "We use this information to ensure the security of our services, including aggregating and anonymising the information for that purpose.",
              basis: "It is in our legitimate interest to ensure the security of our Service or our services.",
            },
            {
              use: "We use this information to improve our services, including aggregating and anonymising the information for that purpose.",
              basis: "It is in our legitimate interest to improve the Service or our services.",
            },
          ],
        },
      ],
    },
  ],
  shareTitle: "3. How We Store and Share Your Personal Information",
  shareParagraphs: [
    "Your personal information will be stored in servers in Singapore. We also have global support, engineering, and other teams who support the Service, including from Singapore and the People’s Republic of China.",
    "We will transfer data outside of the jurisdiction in which you are based for the purposes described in this Privacy Policy. When we do so, we will take steps to ensure that your personal information is protected and we implement safeguards where required. Safeguards include standard contractual clauses, adequacy decisions where available, data processing agreements with all third-party data processors, and other contractual safeguards. You may contact us via the details in Section 7 (Contact) to see a copy of these safeguards.",
    "We will share your personal information with third parties in the following situations:",
  ],
  shareBullets: [
    {
      text: "Third parties that provide services in support of the Service, including providers of services that process personal information identified in this policy in our legitimate interests of efficiently providing the Service. For example, we will transfer your personal information to:",
      children: [
        "payment processors that process payment instruction data for payment of the Service.",
      ],
    },
    { text: "Third party websites and services: You may choose to integrate the Service with various third-party websites, apps and services (e.g. through API keys), such as LLM providers, third party service providers for Skills, and Messaging Channels. If you choose to do so, we will share your personal information with these third-party websites, apps and services in accordance with your instruction. Processing once transferred to such third party websites and services shall be subject to the third party’s privacy policy. Any link to such services and sites does not mean that we endorse such third party." },
    { text: "Companies within our corporate group who process your personal information in our legitimate interests to help efficiently provide the Service. All such group companies may only use your personal information in accordance with this Privacy Policy." },
    { text: "Regulators, judicial authorities, and law enforcement agencies. There are circumstances in which we may be legally required to disclose personal information about you, such as to comply with legal obligations or processes. We may also disclose personal information to regulators, judicial authorities, and law enforcement agencies to ensure safety, security, or compliance with laws." },
    { text: "Third parties to ensure safety, security, or compliance with laws. We may disclose your personal information to: (a) enforce our terms and conditions and other agreements, including investigation of any potential violation thereof; (b) detect, prevent, or otherwise address security, fraud, or technical issues; or (c) protect the rights, property, or safety of us, our users, a third party, or the public as required or permitted by law." },
    { text: "Professional advisors. We may disclose your personal information to auditors, law firms, or accounting firms, as a matter of our legitimate interests to assess, protect, enforce and defend our rights and to comply with our legal and regulatory obligations." },
    { text: "A third party that acquires all or substantially all of us or our business. We may also disclose your personal information to third parties if we either: (a) sell, transfer, merge, consolidate, or reorganize any part(s) of our business, or merge with, acquire, or form a joint venture with any other business, in which case we may disclose your data to any prospective buyer, new owner, or other third party involved in such change to our business; or (b) sell or transfer any of our assets, in which case the personal information we hold about you may be sold as part of those assets and may be transferred to any prospective buyer, new owner, or other third party involved in such sale or transfer." },
  ],
  retentionTitle: "5. Data Retention",
  retentionIntro: [
    "To execute your instructions and provide you with the Service, we will store relevant personal information on our own servers, as set out in the table below.",
    "Please note that we do not keep your data for longer than is necessary to fulfil the relevant purpose described above unless we are required or permitted to do so under law. If we retain your personal information beyond the retention periods set out below, for example to comply with applicable laws, we will store it separately from other types of personal information.",
  ],
  retentionRows: [
    { personal: "Login and account information, and security credential information\n\nInputs and Outputs", policy: "Stored for as long as you maintain an account with us and deleted within 30 days after, or within 30 days if you request for deletion, whichever is earlier." },
    { personal: "Device information", policy: "Stored for as long as you maintain an account with us and deleted within 30 days after account termination, or within 30 days if you request for deletion, whichever is earlier. Device information for troubleshooting is retained for as long as necessary for support and no longer than 30 days after you stop maintaining an account with us." },
    { personal: "Configuration information", policy: "Stored for as long as you maintain an account with us and deleted within 30 days upon your request for deletion." },
    { personal: "Diagnostic and usage data, and log information", policy: "Stored for up to 6 months." },
    { personal: "Payment information\n\nBilling and consumption information", policy: "Stored for up to 24 months after the termination of your account for financial/tax compliance." },
    { personal: "Compliance records", policy: "As required by applicable law." },
    { personal: "Communication information", policy: "Until resolution of the issue that you are communicating with us about." },
    { personal: "Feedback information", policy: "Stored for up to 24 months after submission or account termination." },
  ],
  rightsTitle: "6. Your Rights",
  rightsIntro: "We offer our users the following rights in respect of your personal information, which you may have a legal right to exercise depending on where you are. Some of these only apply in certain circumstances, and we will let you know if that is the case when you request the exercise of the right. You can exercise some of these rights directly by accessing and updating the personal information in your account. Otherwise, please contact us using the details in Section 7 (Contact) below.",
  rightsBullets: [
    "Access. You may have the right to access personal information we hold about you, how we use it, and who we share it with.",
    "Portability. You may have the right to receive a copy of certain personal information we process about you.",
    "Correction. You may have the right to correct personal information we hold that is inaccurate.",
    "Erasure. You may be able to delete your account or remove certain personal information by logging into your account or requesting erasure from us.",
    "Restriction of Processing to Storage Only. You may have a right to require that we stop processing your personal information other than for storage purposes in certain circumstances.",
    "Objection. You may have the right to object to our processing of your personal information in certain situations.",
    "Consent Withdrawal. To the extent provided by applicable laws and regulations, you may withdraw consent you previously provided to us for certain processing activities by contacting us. Where consent is required to process your personal information, if you do not consent to the processing or if you withdraw your consent we may not be able to deliver the expected service. Please note that the right to withdraw consent is only available if the legal basis for processing information is consent.",
    "You also have the right to lodge a complaint directly with us, as well as with the relevant data protection authority in the country you live or work.",
  ],
  contactTitle: "7. Contact",
  contactParagraphs: [
    "Please get in touch with us if you have any questions. You can reach us in the first instance at:",
    "Email: lightvela@tencent.com",
    "We will endeavour to deal with your request as soon as possible. This is without prejudice to any right you may have to launch a claim with a data protection authority in the jurisdiction in which you live or work where you think we have infringed data protection laws.",
  ],
  thirdPartyTitle: "8. Third-Party Websites and Links",
  thirdPartyParagraph: "We may provide links or access to third-party websites, services and features as part of the Service. You may elect to connect to your chosen LLM through BYOK, connect to your preferred Messaging Channels, and/or download and install Skills.\n\nIf you follow links to sites or platforms or enable features that we do not control and are not affiliated with us, you should review the applicable privacy notice, policies and other terms. We are not responsible for the privacy or security of, or information found on, these sites or platforms. Our inclusion of such links or access to such features does not, by itself, imply any endorsement of the content on such platforms, the operation of such features, or of their owners or operators.",
  changesTitle: "9. Changes",
  changesParagraph: "If we make any changes to this Privacy Policy we will post the updated Privacy Policy here and notify you in accordance with relevant legal requirements.",
  languageTitle: "10. Language",
  languageParagraph: "Except as otherwise prescribed by law, in the event of any discrepancy or inconsistency between the English version and local language version of this Privacy Policy, the English version shall prevail.",
};

const zh: PolicyCopy = {
  backHome: "返回首页",
  brand: "LightVela",
  title: "隐私政策",
  updated: "最后更新：2026 年 8 月",
  intro: [
    "欢迎使用 LightVela！本隐私政策说明我们在您使用 LightVela 网站及服务（合称“服务”）时，会在何时、如何以及为何处理您的个人信息，并说明您对相关信息享有的选择和权利。",
    "就数据保护法律而言，与服务相关的个人信息控制者为 Tencent Cloud International Pte. Ltd.（“我们”）。",
    "请注意，本隐私政策仅适用于本服务。如果您使用其他产品或服务，请查阅该产品或服务对应的隐私政策。",
    "如果您不同意本隐私政策所述的个人信息处理方式，请不要在被要求时提供信息，并停止使用本服务。使用本服务即表示您确认我们将按照本隐私政策处理您的个人信息；在您所在司法辖区无法以履行合同或合法利益作为处理个人信息的法律依据时，您同意我们按照本隐私政策处理您的个人信息。",
    "如果您对本隐私政策有任何问题，或希望行使您可能享有的任何权利，请通过第 7 节（联系我们）中的联系方式与我们联系。",
  ],
  sections: [
    {
      title: "1. 儿童",
      paragraphs: [
        "未满 18 周岁的个人不得出于任何目的使用本服务。",
        "我们不会出于任何目的寻求或故意收集 18 周岁以下儿童的个人信息。如果您认为我们持有任何 18 周岁以下人员的个人信息，或者您是该用户的父母或监护人并希望通知我们该用户未满 18 周岁，请按照第 7 节（联系我们）中的方式联系我们。",
      ],
    },
  ],
  processTitle: "2. 我们如何处理您的个人信息",
  processIntro: [
    "本节将更详细说明我们从您处收集的个人信息类型及其用途。",
    "在您所在司法辖区的数据保护法律要求的范围内，本节也说明我们处理数据所依据的法律基础。如果您所在司法辖区不承认履行合同或合法利益作为法律基础，您通过同意本隐私政策，即同意我们为相应目的处理您的个人信息。",
  ],
  processRows: [
    {
      category: "您向我们提供的信息（直接提供或通过第三方提供）",
      data: [
        { personal: "登录和账户信息，以及安全凭证信息，例如电子邮箱、用户名/昵称、第三方登录标识、IP 地址、OAuth token、session token、账户状态和用户 ID。", use: "我们使用这些信息创建、认证和管理您的服务账户，并运营和向您提供服务。", basis: "为履行我们与您之间提供服务的合同所必需。" },
        { personal: "输入和输出：您在聊天、编码、记忆和智能体会话中提供的用户提示、指令，以及生成的响应和操作。使用消息渠道和 AgentChat 时，我们还会处理消息转发数据，例如时间戳、渠道标识和发送方标识。如果您选择集成第三方应用，或上传任何文件和信息（包括个人信息）作为输入的一部分，我们将收集这些信息，且这些信息可能会在输出中再现。", use: "我们使用这些信息按照您的指令处理输入并向您提供输出，在消息渠道、AgentChat 与服务之间转发消息，调查并解决安全问题，以及执行安全检查以确保不存在安全风险。", basis: "为履行向您提供服务的合同所必需；同时，为保护您的数据和我们的系统安全，这也符合我们的合法利益。" },
        { personal: "支付信息：如果您选择购买服务访问权限，我们会处理支付信息，例如支付订单号、支付交易流水号、支付金额、支付时间戳、支付渠道、支付处理方返回的支付状态、支付方式元数据，以及支付处理方提供的信用卡末四位。我们的第三方支付服务提供商（例如发卡银行）将代表我们处理相关数据。", use: "我们使用这些信息管理服务的账单和支付。", basis: "为履行我们与您之间提供服务的合同所必需。" },
        { personal: "沟通信息：如果您与我们沟通，或我们向您发送公告，我们会处理您的姓名、联系方式以及您发送的沟通内容等信息。", use: "我们使用这些信息就您提出的问题与您沟通。我们也可能不时发送必要的系统和服务相关公告，例如维护、安全、隐私或管理相关通知。此类通知并非营销性质，且无法退订。", basis: "为履行我们与您之间提供服务的合同所必需。" },
        { personal: "反馈信息：如果您选择通过应用或我们的 Discord 服务器提供反馈、改进建议，或对输出进行评分，我们会将相关对话作为反馈的一部分保存。", use: "我们使用这些信息解决您可能遇到的问题、调试和修复问题、改进服务并开展研究。", basis: "我们基于您的同意处理这些信息；同时，为维护服务正常运行、诊断错误以及进一步改进和开发服务，这也符合我们的合法利益。" },
      ],
    },
    {
      category: "作为服务一部分生成的信息",
      data: [
        { personal: "设备信息，例如设备标识符、类型、型号、操作系统信息、IP 地址、网络和连接信息、远程控制会话信息及插件信息。", use: "我们使用这些信息向您提供服务、创建和管理账户、提供和维护可选服务及功能，并检测、识别和排查错误及缺陷。", basis: "为履行合同所必需；同时，为维护服务运行并诊断错误，这也符合我们的合法利益。" },
        { personal: "配置信息：我们处理关于硬件、软件和网络组件如何运行和交互的信息，例如系统和基础设施配置信息，以及消息渠道授权和配置数据及元数据。", use: "我们使用这些信息维护您的服务配置设置，并向您提供服务。", basis: "为履行我们与您之间提供服务的合同所必需。" },
        { personal: "诊断和使用信息及日志信息：我们处理关于您如何使用服务的信息，例如登录、访问和搜索的日期和时间、IP 地址、运行环境信息、网络和安全信息、部署和错误日志、应用和性能指标及代码、集成信息，以及您如何使用服务的其他信息。", use: "我们使用这些信息提供服务、监控服务性能和质量、检测并排查错误及缺陷，以及改进、优化和开发服务。", basis: "为监控系统性能、诊断错误和改进产品，这符合我们的合法利益。" },
        { personal: "账单和用量信息，例如持卡人姓名和联系方式、交易金额和时间戳、订单号以及购买的服务和功能。", use: "我们使用这些信息管理服务的账单和支付。", basis: "为履行我们与您之间提供服务的合同所必需。" },
        { personal: "合规记录：同意和撤回记录、数据删除和导出请求记录，以及根据适用法律、法规、法院命令或政府请求需要保留或披露的其他个人信息。", use: "我们使用这些信息遵守适用法律义务、回应监管请求并履行数据主体权利。", basis: "我们为履行法律义务而处理这些信息。" },
        { personal: "我们掌握的关于您的其他信息，例如设备标识符、设备信息、IP 地址、服务使用信息、输入和输出以及插件数据。", use: "我们使用这些信息确保服务安全，包括为该目的对信息进行汇总和匿名化处理。", basis: "确保本服务或我们的服务安全符合我们的合法利益。", useRows: [{ use: "我们使用这些信息确保服务安全，包括为该目的对信息进行汇总和匿名化处理。", basis: "确保本服务或我们的服务安全符合我们的合法利益。" }, { use: "我们使用这些信息改进服务，包括为该目的对信息进行汇总和匿名化处理。", basis: "改进本服务或我们的服务符合我们的合法利益。" }] },
      ],
    },
  ],
  shareTitle: "3. 我们如何存储和共享您的个人信息",
  shareParagraphs: [
    "您的个人信息将存储在新加坡的服务器中。我们也拥有为本服务提供支持的全球支持、工程和其他团队，包括位于新加坡和中华人民共和国的团队。",
    "为实现本隐私政策所述目的，我们会将数据传输至您所在司法辖区之外。进行此类传输时，我们会采取措施保护您的个人信息，并在需要时实施保障措施，包括标准合同条款、可适用的充分性认定、与所有第三方数据处理者签署的数据处理协议以及其他合同保障。您可以通过第 7 节（联系我们）中的联系方式联系我们，以查看这些保障措施的副本。",
    "我们将在以下情况下与第三方共享您的个人信息：",
  ],
  shareBullets: [
    {
      text: "为支持本服务而提供服务的第三方，包括代表我们基于高效提供服务的合法利益处理本政策所述个人信息的服务提供商。例如，我们会将您的个人信息传输给：",
      children: ["为本服务付款处理支付指令数据的支付处理方。"],
    },
    { text: "第三方网站和服务：您可以选择将本服务与各种第三方网站、应用和服务集成（例如通过 API key），例如 LLM 提供商、Skills 的第三方服务提供商以及消息渠道。如果您选择这样做，我们将按照您的指示与这些第三方网站、应用和服务共享您的个人信息。个人信息一经传输至该等第三方网站和服务，其处理将受第三方隐私政策约束。我们提供相关服务和网站链接并不代表我们认可该等第三方。" },
    { text: "我们企业集团内的公司，其会基于帮助高效提供服务的合法利益处理您的个人信息。所有此类集团公司只能按照本隐私政策使用您的个人信息。" },
    { text: "监管机构、司法机关和执法机构。在某些情况下，我们可能依法需要披露您的个人信息，例如为遵守法律义务或程序。我们也可能向监管机构、司法机关和执法机构披露个人信息，以确保安全、安保或遵守法律。" },
    { text: "为确保安全、安保或遵守法律而披露给第三方。我们可能披露您的个人信息以：(a) 执行我们的条款和条件及其他协议，包括调查任何潜在违规；(b) 发现、预防或以其他方式处理安全、欺诈或技术问题；或 (c) 根据法律要求或许可，保护我们、用户、第三方或公众的权利、财产或安全。" },
    { text: "专业顾问。我们可能向审计机构、律师事务所或会计师事务所披露您的个人信息，以基于我们的合法利益评估、保护、执行和抗辩我们的权利，并遵守法律和监管义务。" },
    { text: "收购我们或我们业务全部或实质性部分的第三方。如果我们：(a) 出售、转让、合并、整合或重组业务的任何部分，或与任何其他业务合并、收购或组建合资企业，我们可能向任何潜在买方、新所有者或参与该等业务变更的其他第三方披露您的数据；或 (b) 出售或转让任何资产，则我们持有的关于您的个人信息可能作为该等资产的一部分被出售，并可能转让给参与该等出售或转让的任何潜在买方、新所有者或其他第三方。" },
  ],
  retentionTitle: "5. 数据保留",
  retentionIntro: [
    "为执行您的指令并向您提供服务，我们会在自己的服务器上存储相关个人信息，具体如下表所示。",
    "请注意，除非法律要求或允许，我们不会在实现上述相关目的所必需的期限之外保留您的数据。如果我们因遵守适用法律等原因需要在下列期限之后保留您的个人信息，我们会将其与其他类型的个人信息分开存储。",
  ],
  retentionRows: [
    { personal: "登录和账户信息、安全凭证信息\n\n输入和输出", policy: "在您维持账户期间存储，并在账户终止后 30 天内删除；如您请求删除，则在请求后 30 天内删除，以较早者为准。" },
    { personal: "设备信息", policy: "在您维持账户期间存储，并在账户终止后 30 天内删除；如您请求删除，则在请求后 30 天内删除，以较早者为准。用于故障排查的设备信息仅在支持所必需期间保留，并且不超过您停止维持账户后 30 天。" },
    { personal: "配置信息", policy: "在您维持账户期间存储，并在您请求删除后 30 天内删除。" },
    { personal: "诊断和使用数据及日志信息", policy: "最多存储 6 个月。" },
    { personal: "支付信息\n\n账单和用量信息", policy: "账户终止后最多存储 24 个月，用于财务/税务合规。" },
    { personal: "合规记录", policy: "按照适用法律要求保留。" },
    { personal: "沟通信息", policy: "保留至您与我们沟通的问题得到解决。" },
    { personal: "反馈信息", policy: "提交后或账户终止后最多存储 24 个月。" },
  ],
  rightsTitle: "6. 您的权利",
  rightsIntro: "我们向用户提供以下与个人信息有关的权利（您是否享有法定权利取决于您所在地区）。部分权利仅在特定情况下适用；当您请求行使相关权利时，如属于此类情况，我们会告知您。您可以通过访问和更新账户中的个人信息直接行使部分权利；否则，请使用第 7 节（联系我们）中的联系方式联系我们。",
  rightsBullets: [
    "访问。您可能有权访问我们持有的关于您的个人信息、我们如何使用该信息以及与谁共享该信息。",
    "可携带。您可能有权接收我们处理的某些个人信息的副本。",
    "更正。您可能有权更正我们持有的不准确个人信息。",
    "删除。您可以登录服务账户删除账户或移除某些个人信息，或向我们请求删除。",
    "限制处理为仅存储。在某些情况下，您可能有权要求我们停止处理您的个人信息（仅为存储目的处理除外）。",
    "反对。在某些情况下，您可能有权反对我们处理您的个人信息。",
    "撤回同意。在适用法律法规规定的范围内，您可以联系我们撤回此前就某些处理活动提供的同意。如果处理个人信息需要您的同意，而您不同意或撤回同意，我们可能无法提供预期服务。请注意，仅当处理信息的法律基础为同意时，才可行使撤回同意的权利。",
    "您也有权直接向我们以及您生活或工作的国家/地区的相关数据保护机构提出投诉。",
  ],
  contactTitle: "7. 联系我们",
  contactParagraphs: [
    "如您有任何问题，请联系我们。您可以首先通过以下方式联系：",
    "邮箱：lightvela@tencent.com",
    "我们将尽力尽快处理您的请求。这不影响您在认为我们违反数据保护法律时，向您生活或工作所在司法辖区的数据保护机构提出申诉的权利。",
  ],
  thirdPartyTitle: "8. 第三方网站和链接",
  thirdPartyParagraph: "作为服务的一部分，我们可能提供第三方网站、服务和功能的链接或访问入口。您可以选择通过 BYOK 连接您选择的 LLM，连接您偏好的消息渠道，和/或下载并安装 Skills。\n\n如果您访问我们无法控制且与我们无关联的网站或平台，或启用相关功能，您应查阅适用的隐私声明、政策及其他条款。我们不对这些网站或平台的隐私、安全或其中的信息负责。我们提供此类链接或访问入口本身并不代表认可该等平台内容、功能运行或其所有者、运营者。",
  changesTitle: "9. 变更",
  changesParagraph: "如我们对本隐私政策作出任何变更，我们将在此发布更新后的隐私政策，并根据相关法律要求通知您。",
  languageTitle: "10. 语言",
  languageParagraph: "除法律另有规定外，如果本隐私政策的英文版本与本地语言版本存在任何差异或不一致，应以英文版本为准。",
};

const id: PolicyCopy = {
  backHome: "Kembali ke Beranda",
  brand: "LightVela",
  title: "Kebijakan Privasi",
  updated: "Terakhir diperbarui: Agustus 2026",
  intro: [
    "Selamat datang di LightVela. Kebijakan Privasi ini menjelaskan kapan, bagaimana, dan mengapa kami memproses informasi pribadi Anda sehubungan dengan situs web dan layanan LightVela (bersama-sama disebut “Layanan”), serta pilihan dan hak Anda atas informasi tersebut.",
    "Untuk tujuan hukum perlindungan data, pengendali data atas informasi pribadi Anda terkait Layanan adalah Tencent Cloud International Pte. Ltd. (“kami”).",
    "Harap diperhatikan bahwa Kebijakan Privasi ini hanya berlaku untuk Layanan. Jika Anda menggunakan produk atau layanan lain, silakan baca kebijakan privasi untuk produk atau layanan tersebut.",
    "Jika Anda tidak setuju dengan cara pemrosesan informasi pribadi yang dijelaskan dalam Kebijakan Privasi ini, jangan berikan informasi saat diminta dan berhentilah menggunakan Layanan. Dengan menggunakan Layanan, Anda memahami cara kami memproses informasi pribadi sebagaimana dijelaskan dalam Kebijakan Privasi ini. Sepanjang pelaksanaan kontrak atau kepentingan sah tidak dapat dijadikan dasar pemrosesan di yurisdiksi Anda, Anda menyetujui pemrosesan informasi pribadi sebagaimana dijelaskan dalam Kebijakan Privasi ini.",
    "Jika Anda memiliki pertanyaan tentang Kebijakan Privasi ini, atau ingin menggunakan hak yang mungkin Anda miliki, informasi kontak kami tersedia di Bagian 7 (Kontak) di bawah.",
  ],
  sections: [
    {
      title: "1. Anak-anak",
      paragraphs: [
        "Pengguna berusia di bawah 18 tahun tidak diizinkan menggunakan Layanan untuk tujuan apa pun.",
        "Kami tidak meminta atau dengan sengaja mengumpulkan informasi pribadi dari anak di bawah 18 tahun untuk tujuan apa pun. Jika Anda yakin kami memiliki informasi pribadi seseorang yang berusia di bawah 18 tahun, atau jika Anda adalah orang tua atau wali pengguna dan ingin memberi tahu kami bahwa pengguna tersebut belum berusia 18 tahun, silakan hubungi kami sebagaimana dijelaskan di Bagian 7 (Kontak).",
      ],
    },
  ],
  processTitle: "2. Cara Kami Memproses Informasi Pribadi Anda",
  processIntro: [
    "Bagian ini menjelaskan lebih detail jenis informasi pribadi yang kami kumpulkan dari Anda dan alasannya.",
    "Bagian ini juga menjelaskan dasar hukum pemrosesan data sejauh diwajibkan oleh hukum perlindungan data di yurisdiksi Anda. Jika hukum di yurisdiksi Anda tidak mengakui pelaksanaan kontrak atau kepentingan sah sebagai dasar hukum, Anda menyetujui pemrosesan informasi pribadi untuk tujuan tersebut dengan menyetujui Kebijakan Privasi ini.",
  ],
  processRows: [
    {
      category: "Informasi yang Anda berikan kepada kami, baik secara langsung maupun melalui pihak ketiga",
      data: [
        {
          personal: "Informasi login dan akun, serta informasi kredensial keamanan seperti alamat email, nama pengguna/nama panggilan, pengenal login pihak ketiga, alamat IP, oAuth token, session token, status akun, dan ID pengguna.",
          use: "Kami menggunakan informasi ini untuk membuat, mengautentikasi, dan mengelola akun Layanan Anda, serta mengoperasikan dan menyediakan Layanan kepada Anda.",
          basis: "Diperlukan untuk melaksanakan kontrak kami dengan Anda dalam menyediakan Layanan.",
        },
        {
          personal: "Input dan Output: prompt dan instruksi pengguna yang Anda berikan dalam sesi chat, coding, memori, dan agentic, serta respons dan tindakan yang dihasilkan.\n\nSaat menggunakan Kanal Pesan dan AgentChat, kami juga memproses data penerusan pesan, seperti timestamp, pengenal kanal, dan pengenal pengirim.\n\nJika Anda memilih mengintegrasikan aplikasi pihak ketiga, atau mengunggah file dan informasi apa pun, termasuk informasi pribadi, sebagai bagian dari Input, kami akan mengumpulkan informasi tersebut dan informasi itu dapat muncul kembali dalam Output.",
          use: "Kami menggunakan informasi ini untuk memproses Input dan menyediakan Output sesuai instruksi Anda.\n\nKami menggunakan informasi ini untuk meneruskan pesan Anda antara Kanal Pesan, AgentChat, dan Layanan agar kami dapat menyediakan Layanan.\n\nKami juga menggunakan informasi ini untuk menyelidiki dan menyelesaikan masalah keamanan serta melakukan pemeriksaan keamanan guna memastikan tidak ada risiko keamanan.",
          basis: "Diperlukan untuk melaksanakan kontrak kami dengan Anda dalam menyediakan Layanan.\n\nPemrosesan ini juga merupakan kepentingan sah kami untuk melindungi data Anda dan sistem kami.",
        },
        {
          personal: "Informasi pembayaran: jika Anda memilih membeli akses ke Layanan, kami akan memproses informasi pembayaran seperti nomor pesanan pembayaran, nomor seri transaksi pembayaran, jumlah pembayaran, timestamp pembayaran, kanal pembayaran, status pembayaran yang dikembalikan pemroses pembayaran, metadata metode pembayaran, dan empat digit terakhir kartu kredit yang diberikan pemroses pembayaran.\n\nPenyedia pembayaran pihak ketiga kami (misalnya bank penerbit kartu kredit) memproses data terkait atas nama kami.",
          use: "Kami menggunakan informasi ini untuk mengelola penagihan dan pembayaran Layanan.",
          basis: "Diperlukan untuk melaksanakan kontrak kami dengan Anda dalam menyediakan Layanan.",
        },
        {
          personal: "Informasi komunikasi: jika Anda berkomunikasi dengan kami atau kami memberikan pengumuman, kami memproses informasi seperti nama, informasi kontak, dan isi komunikasi yang Anda kirim.",
          use: "Kami menggunakan informasi ini untuk berkomunikasi dengan Anda mengenai masalah yang Anda sampaikan.\n\nKami dari waktu ke waktu dapat mengirim pengumuman saat kami menganggapnya perlu, misalnya ketika akses ke Layanan sementara ditangguhkan untuk pemeliharaan, keamanan, privasi, atau komunikasi administratif. Pengumuman ini bersifat penting terkait sistem dan layanan, bukan promosi, dan Anda tidak dapat berhenti menerimanya.",
          basis: "Diperlukan untuk melaksanakan kontrak kami dengan Anda dalam menyediakan Layanan.",
        },
        {
          personal: "Informasi masukan: jika Anda memilih memberikan masukan dan saran perbaikan, atau memberi rating pada Output melalui aplikasi atau server Discord kami, kami akan menyimpan percakapan terkait sebagai bagian dari masukan Anda.",
          use: "Kami menggunakan informasi ini untuk menyelesaikan masalah yang mungkin Anda hadapi, melakukan debug dan perbaikan, meningkatkan Layanan, dan melakukan riset.",
          basis: "Kami memproses informasi ini berdasarkan persetujuan Anda.\n\nPemrosesan ini juga merupakan kepentingan sah kami untuk menjaga fungsi Layanan, mendiagnosis error, serta lebih lanjut meningkatkan dan mengembangkan Layanan.",
        },
      ],
    },
    {
      category: "Informasi yang dihasilkan sebagai bagian dari Layanan",
      data: [
        {
          personal: "Informasi perangkat seperti pengenal perangkat, jenis, model, informasi sistem operasi, alamat IP, informasi jaringan dan koneksi, informasi sesi remote control, dan informasi plugin.",
          use: "Kami menggunakan informasi ini untuk:\n• menyediakan Layanan kepada Anda;\n• membuat dan mengelola akun Anda;\n• menyediakan dan memelihara layanan serta fitur opsional yang meningkatkan fungsi Layanan dan pengalaman Anda; dan\n• mendeteksi serta mengidentifikasi error dan bug, serta melakukan troubleshooting.",
          basis: "Diperlukan untuk melaksanakan kontrak kami dengan Anda. Pemrosesan ini juga merupakan kepentingan sah kami untuk menjaga fungsi Layanan dan mendiagnosis error.",
        },
        {
          personal: "Informasi konfigurasi: kami memproses informasi tentang cara komponen hardware, software, dan jaringan beroperasi dan saling berinteraksi, seperti informasi konfigurasi sistem dan infrastruktur, serta data dan metadata otorisasi dan konfigurasi Kanal Pesan.",
          use: "Kami menggunakan informasi ini untuk mempertahankan pengaturan konfigurasi Layanan Anda dan menyediakan Layanan kepada Anda.",
          basis: "Diperlukan untuk melaksanakan kontrak kami dengan Anda dalam menyediakan Layanan.",
        },
        {
          personal: "Informasi diagnostik dan penggunaan, serta informasi log: kami memproses informasi tentang penggunaan Layanan oleh Anda, seperti tanggal dan waktu login, akses, dan pencarian, alamat IP, informasi lingkungan runtime, informasi jaringan dan keamanan, log deployment dan error, metrik serta kode aplikasi dan performa, integrasi, dan informasi lain tentang cara Anda menggunakan Layanan.",
          use: "Kami menggunakan informasi ini untuk:\n• menyediakan Layanan kepada Anda;\n• memantau performa dan kualitas Layanan;\n• mendeteksi serta mengidentifikasi error dan bug, serta melakukan troubleshooting; dan\n• meningkatkan, mengoptimalkan, dan mengembangkan Layanan.",
          basis: "Pemrosesan ini merupakan kepentingan sah kami untuk memantau performa sistem, mendiagnosis error, dan meningkatkan produk.",
        },
        {
          personal: "Informasi penagihan dan konsumsi: kami memproses informasi terkait penagihan, seperti nama pemegang kartu dan informasi kontak, jumlah transaksi dan timestamp, nomor pesanan, serta layanan dan fitur yang dibeli.",
          use: "Kami menggunakan informasi ini untuk mengelola penagihan dan pembayaran Layanan.",
          basis: "Diperlukan untuk melaksanakan kontrak kami dengan Anda dalam menyediakan Layanan.",
        },
        {
          personal: "Catatan kepatuhan: catatan persetujuan dan penarikan persetujuan, catatan permintaan penghapusan dan ekspor data, serta informasi pribadi lain yang wajib disimpan atau diungkapkan berdasarkan hukum, peraturan, perintah pengadilan, atau permintaan pemerintah yang berlaku.",
          use: "Kami menggunakan informasi ini untuk mematuhi kewajiban hukum yang berlaku, merespons permintaan regulator, dan memenuhi hak subjek data.",
          basis: "Kami memproses informasi ini untuk memenuhi kewajiban hukum kami.",
        },
        {
          personal: "Informasi lain yang kami miliki tentang Anda, seperti pengenal perangkat, informasi perangkat, alamat IP, informasi penggunaan Layanan, Input dan Output, serta data plugin.",
          use: "Kami menggunakan informasi ini untuk memastikan keamanan layanan kami, termasuk dengan mengagregasi dan menganonimkan informasi untuk tujuan tersebut.",
          basis: "Pemrosesan ini merupakan kepentingan sah kami untuk memastikan keamanan Layanan atau layanan kami.",
          useRows: [
            {
              use: "Kami menggunakan informasi ini untuk memastikan keamanan layanan kami, termasuk dengan mengagregasi dan menganonimkan informasi untuk tujuan tersebut.",
              basis: "Pemrosesan ini merupakan kepentingan sah kami untuk memastikan keamanan Layanan atau layanan kami.",
            },
            {
              use: "Kami menggunakan informasi ini untuk meningkatkan layanan kami, termasuk dengan mengagregasi dan menganonimkan informasi untuk tujuan tersebut.",
              basis: "Pemrosesan ini merupakan kepentingan sah kami untuk meningkatkan Layanan atau layanan kami.",
            },
          ],
        },
      ],
    },
  ],
  shareTitle: "3. Cara Kami Menyimpan dan Membagikan Informasi Pribadi Anda",
  shareParagraphs: [
    "Informasi pribadi Anda akan disimpan di server di Singapura. Kami juga memiliki tim dukungan, engineering, dan tim lain secara global yang mendukung Layanan, termasuk dari Singapura dan Republik Rakyat Tiongkok.",
    "Kami akan mentransfer data ke luar yurisdiksi tempat Anda berada untuk tujuan yang dijelaskan dalam Kebijakan Privasi ini. Saat melakukannya, kami akan mengambil langkah untuk memastikan informasi pribadi Anda terlindungi dan menerapkan perlindungan yang diperlukan, termasuk klausul kontraktual standar, keputusan kecukupan perlindungan jika tersedia, perjanjian pemrosesan data dengan pemroses data pihak ketiga, dan perlindungan kontraktual lainnya. Anda dapat menghubungi kami melalui informasi di Bagian 7 (Kontak) untuk meminta salinan perlindungan tersebut.",
    "Kami akan membagikan informasi pribadi Anda kepada pihak ketiga dalam situasi berikut:",
  ],
  shareBullets: [
    {
      text: "Pihak ketiga yang menyediakan layanan untuk mendukung Layanan, termasuk penyedia layanan yang memproses informasi pribadi yang disebutkan dalam kebijakan ini berdasarkan kepentingan sah kami untuk menyediakan Layanan secara efisien. Misalnya, kami akan mentransfer informasi pribadi Anda kepada:",
      children: [
        "pemroses pembayaran yang memproses data instruksi pembayaran untuk pembayaran Layanan.",
      ],
    },
    { text: "Situs web dan layanan pihak ketiga: Anda dapat memilih mengintegrasikan Layanan dengan berbagai situs web, aplikasi, dan layanan pihak ketiga, misalnya melalui API key, seperti penyedia LLM, penyedia layanan pihak ketiga untuk Skills, dan Kanal Pesan. Jika Anda memilih melakukannya, kami akan membagikan informasi pribadi Anda kepada situs web, aplikasi, dan layanan pihak ketiga tersebut sesuai instruksi Anda. Setelah ditransfer, pemrosesan oleh pihak ketiga tersebut tunduk pada kebijakan privasi pihak ketiga tersebut. Tautan ke layanan atau situs tersebut tidak berarti kami mendukung pihak ketiga tersebut." },
    { text: "Perusahaan dalam grup korporasi kami yang memproses informasi pribadi Anda berdasarkan kepentingan sah kami untuk membantu menyediakan Layanan secara efisien. Semua perusahaan grup tersebut hanya dapat menggunakan informasi pribadi Anda sesuai Kebijakan Privasi ini." },
    { text: "Regulator, otoritas peradilan, dan lembaga penegak hukum. Dalam keadaan tertentu, kami mungkin diwajibkan secara hukum untuk mengungkapkan informasi pribadi tentang Anda, misalnya untuk mematuhi kewajiban atau proses hukum. Kami juga dapat mengungkapkan informasi pribadi kepada regulator, otoritas peradilan, dan lembaga penegak hukum untuk memastikan keselamatan, keamanan, atau kepatuhan terhadap hukum." },
    { text: "Pihak ketiga untuk memastikan keselamatan, keamanan, atau kepatuhan terhadap hukum. Kami dapat mengungkapkan informasi pribadi Anda untuk: (a) menegakkan syarat dan ketentuan serta perjanjian lain, termasuk menyelidiki potensi pelanggaran; (b) mendeteksi, mencegah, atau menangani masalah keamanan, penipuan, atau teknis; atau (c) melindungi hak, properti, atau keselamatan kami, pengguna kami, pihak ketiga, atau publik sebagaimana diwajibkan atau diizinkan oleh hukum." },
    { text: "Penasihat profesional. Kami dapat mengungkapkan informasi pribadi Anda kepada auditor, firma hukum, atau firma akuntansi berdasarkan kepentingan sah kami untuk menilai, melindungi, menegakkan, dan membela hak kami serta mematuhi kewajiban hukum dan regulasi." },
    { text: "Pihak ketiga yang mengakuisisi seluruh atau sebagian besar kami atau bisnis kami. Kami juga dapat mengungkapkan informasi pribadi Anda kepada pihak ketiga jika kami: (a) menjual, mentransfer, menggabungkan, mengonsolidasikan, atau mereorganisasi bagian mana pun dari bisnis kami, atau bergabung dengan, mengakuisisi, atau membentuk usaha patungan dengan bisnis lain; atau (b) menjual atau mentransfer aset kami, sehingga informasi pribadi yang kami miliki tentang Anda dapat dijual sebagai bagian dari aset tersebut dan ditransfer kepada calon pembeli, pemilik baru, atau pihak ketiga lain yang terlibat dalam penjualan atau transfer tersebut." },
  ],
  retentionTitle: "5. Retensi Data",
  retentionIntro: [
    "Untuk menjalankan instruksi Anda dan menyediakan Layanan, kami akan menyimpan informasi pribadi yang relevan di server kami sendiri, sebagaimana dijelaskan pada tabel di bawah.",
    "Harap diperhatikan bahwa kami tidak menyimpan data Anda lebih lama dari yang diperlukan untuk memenuhi tujuan terkait yang dijelaskan di atas, kecuali diwajibkan atau diizinkan oleh hukum. Jika kami menyimpan informasi pribadi Anda melewati periode retensi di bawah, misalnya untuk mematuhi hukum yang berlaku, kami akan menyimpannya secara terpisah dari jenis informasi pribadi lainnya.",
  ],
  retentionRows: [
    { personal: "Informasi login dan akun, informasi kredensial keamanan\n\nInput dan Output", policy: "Disimpan selama Anda memiliki akun dengan kami dan dihapus dalam 30 hari setelahnya, atau dalam 30 hari sejak permintaan penghapusan Anda, mana yang lebih dahulu." },
    { personal: "Informasi perangkat", policy: "Disimpan selama Anda memiliki akun dengan kami dan dihapus dalam 30 hari setelah penghentian akun, atau dalam 30 hari sejak permintaan penghapusan Anda, mana yang lebih dahulu. Informasi perangkat untuk troubleshooting hanya disimpan selama diperlukan untuk dukungan dan tidak lebih dari 30 hari setelah Anda berhenti memiliki akun dengan kami." },
    { personal: "Informasi konfigurasi", policy: "Disimpan selama Anda memiliki akun dengan kami dan dihapus dalam 30 hari setelah permintaan penghapusan Anda." },
    { personal: "Data diagnostik dan penggunaan, serta informasi log", policy: "Disimpan hingga 6 bulan." },
    { personal: "Informasi pembayaran\n\nInformasi penagihan dan konsumsi", policy: "Disimpan hingga 24 bulan setelah penghentian akun Anda untuk kepatuhan keuangan/pajak." },
    { personal: "Catatan kepatuhan", policy: "Sesuai yang diwajibkan oleh hukum yang berlaku." },
    { personal: "Informasi komunikasi", policy: "Sampai masalah yang Anda komunikasikan kepada kami selesai ditangani." },
    { personal: "Informasi masukan", policy: "Disimpan hingga 24 bulan setelah pengiriman atau penghentian akun." },
  ],
  rightsTitle: "6. Hak Anda",
  rightsIntro: "Kami menyediakan hak berikut bagi pengguna terkait informasi pribadi Anda, yang mungkin dapat Anda gunakan secara hukum tergantung lokasi Anda. Beberapa hak hanya berlaku dalam keadaan tertentu, dan kami akan memberi tahu Anda jika demikian saat Anda meminta pelaksanaan hak tersebut. Anda dapat menggunakan sebagian hak secara langsung dengan mengakses dan memperbarui informasi pribadi di akun Anda. Untuk hak lainnya, silakan hubungi kami menggunakan informasi di Bagian 7 (Kontak) di bawah.",
  rightsBullets: [
    "Akses. Anda mungkin berhak mengakses informasi pribadi yang kami miliki tentang Anda, cara kami menggunakannya, dan kepada siapa kami membagikannya.",
    "Portabilitas. Anda mungkin berhak menerima salinan informasi pribadi tertentu yang kami proses tentang Anda.",
    "Koreksi. Anda mungkin berhak mengoreksi informasi pribadi yang kami miliki jika tidak akurat.",
    "Penghapusan. Anda dapat menghapus akun atau menghapus informasi pribadi tertentu dengan masuk ke akun Anda atau meminta penghapusan kepada kami.",
    "Pembatasan Pemrosesan Menjadi Penyimpanan Saja. Dalam keadaan tertentu, Anda mungkin berhak meminta kami berhenti memproses informasi pribadi selain untuk tujuan penyimpanan.",
    "Keberatan. Anda mungkin berhak menolak pemrosesan informasi pribadi Anda dalam situasi tertentu.",
    "Penarikan Persetujuan. Sepanjang diatur oleh hukum dan peraturan yang berlaku, Anda dapat menarik persetujuan yang sebelumnya Anda berikan kepada kami untuk aktivitas pemrosesan tertentu dengan menghubungi kami. Jika persetujuan diperlukan untuk memproses informasi pribadi Anda, dan Anda tidak memberikan atau menarik persetujuan tersebut, kami mungkin tidak dapat menyediakan layanan yang diharapkan. Harap diperhatikan bahwa hak untuk menarik persetujuan hanya tersedia jika dasar hukum pemrosesan informasi adalah persetujuan.",
    "Anda juga berhak mengajukan keluhan langsung kepada kami, serta kepada otoritas perlindungan data terkait di negara tempat Anda tinggal atau bekerja.",
  ],
  contactTitle: "7. Kontak",
  contactParagraphs: [
    "Silakan hubungi kami jika Anda memiliki pertanyaan. Untuk langkah pertama, Anda dapat menghubungi kami melalui:",
    "Email: lightvela@tencent.com",
    "Kami akan berupaya menangani permintaan Anda sesegera mungkin. Hal ini tidak mengurangi hak apa pun yang mungkin Anda miliki untuk mengajukan klaim kepada otoritas perlindungan data di yurisdiksi tempat Anda tinggal atau bekerja jika Anda merasa kami melanggar hukum perlindungan data.",
  ],
  thirdPartyTitle: "8. Situs Web dan Tautan Pihak Ketiga",
  thirdPartyParagraph: "Kami dapat menyediakan tautan atau akses ke situs web, layanan, dan fitur pihak ketiga sebagai bagian dari Layanan. Anda dapat memilih untuk terhubung ke LLM pilihan Anda melalui BYOK, menghubungkan Kanal Pesan pilihan Anda, dan/atau mengunduh serta menginstal Skills.\n\nJika Anda mengikuti tautan ke situs atau platform, atau mengaktifkan fitur yang tidak kami kontrol dan tidak berafiliasi dengan kami, Anda perlu meninjau pemberitahuan privasi, kebijakan, dan ketentuan lain yang berlaku. Kami tidak bertanggung jawab atas privasi, keamanan, atau informasi yang terdapat di situs atau platform tersebut. Penyertaan tautan atau akses ke fitur tersebut, dengan sendirinya, tidak menyiratkan dukungan atas konten di platform tersebut, pengoperasian fitur tersebut, atau pemilik maupun operatornya.",
  changesTitle: "9. Perubahan",
  changesParagraph: "Jika kami melakukan perubahan pada Kebijakan Privasi ini, kami akan memposting Kebijakan Privasi yang diperbarui di sini dan memberi tahu Anda sesuai persyaratan hukum yang relevan.",
  languageTitle: "10. Bahasa",
  languageParagraph: "Kecuali ditentukan lain oleh hukum, jika terdapat perbedaan atau ketidaksesuaian antara versi bahasa Inggris dan versi bahasa lokal dari Kebijakan Privasi ini, versi bahasa Inggris yang akan berlaku.",
};

const es: PolicyCopy = {
  backHome: "Volver al inicio",
  brand: "LightVela",
  title: "Política de privacidad",
  updated: "Última actualización: agosto de 2026",
  intro: [
    "¡Le damos la bienvenida a LightVela! Esta Política de privacidad explica cuándo, cómo y por qué tratamos su información personal en relación con el sitio web y el servicio de LightVela (conjuntamente, el “Servicio”), así como las opciones y los derechos que le corresponden respecto de dicha información.",
    "A efectos de la legislación sobre protección de datos, el responsable del tratamiento de su información personal en relación con el Servicio es Tencent Cloud International Pte. Ltd. (“nosotros”, “nos” o “nuestro”).",
    "Tenga en cuenta que esta Política de privacidad solo se aplica al Servicio. Si utiliza otros productos o servicios, consulte la política de privacidad correspondiente a esos productos o servicios.",
    "Si no está de acuerdo con el tratamiento de su información personal descrito en esta Política de privacidad, no facilite su información cuando se le solicite y deje de utilizar el Servicio. Al utilizar el Servicio, reconoce que tratamos su información personal conforme a esta Política de privacidad y, cuando en su jurisdicción no podamos basar dicho tratamiento en la ejecución de un contrato o en un interés legítimo, presta su consentimiento al tratamiento descrito en esta Política de privacidad.",
    "Si tiene alguna pregunta sobre esta Política de privacidad o desea ejercer alguno de sus derechos, encontrará nuestros datos de contacto en la Sección 7 (Contacto).",
  ],
  sections: [
    {
      title: "1. Menores",
      paragraphs: [
        "Las personas menores de 18 años no pueden utilizar el Servicio con ningún fin.",
        "No solicitamos ni recopilamos deliberadamente información personal de menores de 18 años con ningún fin. Si considera que disponemos de información personal de una persona menor de 18 años, o si es el padre, la madre o el tutor legal de un usuario y desea informarnos de que este es menor de 18 años, póngase en contacto con nosotros según se indica en la Sección 7 (Contacto).",
      ],
    },
  ],
  processTitle: "2. Cómo tratamos su información personal",
  processIntro: [
    "Esta sección ofrece información más detallada sobre los tipos de información personal que recopilamos y los motivos por los que lo hacemos.",
    "También identifica la base jurídica en la que nos apoyamos para tratar sus datos, en la medida exigida por la legislación sobre protección de datos de su jurisdicción. Si la legislación de su jurisdicción no reconoce la ejecución de un contrato o el interés legítimo como base jurídica, al aceptar esta Política de privacidad usted consiente el tratamiento de su información personal para el fin correspondiente.",
  ],
  processRows: [
    {
      category: "Información que nos proporciona, directamente o a través de un tercero",
      data: [
        {
          personal: "Información de inicio de sesión y de la cuenta, e información de credenciales de seguridad, como su dirección de correo electrónico, nombre de usuario o alias, identificadores de inicio de sesión de terceros, dirección IP, token de OAuth, token de sesión, estado de la cuenta e identificadores de usuario.",
          use: "Utilizamos esta información para crear, autenticar y administrar su cuenta del Servicio, así como para operar y prestarle el Servicio.",
          basis: "Es necesaria para ejecutar el contrato que hemos celebrado con usted y prestarle el Servicio.",
        },
        {
          personal: "Entradas y salidas: las instrucciones y solicitudes que facilita en sus sesiones de chat, programación, memoria y agente, así como las respuestas y acciones generadas.\n\nCuando utiliza Canales de mensajería y AgentChat, también tratamos datos de transmisión de mensajes, como marcas de tiempo, identificadores de canal e identificadores del remitente.\n\nSi decide integrar aplicaciones de terceros o cargar archivos e información, incluida información personal, como parte de sus Entradas, recopilaremos dicha información y esta podrá reproducirse en las Salidas.",
          use: "Utilizamos esta información para procesar sus Entradas y ofrecerle Salidas de acuerdo con sus instrucciones.\n\nUtilizamos esta información para transmitir sus mensajes entre los Canales de mensajería, AgentChat y el Servicio con el fin de prestarle el Servicio.\n\nTambién utilizamos esta información para investigar y resolver problemas de seguridad y realizar comprobaciones destinadas a garantizar que no existan riesgos de seguridad.",
          basis: "Es necesaria para ejecutar el contrato que hemos celebrado con usted y prestarle el Servicio.\n\nTambién responde a nuestro interés legítimo en proteger sus datos y nuestros sistemas.",
        },
        {
          personal: "Información de pago: si decide adquirir acceso al Servicio, trataremos información de pago como el número de pedido, el número de serie de la transacción, el importe y la marca de tiempo del pago, el canal y el estado del pago comunicado por el procesador, los metadatos del método de pago y los cuatro últimos dígitos de la tarjeta de crédito facilitados por el procesador.\n\nNuestros proveedores de pago externos, como los bancos emisores de tarjetas, tratan los datos correspondientes en nuestro nombre.",
          use: "Utilizamos esta información para administrar la facturación y los pagos del Servicio.",
          basis: "Es necesaria para ejecutar el contrato que hemos celebrado con usted y prestarle el Servicio.",
        },
        {
          personal: "Información de comunicaciones: si se comunica con nosotros o le enviamos avisos, tratamos información como su nombre, sus datos de contacto y el contenido de las comunicaciones que nos remita.",
          use: "Utilizamos esta información para comunicarnos con usted acerca de las cuestiones que plantee.\n\nPodremos enviarle avisos cuando lo consideremos necesario, por ejemplo, cuando suspendamos temporalmente el acceso al Servicio por mantenimiento o para comunicaciones relacionadas con la seguridad, la privacidad o la administración. Estos avisos esenciales del sistema y del Servicio no tienen carácter promocional y no es posible darse de baja de ellos.",
          basis: "Es necesaria para ejecutar el contrato que hemos celebrado con usted y prestarle el Servicio.",
        },
        {
          personal: "Información de comentarios: si decide enviarnos comentarios, sugerencias de mejora o valoraciones de una Salida mediante la aplicación o nuestro servidor de Discord, almacenaremos la conversación correspondiente como parte de sus comentarios.",
          use: "Utilizamos esta información para resolver los problemas que pueda experimentar, depurar y corregir incidencias, mejorar el Servicio y realizar investigaciones.",
          basis: "Tratamos esta información con su consentimiento.\n\nTambién responde a nuestro interés legítimo en mantener el funcionamiento del Servicio, diagnosticar errores y seguir mejorándolo y desarrollándolo.",
        },
      ],
    },
    {
      category: "Información generada como parte del Servicio",
      data: [
        {
          personal: "Información del dispositivo, como identificadores, tipo y modelo del dispositivo, información del sistema operativo, direcciones IP, información de red y conexión, información de sesiones de control remoto e información de complementos.",
          use: "Utilizamos esta información para:\n• prestarle el Servicio;\n• crear y administrar su cuenta;\n• ofrecer y mantener servicios y funciones opcionales que mejoran la funcionalidad del Servicio y su experiencia; y\n• detectar e identificar errores y fallos, y solucionarlos.",
          basis: "Es necesaria para ejecutar el contrato que hemos celebrado con usted. También responde a nuestro interés legítimo en mantener el funcionamiento del Servicio y diagnosticar errores.",
        },
        {
          personal: "Información de configuración: tratamos información sobre el funcionamiento y la interacción de los componentes de hardware, software y red, como la configuración del sistema y de la infraestructura, así como los datos y metadatos de autorización y configuración de los Canales de mensajería.",
          use: "Utilizamos esta información para conservar sus ajustes de configuración y prestarle el Servicio.",
          basis: "Es necesaria para ejecutar el contrato que hemos celebrado con usted y prestarle el Servicio.",
        },
        {
          personal: "Información de diagnóstico y uso, e información de registros: tratamos información sobre su uso del Servicio, como las fechas y horas de inicio de sesión, acceso y búsqueda, la dirección IP, la información del entorno de ejecución, la información de red y seguridad, los registros de despliegue y errores, las métricas y códigos de aplicaciones y rendimiento, las integraciones y otra información sobre cómo utiliza el Servicio.",
          use: "Utilizamos esta información para:\n• prestarle el Servicio;\n• supervisar el rendimiento y la calidad del Servicio;\n• detectar e identificar errores y fallos, y solucionarlos; y\n• mejorar, optimizar y desarrollar el Servicio.",
          basis: "Responde a nuestro interés legítimo en supervisar el rendimiento del sistema, diagnosticar errores y mejorar el producto.",
        },
        {
          personal: "Información de facturación y consumo: tratamos información relacionada con la facturación, como el nombre y los datos de contacto del titular de la tarjeta, los importes y marcas de tiempo de las transacciones, los números de pedido y los servicios y funciones adquiridos.",
          use: "Utilizamos esta información para administrar la facturación y los pagos del Servicio.",
          basis: "Es necesaria para ejecutar el contrato que hemos celebrado con usted y prestarle el Servicio.",
        },
        {
          personal: "Registros de cumplimiento: registros de consentimiento y retirada del consentimiento, registros de solicitudes de eliminación y exportación de datos y cualquier otra información personal que deba conservarse o divulgarse conforme a las leyes, reglamentos, resoluciones judiciales o solicitudes gubernamentales aplicables.",
          use: "Utilizamos esta información para cumplir nuestras obligaciones legales, responder a solicitudes de las autoridades y atender los derechos de los interesados.",
          basis: "Tratamos esta información para cumplir nuestras obligaciones legales.",
        },
        {
          personal: "Otra información de la que disponemos sobre usted, como identificadores e información del dispositivo, dirección IP, información sobre el uso del Servicio, Entradas y Salidas y datos de complementos.",
          use: "Utilizamos esta información para garantizar la seguridad de nuestros servicios, incluida su agregación y anonimización con ese fin.",
          basis: "Responde a nuestro interés legítimo en garantizar la seguridad del Servicio o de nuestros servicios.",
          useRows: [
            {
              use: "Utilizamos esta información para garantizar la seguridad de nuestros servicios, incluida su agregación y anonimización con ese fin.",
              basis: "Responde a nuestro interés legítimo en garantizar la seguridad del Servicio o de nuestros servicios.",
            },
            {
              use: "Utilizamos esta información para mejorar nuestros servicios, incluida su agregación y anonimización con ese fin.",
              basis: "Responde a nuestro interés legítimo en mejorar el Servicio o nuestros servicios.",
            },
          ],
        },
      ],
    },
  ],
  shareTitle: "3. Cómo almacenamos y compartimos su información personal",
  shareParagraphs: [
    "Su información personal se almacenará en servidores ubicados en Singapur. También contamos con equipos globales de soporte, ingeniería y otras funciones que prestan apoyo al Servicio, incluidos equipos situados en Singapur y la República Popular China.",
    "Transferiremos datos fuera de la jurisdicción en la que se encuentre para los fines descritos en esta Política de privacidad. Cuando lo hagamos, adoptaremos medidas para garantizar la protección de su información personal y aplicaremos las salvaguardias exigidas, entre ellas cláusulas contractuales tipo, decisiones de adecuación cuando estén disponibles, acuerdos de tratamiento de datos con todos los encargados externos y otras garantías contractuales. Puede ponerse en contacto con nosotros mediante los datos de la Sección 7 (Contacto) para solicitar una copia de estas salvaguardias.",
    "Compartiremos su información personal con terceros en las siguientes situaciones:",
  ],
  shareBullets: [
    {
      text: "Terceros que prestan servicios de apoyo al Servicio, incluidos proveedores que tratan la información personal identificada en esta política conforme a nuestro interés legítimo en prestar el Servicio de forma eficiente. Por ejemplo, transferiremos su información personal a:",
      children: [
        "procesadores de pagos que tratan los datos de instrucciones de pago correspondientes al Servicio.",
      ],
    },
    { text: "Sitios web y servicios de terceros: puede decidir integrar el Servicio con distintos sitios web, aplicaciones y servicios de terceros, por ejemplo mediante claves API, como proveedores de LLM, proveedores externos de Skills y Canales de mensajería. Si decide hacerlo, compartiremos su información personal con dichos terceros de acuerdo con sus instrucciones. Una vez transferida, la información quedará sujeta a la política de privacidad del tercero. La inclusión de enlaces a esos servicios o sitios no implica que respaldemos al tercero." },
    { text: "Empresas de nuestro grupo corporativo que tratan su información personal conforme a nuestro interés legítimo en prestar el Servicio de forma eficiente. Estas empresas solo podrán utilizar su información personal de acuerdo con esta Política de privacidad." },
    { text: "Organismos reguladores, autoridades judiciales y fuerzas del orden. En determinadas circunstancias podremos estar legalmente obligados a divulgar información personal sobre usted, por ejemplo, para cumplir obligaciones o procedimientos legales. También podremos divulgarla a dichas autoridades para garantizar la protección, la seguridad o el cumplimiento de la ley." },
    { text: "Terceros para garantizar la protección, la seguridad o el cumplimiento de la ley. Podremos divulgar su información personal para: (a) hacer cumplir nuestros términos y condiciones y otros acuerdos, incluida la investigación de posibles infracciones; (b) detectar, prevenir o abordar problemas de seguridad, fraude o técnicos; o (c) proteger nuestros derechos, bienes o seguridad, los de nuestros usuarios, los de terceros o los del público, según lo exija o permita la ley." },
    { text: "Asesores profesionales. Podremos divulgar su información personal a auditores, despachos de abogados o firmas de contabilidad conforme a nuestro interés legítimo en evaluar, proteger, ejercer y defender nuestros derechos y cumplir nuestras obligaciones legales y reglamentarias." },
    { text: "Un tercero que adquiera la totalidad o una parte sustancial de nosotros o de nuestro negocio. También podremos divulgar su información personal si: (a) vendemos, transferimos, fusionamos, consolidamos o reorganizamos alguna parte de nuestro negocio, o si nos fusionamos con otra empresa, la adquirimos o constituimos una empresa conjunta con ella; o (b) vendemos o transferimos alguno de nuestros activos, en cuyo caso la información personal que conservamos sobre usted podrá formar parte de esos activos y transferirse a un posible comprador, nuevo propietario u otro tercero participante en la operación." },
  ],
  retentionTitle: "5. Conservación de datos",
  retentionIntro: [
    "Para ejecutar sus instrucciones y prestarle el Servicio, almacenaremos la información personal pertinente en nuestros propios servidores, según se indica en la tabla siguiente.",
    "No conservamos sus datos durante más tiempo del necesario para cumplir los fines descritos, salvo que la ley nos obligue o autorice a hacerlo. Si conservamos su información personal más allá de los periodos indicados, por ejemplo, para cumplir la legislación aplicable, la almacenaremos separada de otros tipos de información personal.",
  ],
  retentionRows: [
    { personal: "Información de inicio de sesión y de la cuenta, e información de credenciales de seguridad\n\nEntradas y Salidas", policy: "Se conserva mientras mantenga una cuenta con nosotros y se elimina en los 30 días posteriores, o en los 30 días siguientes a su solicitud de eliminación, lo que ocurra primero." },
    { personal: "Información del dispositivo", policy: "Se conserva mientras mantenga una cuenta con nosotros y se elimina en los 30 días posteriores a la cancelación de la cuenta, o en los 30 días siguientes a su solicitud de eliminación, lo que ocurra primero. La información del dispositivo utilizada para solucionar problemas se conserva únicamente durante el tiempo necesario para prestar asistencia y nunca más de 30 días después de que deje de mantener una cuenta con nosotros." },
    { personal: "Información de configuración", policy: "Se conserva mientras mantenga una cuenta con nosotros y se elimina en los 30 días siguientes a su solicitud de eliminación." },
    { personal: "Datos de diagnóstico y uso, e información de registros", policy: "Se conservan durante un máximo de 6 meses." },
    { personal: "Información de pago\n\nInformación de facturación y consumo", policy: "Se conserva durante un máximo de 24 meses tras la cancelación de su cuenta para cumplir obligaciones financieras y fiscales." },
    { personal: "Registros de cumplimiento", policy: "Durante el tiempo exigido por la legislación aplicable." },
    { personal: "Información de comunicaciones", policy: "Hasta que se resuelva la cuestión sobre la que se haya comunicado con nosotros." },
    { personal: "Información de comentarios", policy: "Se conserva durante un máximo de 24 meses tras su envío o la cancelación de la cuenta." },
  ],
  rightsTitle: "6. Sus derechos",
  rightsIntro: "Ofrecemos a nuestros usuarios los siguientes derechos respecto de su información personal, que podrán ejercer legalmente en función del lugar donde se encuentren. Algunos derechos solo se aplican en determinadas circunstancias; se lo indicaremos cuando solicite ejercerlos. Puede ejercer algunos directamente accediendo a la información personal de su cuenta y actualizándola. Para los demás, póngase en contacto con nosotros mediante los datos de la Sección 7 (Contacto).",
  rightsBullets: [
    "Acceso. Puede tener derecho a acceder a la información personal que conservamos sobre usted, saber cómo la utilizamos y con quién la compartimos.",
    "Portabilidad. Puede tener derecho a recibir una copia de determinada información personal que tratamos sobre usted.",
    "Rectificación. Puede tener derecho a corregir la información personal inexacta que conservemos sobre usted.",
    "Supresión. Puede eliminar su cuenta o determinada información personal iniciando sesión en su cuenta o solicitándonos su supresión.",
    "Limitación del tratamiento al almacenamiento. En determinadas circunstancias, puede tener derecho a exigir que dejemos de tratar su información personal salvo para su almacenamiento.",
    "Oposición. Puede tener derecho a oponerse al tratamiento de su información personal en determinadas situaciones.",
    "Retirada del consentimiento. En la medida prevista por la legislación aplicable, puede retirar el consentimiento que nos haya otorgado para determinadas actividades de tratamiento poniéndose en contacto con nosotros. Cuando el consentimiento sea necesario y usted no lo otorgue o lo retire, es posible que no podamos prestarle el servicio esperado. El derecho a retirar el consentimiento solo está disponible cuando el tratamiento se basa jurídicamente en el consentimiento.",
    "También tiene derecho a presentar una reclamación directamente ante nosotros y ante la autoridad de protección de datos competente del país donde viva o trabaje.",
  ],
  contactTitle: "7. Contacto",
  contactParagraphs: [
    "Póngase en contacto con nosotros si tiene alguna pregunta. En primera instancia puede escribirnos a:",
    "Correo electrónico: lightvela@tencent.com",
    "Procuraremos atender su solicitud lo antes posible. Esto no limita ningún derecho que pueda tener a presentar una reclamación ante la autoridad de protección de datos de la jurisdicción donde viva o trabaje si considera que hemos infringido la legislación de protección de datos.",
  ],
  thirdPartyTitle: "8. Sitios web y enlaces de terceros",
  thirdPartyParagraph: "Podemos ofrecer enlaces o acceso a sitios web, servicios y funciones de terceros como parte del Servicio. Puede decidir conectarse al LLM que elija mediante BYOK, conectar sus Canales de mensajería preferidos y descargar e instalar Skills.\n\nSi sigue enlaces a sitios o plataformas, o activa funciones que no controlamos ni están afiliadas a nosotros, debe consultar los avisos de privacidad, políticas y demás términos aplicables. No somos responsables de la privacidad, la seguridad ni la información de esos sitios o plataformas. La inclusión de enlaces o el acceso a dichas funciones no implica por sí misma que respaldemos el contenido de esas plataformas, el funcionamiento de las funciones ni a sus propietarios u operadores.",
  changesTitle: "9. Cambios",
  changesParagraph: "Si modificamos esta Política de privacidad, publicaremos aquí la versión actualizada y se lo notificaremos de acuerdo con los requisitos legales aplicables.",
  languageTitle: "10. Idioma",
  languageParagraph: "En caso de discrepancia o incoherencia entre la versión en inglés y esta traducción al español, prevalecerá la versión en inglés, salvo que la legislación aplicable disponga lo contrario.",
};

const sectionFour = {
  en: {
    title: "4. The Security of Your Personal Information",
    paragraphs: [
      "We have information security and access policies regarding access to our systems and technology, and we protect personal information using appropriate technological protection measures such as encryption, hashing, role-based access controls, and audit logs of data access.",
      "Unfortunately, the transmission of information via the internet is not completely secure. Although we will implement and maintain reasonable measures to protect your personal information, we cannot guarantee the security of information transmitted via the internet; any transmission is at your own risk.",
    ],
  },
  zh: {
    title: "4. 您个人信息的安全",
    paragraphs: [
      "我们就访问系统和技术制定了信息安全和访问政策，并使用适当的技术保护措施保护个人信息，例如加密、哈希、基于角色的访问控制以及数据访问审计日志。",
      "遗憾的是，通过互联网传输信息并非完全安全。尽管我们会实施并维持合理措施保护您的个人信息，但我们无法保证通过互联网传输的信息的安全性；任何传输均由您自行承担风险。",
    ],
  },
  id: {
    title: "4. Keamanan Informasi Pribadi Anda",
    paragraphs: [
      "Kami memiliki kebijakan keamanan informasi dan akses untuk sistem dan teknologi kami, serta melindungi informasi pribadi menggunakan langkah perlindungan teknologi yang sesuai, seperti enkripsi, hashing, kontrol akses berbasis peran, dan log audit akses data.",
      "Sayangnya, transmisi informasi melalui internet tidak sepenuhnya aman. Meskipun kami akan menerapkan dan memelihara langkah yang wajar untuk melindungi informasi pribadi Anda, kami tidak dapat menjamin keamanan informasi yang dikirim melalui internet; setiap transmisi dilakukan atas risiko Anda sendiri.",
    ],
  },
  es: {
    title: "4. Seguridad de su información personal",
    paragraphs: [
      "Disponemos de políticas de seguridad de la información y acceso aplicables a nuestros sistemas y tecnología, y protegemos la información personal mediante medidas tecnológicas adecuadas, como cifrado, hashing, controles de acceso basados en funciones y registros de auditoría del acceso a los datos.",
      "Lamentablemente, la transmisión de información por internet no es completamente segura. Aunque aplicaremos y mantendremos medidas razonables para proteger su información personal, no podemos garantizar la seguridad de la información transmitida por internet; toda transmisión se realiza por su cuenta y riesgo.",
    ],
  },
  ja: {
    title: "4. 個人情報の安全性",
    paragraphs: [
      "当社は、システムおよび技術へのアクセスに関する情報セキュリティ・アクセス方針を整備し、暗号化、ハッシュ化、ロールベースのアクセス制御、データアクセスの監査ログなど、適切な技術的保護措置を用いて個人情報を保護します。",
      "インターネットを介した情報送信は完全に安全ではありません。当社は個人情報を保護するため合理的な措置を実施・維持しますが、インターネット経由で送信される情報の安全性を保証することはできず、送信は利用者ご自身の責任で行われます。",
    ],
  },
};

const boldFullSentences = [
  "Please note that this Privacy Policy only applies to the Service. If you use any other products or services, please refer to the privacy policy for that particular product or service.",
  "If you do not agree to the processing of your personal information in the way this Privacy Policy describes, please do not provide your information when requested and stop using the Service. By using the Service you are acknowledging how we process your personal information as described in this Privacy Policy and, to the extent performance of a contract or legitimate interest cannot be relied upon in your jurisdiction to process the personal information, you consent to the processing of your personal information as described in this Privacy Policy.",
  "If you have any questions about anything in this Privacy Policy, or want to exercise any rights you may have, our contact information can be found in Section 7 (Contact) below.",
  "请注意，本隐私政策仅适用于本服务。如果您使用其他产品或服务，请查阅该产品或服务对应的隐私政策。",
  "如果您不同意本隐私政策所述的个人信息处理方式，请不要在被要求时提供信息，并停止使用本服务。使用本服务即表示您确认我们将按照本隐私政策处理您的个人信息；在您所在司法辖区无法以履行合同或合法利益作为处理个人信息的法律依据时，您同意我们按照本隐私政策处理您的个人信息。",
  "如果您对本隐私政策有任何问题，或希望行使您可能享有的任何权利，请通过第 7 节（联系我们）中的联系方式与我们联系。",
  "Harap diperhatikan bahwa Kebijakan Privasi ini hanya berlaku untuk Layanan. Jika Anda menggunakan produk atau layanan lain, silakan baca kebijakan privasi untuk produk atau layanan tersebut.",
  "Jika Anda tidak setuju dengan cara pemrosesan informasi pribadi yang dijelaskan dalam Kebijakan Privasi ini, jangan berikan informasi saat diminta dan berhentilah menggunakan Layanan. Dengan menggunakan Layanan, Anda memahami cara kami memproses informasi pribadi sebagaimana dijelaskan dalam Kebijakan Privasi ini. Sepanjang pelaksanaan kontrak atau kepentingan sah tidak dapat dijadikan dasar pemrosesan di yurisdiksi Anda, Anda menyetujui pemrosesan informasi pribadi sebagaimana dijelaskan dalam Kebijakan Privasi ini.",
  "Jika Anda memiliki pertanyaan tentang Kebijakan Privasi ini, atau ingin menggunakan hak yang mungkin Anda miliki, informasi kontak kami tersedia di Bagian 7 (Kontak) di bawah.",
];

const boldInlinePhrases = [
  "LightVela",
  "Tencent Cloud International Pte. Ltd.",
  "(“we”, “us”, “our”)",
  "（“我们”）",
  "(“kami”)",
];

const boldPrefixes = [
  "Login and account information, and security credential information",
  "Inputs and Outputs:",
  "Payment information:",
  "Communication information:",
  "Feedback information:",
  "Device information",
  "Configuration information",
  "Diagnostic and usage information, and log information",
  "Billing and consumption information",
  "Compliance records",
  "Other information we have about you:",
  "Third parties that provide services in support of the Service",
  "Messaging Channels",
  "payment processors",
  "Third party websites and services:",
  "Companies within our corporate group",
  "Regulators, judicial authorities, and law enforcement agencies.",
  "Third parties to ensure safety, security, or compliance with laws.",
  "Professional advisors.",
  "A third party that acquires all or substantially all of us or our business.",
  "为支持本服务而提供服务的第三方",
  "消息渠道",
  "支付处理方",
  "第三方网站和服务：",
  "我们企业集团内的公司",
  "监管机构、司法机关和执法机构。",
  "为确保安全、安保或遵守法律而披露给第三方。",
  "专业顾问。",
  "收购我们或我们业务全部或实质性部分的第三方。",
  "Access.",
  "Portability.",
  "Correction.",
  "Erasure.",
  "Restriction of Processing to Storage Only.",
  "Objection.",
  "Consent Withdrawal.",
  "登录和账户信息，以及安全凭证信息",
  "输入和输出：",
  "支付信息：",
  "沟通信息：",
  "反馈信息：",
  "设备信息",
  "配置信息",
  "诊断和使用信息及日志信息",
  "账单和用量信息",
  "合规记录",
  "我们掌握的关于您的其他信息",
  "访问。",
  "可携带。",
  "更正。",
  "删除。",
  "限制处理为仅存储。",
  "反对。",
  "撤回同意。",
  "Informasi login dan akun",
  "Input dan Output:",
  "Informasi pembayaran:",
  "Informasi komunikasi:",
  "Informasi masukan:",
  "Informasi perangkat",
  "Informasi konfigurasi",
  "Informasi diagnostik dan penggunaan",
  "Informasi penagihan dan konsumsi",
  "Catatan kepatuhan",
  "Informasi lain yang kami miliki tentang Anda",
  "Pihak ketiga yang menyediakan layanan untuk mendukung Layanan",
  "Kanal Pesan",
  "pemroses pembayaran",
  "Situs web dan layanan pihak ketiga:",
  "Perusahaan dalam grup korporasi kami",
  "Regulator, otoritas peradilan, dan lembaga penegak hukum.",
  "Pihak ketiga untuk memastikan keselamatan, keamanan, atau kepatuhan terhadap hukum.",
  "Penasihat profesional.",
  "Pihak ketiga yang mengakuisisi seluruh atau sebagian besar kami atau bisnis kami.",
  "Akses.",
  "Portabilitas.",
  "Koreksi.",
  "Penghapusan.",
  "Pembatasan Pemrosesan Menjadi Penyimpanan Saja.",
  "Keberatan.",
  "Penarikan Persetujuan.",
];

const renderLinkedText = (text: string): ReactNode[] => {
  const tokenPattern = /(Section 7 \(Contact\)|第 7 节（联系我们）|Bagian 7 \(Kontak\)|lightvela@tencent\.com|Tencent Cloud International Pte\. Ltd\.|\(“we”, “us”, “our”\)|\(“kami”\)|LightVela|Service|Layanan|（“我们”）)/g;
  return text.split(tokenPattern).filter(Boolean).map((part, index) => {
    if (part === "Section 7 (Contact)" || part === "第 7 节（联系我们）" || part === "Bagian 7 (Kontak)") {
      return (
        <a
          key={`${part}-${index}`}
          href="#contact"
          className="font-bold underline underline-offset-2 hover:opacity-80"
          style={{ color: "#2563EB", WebkitTextFillColor: "#2563EB", textDecorationColor: "#2563EB", fontWeight: 800 }}
        >
          {part}
        </a>
      );
    }
    if (part === "lightvela@tencent.com") {
      return (
        <a
          key={`${part}-${index}`}
          href="mailto:lightvela@tencent.com"
          className="font-semibold underline underline-offset-2 hover:opacity-80"
          style={{ color: "#2563EB", WebkitTextFillColor: "#2563EB", textDecorationColor: "#2563EB" }}
        >
          {part}
        </a>
      );
    }
    if (boldInlinePhrases.includes(part)) {
      return (
        <strong key={`${part}-${index}`} className="font-semibold text-slate-950">
          {part}
        </strong>
      );
    }
    return part;
  });
};

const RichText = ({ text }: { text: string }) => {
  if (text.includes("\n• ")) {
    const [lead = "", ...items] = text.split("\n");
    return (
      <div className="space-y-3">
        <div><RichText text={lead} /></div>
        <ul className="list-disc space-y-2 pl-5">
          {items.map((item) => (
            <li key={item}>
              <RichText text={item.replace(/^•\s*/, "")} />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (text.includes("\n\n")) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {text.split("\n\n").map((paragraph) => (
          <p key={paragraph} style={{ margin: 0 }}>
            <RichText text={paragraph} />
          </p>
        ))}
      </div>
    );
  }

  if (boldFullSentences.includes(text)) {
    return <strong className="font-semibold text-slate-950">{renderLinkedText(text)}</strong>;
  }

  const prefix = boldPrefixes.find((item) => text.startsWith(item));
  if (!prefix) {
    return <>{renderLinkedText(text)}</>;
  }

  return (
    <>
      <strong className="font-semibold text-slate-950">{prefix}</strong>
      {renderLinkedText(text.slice(prefix.length))}
    </>
  );
};

export const PrivacyPolicyParagraph = ({ text }: { text: string }) => {
  const className = "mt-6 text-base leading-9 text-slate-700";
  if (text.includes("\n\n")) {
    return (
      <div className={className}>
        <RichText text={text} />
      </div>
    );
  }
  return (
    <p className={className}>
      <RichText text={text} />
    </p>
  );
};

export function getPrivacyPolicyTableHeaders(locale: PublicSiteLocaleCode): {
  personal: string;
  use: string;
  legalBasis: string;
  retentionPolicy: string;
} {
  if (locale === PUBLIC_SITE_LOCALES.ES) {
    return {
      personal: "Información personal",
      use: "Uso",
      legalBasis: "Base jurídica (cuando corresponda)",
      retentionPolicy: "Política de conservación",
    };
  }
  if (locale === PUBLIC_SITE_LOCALES.JA_JP) {
    return {
      personal: "個人情報",
      use: "利用目的",
      legalBasis: "法的根拠（該当する場合）",
      retentionPolicy: "保存方針",
    };
  }
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) {
    return {
      personal: "Informasi Pribadi",
      use: "Penggunaan",
      legalBasis: "Dasar Hukum (jika berlaku)",
      retentionPolicy: "Kebijakan Retensi",
    };
  }
  if (isZhLocale(locale)) {
    return {
      personal: "个人信息",
      use: "用途",
      legalBasis: "法律基础（如适用）",
      retentionPolicy: "保留政策",
    };
  }
  return {
    personal: "Personal Information",
    use: "Use",
    legalBasis: "Legal Basis (where applicable)",
    retentionPolicy: "Retention Policy",
  };
}

const PolicyTable = ({ copy, locale }: { copy: PolicyCopy; locale: PublicSiteLocaleCode }) => {
  const headers = getPrivacyPolicyTableHeaders(locale);

  return (
    <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-[880px] border-collapse text-left text-[15px] leading-8">
          <thead className="bg-[#0B2E70] text-white">
            <tr>
              <th className="w-[34%] px-4 py-3 font-semibold">{headers.personal}</th>
              <th className="w-[33%] px-4 py-3 font-semibold">{headers.use}</th>
              <th className="w-[33%] px-4 py-3 font-semibold">{headers.legalBasis}</th>
            </tr>
          </thead>
          <tbody>
            {copy.processRows.flatMap((group) => [
              <tr key={group.category} className="bg-[#E7F2F6] text-slate-900">
                <td colSpan={3} className="px-4 py-3 font-semibold italic">
                  {group.category}
                </td>
              </tr>,
              ...group.data.map((row, index) => {
                const useRows = row.useRows;
                if (useRows?.length) {
                  return (
                    <Fragment key={`${group.category}-${index}`}>
                      {useRows.map((useRow, useIndex) => (
                        <tr key={`${group.category}-${index}-${useIndex}`} className="border-t border-slate-200 align-top odd:bg-white even:bg-slate-50/70">
                          {useIndex === 0 ? (
                            <td rowSpan={useRows.length} className="px-4 py-5 text-slate-900"><RichText text={row.personal} /></td>
                          ) : null}
                          <td className="px-4 py-5 text-slate-700"><RichText text={useRow.use} /></td>
                          <td className="px-4 py-5 text-slate-700"><RichText text={useRow.basis} /></td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                }

                return (
                  <tr key={`${group.category}-${index}`} className="border-t border-slate-200 align-top odd:bg-white even:bg-slate-50/70">
                    <td className="px-4 py-5 text-slate-900"><RichText text={row.personal} /></td>
                    <td className="px-4 py-5 text-slate-700"><RichText text={row.use} /></td>
                    <td className="px-4 py-5 text-slate-700"><RichText text={row.basis} /></td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const RetentionTable = ({ copy, locale }: { copy: PolicyCopy; locale: PublicSiteLocaleCode }) => {
  const headers = getPrivacyPolicyTableHeaders(locale);

  return (
    <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-[720px] border-collapse text-left text-sm leading-6">
          <thead className="bg-[#0B2E70] text-white">
            <tr>
              <th className="w-[42%] px-4 py-3 font-semibold">{headers.personal}</th>
              <th className="px-4 py-3 font-semibold">{headers.retentionPolicy}</th>
            </tr>
          </thead>
          <tbody>
            {copy.retentionRows.map((row) => (
            <tr key={row.personal} className="border-t border-slate-200 align-top odd:bg-white even:bg-slate-50/70">
              <td className="px-4 py-4 font-medium text-slate-900"><RichText text={row.personal} /></td>
              <td className="px-4 py-4 text-slate-700"><RichText text={row.policy} /></td>
            </tr>
          ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const TextSection = ({ id, title, paragraphs, bullets }: { id?: string; title: string; paragraphs?: string[]; bullets?: Array<string | { text: string; children?: string[] }> }) => (
  <section id={id} className="scroll-mt-24 border-t border-slate-200 py-12 sm:py-14">
    <h2 className="text-2xl font-semibold tracking-[-0.04em] text-slate-950">{title}</h2>
    {paragraphs?.map((paragraph) => <PrivacyPolicyParagraph key={paragraph} text={paragraph} />)}
    {bullets ? (
      <ul className="mt-7 space-y-5 pl-5 text-base leading-9 text-slate-700">
        {bullets.map((bullet) => {
          const item = typeof bullet === "string" ? { text: bullet } : bullet;
          return (
            <li key={item.text} className="list-disc pl-1">
              <RichText text={item.text} />
              {item.children ? (
                <ul className="mt-3 space-y-2 pl-6 text-sm leading-7 text-slate-700">
                  {item.children.map((child) => (
                    <li key={child} className="list-[circle] pl-1">
                      <RichText text={child} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    ) : null}
  </section>
);

export function publicLocaleHomePath(locale: PublicSiteLocaleCode): string {
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return `/${PUBLIC_URL_LANGS.ID_ID}/`;
  if (locale === PUBLIC_SITE_LOCALES.ZH_HANT) return `/${PUBLIC_URL_LANGS.ZH_HANT}/`;
  if (locale === PUBLIC_SITE_LOCALES.ES) return `/${PUBLIC_URL_LANGS.ES}/`;
  if (locale === PUBLIC_SITE_LOCALES.JA_JP) return `/${PUBLIC_URL_LANGS.JA_JP}/`;
  if (locale.startsWith("zh")) return `/${PUBLIC_URL_LANGS.ZH_SG}/`;
  return `/${PUBLIC_URL_LANGS.EN_US}/`;
}

export function getPrivacyPolicyChrome(
  locale: PublicSiteLocaleCode,
): Pick<PolicyCopy, "backHome" | "brand" | "title" | "updated"> {
  const source = getPrivacyPolicyCopy(locale);
  return {
    backHome: source.backHome,
    brand: source.brand,
    title: source.title,
    updated: source.updated,
  };
}

export function getPrivacyPolicyCopy(locale: PublicSiteLocaleCode): PolicyCopy {
  if (locale === PUBLIC_SITE_LOCALES.JA_JP) return JAPANESE_PRIVACY_POLICY_COPY as PolicyCopy;
  if (locale === PUBLIC_SITE_LOCALES.ES) return es;
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return id;
  return isZhLocale(locale) ? zh : en;
}

export const PrivacyPolicyPage = () => {
  const localeOverride = useLocaleOverride();
  const currentLocale: PublicSiteLocaleCode =
    localeOverride === PUBLIC_SITE_LOCALES.JA_JP
      ? PUBLIC_SITE_LOCALES.JA_JP
      : localeOverride === PUBLIC_SITE_LOCALES.ID_ID
      ? PUBLIC_SITE_LOCALES.ID_ID
      : localeOverride === PUBLIC_SITE_LOCALES.ES
        ? PUBLIC_SITE_LOCALES.ES
      : localeOverride === PUBLIC_SITE_LOCALES.ZH_HANT
        ? PUBLIC_SITE_LOCALES.ZH_HANT
        : localeOverride?.startsWith("zh")
          ? PUBLIC_SITE_LOCALES.ZH_SG
          : PUBLIC_SITE_LOCALES.EN_US;
  const isZh = isZhLocale(currentLocale);
  const isId = currentLocale === PUBLIC_SITE_LOCALES.ID_ID;
  const isJa = currentLocale === PUBLIC_SITE_LOCALES.JA_JP;
  // 繁体（zh-Hant）时对简体源文案做 OpenCC 简→繁转换；简体原样，英文用 en
  const baseCopy = getPrivacyPolicyCopy(currentLocale);
  const copy = useZhHantDeep({ ...baseCopy, ...getPrivacyPolicyChrome(currentLocale) });
  const security = useZhHantDeep(
    currentLocale === PUBLIC_SITE_LOCALES.ES
      ? sectionFour.es
      : isJa
        ? sectionFour.ja
      : isId
        ? sectionFour.id
        : isZh
          ? sectionFour.zh
          : sectionFour.en,
  );
  const homePath = localeOverride ? publicLocaleHomePath(currentLocale) : localizedPath("/", currentLocale);

  return (
    <div className="min-h-dvh bg-[#F7F8FA] text-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <AppLink to={homePath} className="text-xl font-semibold tracking-[-0.04em] text-slate-950">
            {copy.brand}
          </AppLink>
          <AppLink to={homePath} className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-950">
            {copy.backHome}
          </AppLink>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14 lg:py-16">
        <article className="rounded-[2rem] border border-slate-200 bg-white px-5 py-8 shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)] sm:px-8 sm:py-10 lg:px-12">
          <div className="border-b border-slate-200 pb-12 sm:pb-14">
            <h1 className="text-4xl font-semibold tracking-[-0.06em] text-slate-950 sm:text-5xl">{copy.title}</h1>
            <p className="mt-5 text-sm font-medium leading-7 text-slate-500">{copy.updated}</p>
            <div className="mt-12 space-y-6">
              {copy.intro.map((paragraph) => (
                <p key={paragraph} className="text-base leading-9 text-slate-700">
                  <RichText text={paragraph} />
                </p>
              ))}
            </div>
          </div>

          {copy.sections.map((section) => (
            <TextSection key={section.title} title={section.title} paragraphs={section.paragraphs} bullets={section.bullets} />
          ))}

          <section className="border-t border-slate-200 py-12 sm:py-14">
            <h2 className="text-2xl font-semibold tracking-[-0.04em] text-slate-950">{copy.processTitle}</h2>
            {copy.processIntro.map((paragraph) => (
              <p key={paragraph} className="mt-6 text-base leading-9 text-slate-700">
                <RichText text={paragraph} />
              </p>
            ))}
          <PolicyTable copy={copy} locale={currentLocale} />
          </section>

          <TextSection title={copy.shareTitle} paragraphs={copy.shareParagraphs} bullets={copy.shareBullets} />
          <TextSection title={security.title} paragraphs={security.paragraphs} />

          <section className="border-t border-slate-200 py-12 sm:py-14">
            <h2 className="text-2xl font-semibold tracking-[-0.04em] text-slate-950">{copy.retentionTitle}</h2>
            {copy.retentionIntro.map((paragraph) => (
              <p key={paragraph} className="mt-6 text-base leading-9 text-slate-700">
                <RichText text={paragraph} />
              </p>
            ))}
          <RetentionTable copy={copy} locale={currentLocale} />
          </section>

          <TextSection title={copy.rightsTitle} paragraphs={[copy.rightsIntro]} bullets={copy.rightsBullets} />
          <TextSection id="contact" title={copy.contactTitle} paragraphs={copy.contactParagraphs} />
          <TextSection title={copy.thirdPartyTitle} paragraphs={[copy.thirdPartyParagraph]} />
          <TextSection title={copy.changesTitle} paragraphs={[copy.changesParagraph]} />
          <TextSection title={copy.languageTitle} paragraphs={[copy.languageParagraph]} />
        </article>
      </main>

      <LegalFooter />
    </div>
  );
};

/**
 * Support / LightVela Product Feedback — 用户端问卷表单页面
 * ──────────────────────────────────────────────────────────────
 * 本期仅上线国内站，暂不做多语言支持。
 */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { LegalFooter } from '@/components/site/legal-footer';
import type { LanguageSwitcherVariant } from '@/components/site/language-switcher';
import { LoginModal } from '@/components/site/login-modal';
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from '@/components/site/public-site-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DisplayTitle } from '@/components/ui/display-title';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useSession } from '@/contexts/session-context';
import { useT } from '@/i18n/t';
import { cn } from '@/lib/utils';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { PUBLIC_SITE_LOCALES } from '@/lib/public-site-routing';
import type { SupportFeedbackProfile, FeedbackCategory } from '@/lib/support-feedback-cos-client';

/* ──────────────────────────────────────────────────────────
 * 类型
 * ────────────────────────────────────────────────────────── */

type FeedbackType =
  | 'experience_issue'
  | 'bug_report'
  | 'feature_request'
  | 'rant'
  | 'performance'
  | 'billing'
  | 'security'
  | 'docs'
  | 'other';

interface UploadedFile {
  name: string;
  size: number;
  url: string; // object URL for preview
  file: File;
}

interface SupportFeedbackDraft {
  category: FeedbackCategory | '';
  feedbackType: FeedbackType | '';
  otherText: string;
  description: string;
  contactInfo: string;
  // 以下字段类型与模块级常量推断出的字面量联合类型对齐，消除魔法字符串。
  profileSource: ProfileSource | '';
  profileRole: ProfileRole | '';
  profileAiGoal: string;
  profileFrequency: ProfileFrequency | '';
  profileIndustry: ProfileIndustry | '';
  bugFrequency: BugFrequency | '';
  bugExpected: string;
}

/* ──────────────────────────────────────────────────────────
 * 问卷选项常量
 *
 * 设计说明：value 与 label 故意保持一致（"code = label"）。
 * 原因：dashboard 侧只做只读展示，COS 存储的是人类可读中文；
 * 如果 value 是英文 code，dashboard 还要维护一份 code→label 映射，
 * 运营排查时也看不懂原始数据。
 *
 * 使用 `as const` 目的：让 TS 推断出字面量联合类型，消除魔法字符串。
 * 任何引用单个 value（如表单校验）都从常量取，拼写错误会在编译期报错。
 * ────────────────────────────────────────────────────────── */

/** Bug 类发生频率选项。 */
export const BUG_FREQUENCY_OPTIONS = [
  { value: '每次必现', label: '每次必现' },
  { value: '经常发生', label: '经常发生' },
  { value: '偶尔发生', label: '偶尔发生' },
  { value: '仅出现一次', label: '仅出现一次' },
] as const;
export type BugFrequency = (typeof BUG_FREQUENCY_OPTIONS)[number]['value'];

/** 了解渠道选项。 */
export const PROFILE_SOURCE_OPTIONS = [
  { value: '搜索引擎', label: '搜索引擎' },
  { value: '朋友/同事推荐', label: '朋友/同事推荐' },
  { value: '社交媒体', label: '社交媒体' },
  { value: '官网/文档', label: '官网/文档' },
  { value: '社区/论坛', label: '社区/论坛' },
  { value: '广告投放', label: '广告投放' },
  { value: '新闻/媒体', label: '新闻/媒体' },
  { value: '其他', label: '其他' },
] as const;
export type ProfileSource = (typeof PROFILE_SOURCE_OPTIONS)[number]['value'];

/** 角色选项。 */
export const PROFILE_ROLE_OPTIONS = [
  { value: '学生', label: '学生' },
  { value: '开发者', label: '开发者' },
  { value: '设计师', label: '设计师' },
  { value: '产品经理', label: '产品经理' },
  { value: '创业者', label: '创业者' },
  { value: '运营/其他', label: '运营/其他' },
  { value: '科研/学术', label: '科研/学术' },
  { value: '工程师（非开发）', label: '工程师（非开发）' },
  { value: '市场/营销', label: '市场/营销' },
  { value: '销售/商务', label: '销售/商务' },
  { value: '人力/招聘', label: '人力/招聘' },
  { value: '写作/内容', label: '写作/内容' },
  { value: '教师/教育', label: '教师/教育' },
  { value: '自由职业者', label: '自由职业者' },
  { value: '分析师/咨询', label: '分析师/咨询' },
  { value: '团队负责人/管理者', label: '团队负责人/管理者' },
  { value: '其他', label: '其他' },
] as const;
export type ProfileRole = (typeof PROFILE_ROLE_OPTIONS)[number]['value'];

/** 使用频率选项。 */
export const PROFILE_FREQUENCY_OPTIONS = [
  { value: '几乎每天', label: '几乎每天' },
  { value: '每周几次', label: '每周几次' },
  { value: '每月几次', label: '每月几次' },
  { value: '偶尔用用', label: '偶尔用用' },
  { value: '刚接触', label: '刚接触' },
] as const;
export type ProfileFrequency = (typeof PROFILE_FREQUENCY_OPTIONS)[number]['value'];

/** 行业选项。 */
export const PROFILE_INDUSTRY_OPTIONS = [
  { value: '互联网/软件', label: '互联网/软件' },
  { value: 'AI/科技', label: 'AI/科技' },
  { value: '教育', label: '教育' },
  { value: '金融/保险', label: '金融/保险' },
  { value: '媒体/内容', label: '媒体/内容' },
  { value: '电商/零售', label: '电商/零售' },
  { value: '医疗/生物', label: '医疗/生物' },
  { value: '制造/硬件', label: '制造/硬件' },
  { value: '游戏/文娱', label: '游戏/文娱' },
  { value: '政府/公共', label: '政府/公共' },
  { value: '科研/学术', label: '科研/学术' },
  { value: '自由职业/个体', label: '自由职业/个体' },
  { value: '学生', label: '学生' },
  { value: '其他', label: '其他' },
] as const;
export type ProfileIndustry = (typeof PROFILE_INDUSTRY_OPTIONS)[number]['value'];

const SUPPORT_LABELS_EN: Record<string, string> = {
  '每次必现': 'Always reproducible',
  '经常发生': 'Often',
  '偶尔发生': 'Sometimes',
  '仅出现一次': 'Only once',
  '搜索引擎': 'Search engine',
  '朋友/同事推荐': 'Friend or colleague recommendation',
  '社交媒体': 'Social media',
  '官网/文档': 'Official site or documentation',
  '社区/论坛': 'Community or forum',
  '广告投放': 'Advertisement',
  '新闻/媒体': 'News or media',
  '其他': 'Other',
  '学生': 'Student',
  '开发者': 'Developer',
  '设计师': 'Designer',
  '产品经理': 'Product manager',
  '创业者': 'Founder',
  '运营/其他': 'Operations / other',
  '科研/学术': 'Research / academic',
  '工程师（非开发）': 'Engineer (non-developer)',
  '市场/营销': 'Marketing',
  '销售/商务': 'Sales / business',
  '人力/招聘': 'HR / recruiting',
  '写作/内容': 'Writing / content',
  '教师/教育': 'Teacher / education',
  '自由职业者': 'Freelancer',
  '分析师/咨询': 'Analyst / consulting',
  '团队负责人/管理者': 'Team lead / manager',
  '几乎每天': 'Almost every day',
  '每周几次': 'A few times a week',
  '每月几次': 'A few times a month',
  '偶尔用用': 'Occasionally',
  '刚接触': 'Just getting started',
  '互联网/软件': 'Internet / software',
  'AI/科技': 'AI / technology',
  '教育': 'Education',
  '金融/保险': 'Finance / insurance',
  '媒体/内容': 'Media / content',
  '电商/零售': 'E-commerce / retail',
  '医疗/生物': 'Healthcare / biotech',
  '制造/硬件': 'Manufacturing / hardware',
  '游戏/文娱': 'Gaming / entertainment',
  '政府/公共': 'Government / public sector',
  '自由职业/个体': 'Freelance / self-employed',
  '调研问卷': 'Survey',
  '可留下微信号或邮箱；': 'You can leave a WeChat ID or email;',
  '微信号如：lightvela_demo，邮箱如：1234@gmail.com': 'For example: WeChat lightvela_demo, or email 1234@gmail.com',
};

const SUPPORT_LABELS_ID: Record<string, string> = {
  '每次必现': 'Selalu terjadi',
  '经常发生': 'Sering terjadi',
  '偶尔发生': 'Kadang terjadi',
  '仅出现一次': 'Hanya sekali',
  '搜索引擎': 'Mesin pencari',
  '朋友/同事推荐': 'Rekomendasi teman atau rekan kerja',
  '社交媒体': 'Media sosial',
  '官网/文档': 'Situs resmi atau dokumentasi',
  '社区/论坛': 'Komunitas atau forum',
  '广告投放': 'Iklan',
  '新闻/媒体': 'Berita atau media',
  '其他': 'Lainnya',
  '学生': 'Pelajar/mahasiswa',
  '开发者': 'Developer',
  '设计师': 'Desainer',
  '产品经理': 'Product manager',
  '创业者': 'Founder',
  '运营/其他': 'Operasional / lainnya',
  '科研/学术': 'Riset / akademik',
  '工程师（非开发）': 'Engineer non-developer',
  '市场/营销': 'Marketing',
  '销售/商务': 'Sales / business',
  '人力/招聘': 'HR / rekrutmen',
  '写作/内容': 'Penulis / konten',
  '教师/教育': 'Pengajar / edukasi',
  '自由职业者': 'Freelancer',
  '分析师/咨询': 'Analis / konsultan',
  '团队负责人/管理者': 'Lead tim / manajer',
  '几乎每天': 'Hampir setiap hari',
  '每周几次': 'Beberapa kali seminggu',
  '每月几次': 'Beberapa kali sebulan',
  '偶尔用用': 'Sesekali',
  '刚接触': 'Baru mencoba',
  '互联网/软件': 'Internet / software',
  'AI/科技': 'AI / teknologi',
  '教育': 'Pendidikan',
  '金融/保险': 'Keuangan / asuransi',
  '媒体/内容': 'Media / konten',
  '电商/零售': 'E-commerce / retail',
  '医疗/生物': 'Kesehatan / bioteknologi',
  '制造/硬件': 'Manufaktur / hardware',
  '游戏/文娱': 'Game / hiburan',
  '政府/公共': 'Pemerintah / sektor publik',
  '自由职业/个体': 'Freelance / wiraswasta',
  '调研问卷': 'Survei',
  '可留下微信号或邮箱；': 'Anda dapat meninggalkan ID WeChat atau email;',
  '微信号如：lightvela_demo，邮箱如：1234@gmail.com': 'Contoh: WeChat lightvela_demo, atau email 1234@gmail.com',
};

const SUPPORT_LABELS_HANT: Record<string, string> = {
  '每次必现': '每次必現',
  '经常发生': '經常發生',
  '偶尔发生': '偶爾發生',
  '仅出现一次': '僅出現一次',
  '搜索引擎': '搜尋引擎',
  '朋友/同事推荐': '朋友/同事推薦',
  '社交媒体': '社交媒體',
  '官网/文档': '官網/文件',
  '社区/论坛': '社群/論壇',
  '广告投放': '廣告投放',
  '新闻/媒体': '新聞/媒體',
  '其他': '其他',
  '学生': '學生',
  '开发者': '開發者',
  '设计师': '設計師',
  '产品经理': '產品經理',
  '创业者': '創業者',
  '运营/其他': '營運/其他',
  '科研/学术': '科研/學術',
  '工程师（非开发）': '工程師（非開發）',
  '市场/营销': '市場/行銷',
  '销售/商务': '銷售/商務',
  '人力/招聘': '人力/招聘',
  '写作/内容': '寫作/內容',
  '教师/教育': '教師/教育',
  '自由职业者': '自由工作者',
  '分析师/咨询': '分析師/諮詢',
  '团队负责人/管理者': '團隊負責人/管理者',
  '几乎每天': '幾乎每天',
  '每周几次': '每週幾次',
  '每月几次': '每月幾次',
  '偶尔用用': '偶爾使用',
  '刚接触': '剛接觸',
  '互联网/软件': '互聯網/軟件',
  'AI/科技': 'AI/科技',
  '教育': '教育',
  '金融/保险': '金融/保險',
  '媒体/内容': '媒體/內容',
  '电商/零售': '電商/零售',
  '医疗/生物': '醫療/生物',
  '制造/硬件': '製造/硬件',
  '游戏/文娱': '遊戲/文娛',
  '政府/公共': '政府/公共',
  '自由职业/个体': '自由職業/個體',
  '调研问卷': '調研問卷',
  '可留下微信号或邮箱；': '可留下微信號或郵箱；',
  '微信号如：lightvela_demo，邮箱如：1234@gmail.com': '微信號如：lightvela_demo，郵箱如：1234@gmail.com',
};

function localizeSupportLabel(label: string, locale: PublicSiteLocale): string {
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return SUPPORT_LABELS_ID[label] ?? label;
  if (locale === PUBLIC_SITE_LOCALES.EN_US) return SUPPORT_LABELS_EN[label] ?? label;
  if (locale === PUBLIC_SITE_LOCALES.ZH_HANT) return SUPPORT_LABELS_HANT[label] ?? label;
  return label;
}

const SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY = 'lightvela-support-feedback-draft-v1';

function isFeedbackType(value: unknown): value is FeedbackType {
  return value === 'experience_issue'
    || value === 'bug_report'
    || value === 'feature_request'
    || value === 'rant'
    || value === 'performance'
    || value === 'billing'
    || value === 'security'
    || value === 'docs'
    || value === 'other';
}

function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return value === 'suggestion' || value === 'bug';
}

function readSupportFeedbackDraft(): SupportFeedbackDraft | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SupportFeedbackDraft>;
    return {
      category: isFeedbackCategory(parsed.category) ? parsed.category : '',
      feedbackType: isFeedbackType(parsed.feedbackType) ? parsed.feedbackType : '',
      otherText: typeof parsed.otherText === 'string' ? parsed.otherText : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      contactInfo: typeof parsed.contactInfo === 'string' ? parsed.contactInfo : '',
      profileSource: typeof parsed.profileSource === 'string' ? parsed.profileSource : '',
      profileRole: typeof parsed.profileRole === 'string' ? parsed.profileRole : '',
      profileAiGoal: typeof parsed.profileAiGoal === 'string' ? parsed.profileAiGoal : '',
      profileFrequency: typeof parsed.profileFrequency === 'string' ? parsed.profileFrequency : '',
      profileIndustry: typeof parsed.profileIndustry === 'string' ? parsed.profileIndustry : '',
      bugFrequency: typeof parsed.bugFrequency === 'string' ? parsed.bugFrequency : '',
      bugExpected: typeof parsed.bugExpected === 'string' ? parsed.bugExpected : '',
    };
  } catch {
    return null;
  }
}

function writeSupportFeedbackDraft(draft: SupportFeedbackDraft): void {
  if (typeof window === 'undefined') {
    return;
  }
  const hasContent = Boolean(
    draft.category
    || draft.feedbackType
    || draft.otherText.trim()
    || draft.description.trim()
    || draft.profileSource.trim()
    || draft.profileRole.trim()
    || draft.profileAiGoal.trim()
    || draft.profileFrequency.trim()
    || draft.profileIndustry.trim()
    || draft.bugFrequency.trim()
    || draft.bugExpected.trim(),
  );
  if (!hasContent) {
    window.sessionStorage.removeItem(SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY);
    return;
  }
  window.sessionStorage.setItem(SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

function clearSupportFeedbackDraft(): void {
  if (typeof window !== 'undefined') {
    window.sessionStorage.removeItem(SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY);
  }
}

/* ──────────────────────────────────────────────────────────
 * 主组件
 * ────────────────────────────────────────────────────────── */

type SupportPageProps = {
  authControls?: ReactNode;
  currentPath?: string;
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
  renderLanguageSwitcher?: (options: { activeLocale: PublicSiteLocale; reloadAfterSwitch: boolean; variant: LanguageSwitcherVariant }) => ReactNode;
  renderLink?: RenderPublicSiteHeaderLink;
};


export function SupportPage({
  authControls,
  currentPath,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
}: SupportPageProps = {}): React.ReactElement {
  const t = useT();
  const { session, authReady, isAuthenticated } = useSession();
  const userId = session.user?.id?.trim() ?? '';
  const activePublicLocale: PublicSiteLocale = publicLocale ?? PUBLIC_SITE_LOCALES.ZH_CN;
  const pageCopy = {
    pageTitle: t('产品反馈'),
    pageDesc: t('您可以将使用 LightVela 过程中的任何体验问题或需求建议告诉我们，帮助我们变得更好！'),
    contactHintPrimary: localizeSupportLabel('可留下微信号或邮箱；', activePublicLocale),
    contactHintExamples: localizeSupportLabel('微信号如：lightvela_demo，邮箱如：1234@gmail.com', activePublicLocale),
  };

  const effectiveUserId = userId;
  /* Form state */
  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [feedbackType, setFeedbackType] = useState<FeedbackType | ''>('');
  const [otherText, setOtherText] = useState('');
  const [description, setDescription] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  // 用户画像（调研问卷，必填）——仅收集高信号字段，建议/反馈类使用
  const [profileSource, setProfileSource] = useState<ProfileSource | ''>('');
  const [profileRole, setProfileRole] = useState<ProfileRole | ''>('');
  const [profileAiGoal, setProfileAiGoal] = useState('');
  const [profileFrequency, setProfileFrequency] = useState<ProfileFrequency | ''>('');
  const [profileIndustry, setProfileIndustry] = useState<ProfileIndustry | ''>('');
  // Bug 类排障信息
  const [bugFrequency, setBugFrequency] = useState<BugFrequency | ''>('');
  const [bugExpected, setBugExpected] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [hasRestoredDraft, setHasRestoredDraft] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const draft = readSupportFeedbackDraft();
    if (draft) {
      setCategory(draft.category);
      setFeedbackType(draft.feedbackType);
      setOtherText(draft.otherText);
      setDescription(draft.description);
      setContactInfo(draft.contactInfo);
      setProfileSource(draft.profileSource);
      setProfileRole(draft.profileRole);
      setProfileAiGoal(draft.profileAiGoal);
      setProfileFrequency(draft.profileFrequency);
      setProfileIndustry(draft.profileIndustry);
      setBugFrequency(draft.bugFrequency);
      setBugExpected(draft.bugExpected);
    }
    setHasRestoredDraft(true);
  }, []);

  useEffect(() => {
    if (!hasRestoredDraft || submitted) {
      return;
    }
    writeSupportFeedbackDraft({
      category,
      feedbackType,
      otherText,
      description,
      contactInfo,
      profileSource,
      profileRole,
      profileAiGoal,
      profileFrequency,
      profileIndustry,
      bugFrequency,
      bugExpected,
    });
  }, [category, contactInfo, description, feedbackType, hasRestoredDraft, otherText, profileAiGoal, profileRole, profileSource, profileFrequency, profileIndustry, bugFrequency, bugExpected, submitted]);

  useEffect(() => {
    if (!userId) {
      return;
    }
    setErrors((prev) => {
      if (!prev.accountId) {
        return prev;
      }
      const next = { ...prev };
      delete next.accountId;
      return next;
    });
  }, [userId]);

  const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300MB

  const feedbackOptions: { value: FeedbackType; label: string }[] = [
    { value: 'experience_issue', label: t('体验问题反馈') },
    { value: 'bug_report', label: t('Bug 反馈') },
    { value: 'feature_request', label: t('产品功能建议') },
    { value: 'performance', label: t('Agent 运行问题') },
    { value: 'billing', label: t('账单/费用问题') },
    { value: 'security', label: t('安全 / 隐私问题') },
    { value: 'docs', label: t('文档 / 帮助问题') },
    { value: 'rant', label: t('产品吐槽') },
    { value: 'other', label: t('其他') },
  ];

  // 建议/反馈类的细分类型（bug_report / security 归入 Bug 大类）
  const suggestionFeedbackOptions = feedbackOptions.filter(
    (opt) => opt.value !== 'bug_report' && opt.value !== 'security',
  );

  // Bug 类发生频率选项（模块级常量 BUG_FREQUENCY_OPTIONS）。
  const bugFrequencyOptions = BUG_FREQUENCY_OPTIONS;

  // 调研问卷（选填）用户画像选项（模块级常量）。
  const profileSourceOptions = PROFILE_SOURCE_OPTIONS;
  const profileRoleOptions = PROFILE_ROLE_OPTIONS;
  const profileFrequencyOptions = PROFILE_FREQUENCY_OPTIONS;
  const profileIndustryOptions = PROFILE_INDUSTRY_OPTIONS;

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!effectiveUserId) {
      errs.accountId = t('请先登录后再提交反馈');
    }
    if (!category) {
      errs.category = t('请选择反馈大类');
    } else if (category === 'suggestion') {
      if (!profileSource) {
        errs.profileSource = t('请选择了解渠道');
      }
      if (!profileRole) {
        errs.profileRole = t('请选择角色');
      }
      if (!profileFrequency) {
        errs.profileFrequency = t('请选择使用频率');
      }
      if (!profileIndustry) {
        errs.profileIndustry = t('请选择行业');
      }
      if (!profileAiGoal.trim()) {
        errs.profileAiGoal = t('请填写 AI 用途');
      }
      if (!feedbackType) {
        errs.feedbackType = t('请选择反馈类型');
      }
      if (feedbackType === 'other' && !otherText.trim()) {
        errs.otherText = t('请填写具体类型');
      }
      if (!description.trim()) {
        errs.description = t('请填写反馈内容');
      }
    } else {
      // bug 类
      if (!description.trim()) {
        errs.description = t('请描述您遇到的问题现象');
      }
      if (!bugFrequency) {
        errs.bugFrequency = t('请选择发生频率');
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const clearFiles = () => {
    setFiles((prev) => {
      for (const uploaded of prev) {
        URL.revokeObjectURL(uploaded.url);
      }
      return [];
    });
  };

  const hasProfileInput = (): boolean =>
    Boolean(
      profileSource.trim()
      || profileRole.trim()
      || profileAiGoal.trim()
      || profileFrequency.trim()
      || profileIndustry.trim(),
    );

  const openLoginModal = () => {
    setShowLoginModal(true);
  };

  const submitFeedback = async () => {
    setIsSubmitting(true);
    try {
      const { createSupportFeedback, isSupportCosConfigured } = await import(
        '@/lib/support-feedback-cos-client'
      );
      if (!isSupportCosConfigured()) {
        throw new Error(t('反馈系统未配置，请稍后再试'));
      }
      const isBug = category === 'bug';
      const profile: SupportFeedbackProfile | null = !isBug && hasProfileInput()
        ? {
          source: profileSource.trim(),
          role: profileRole.trim(),
          aiGoal: profileAiGoal.trim(),
          frequency: profileFrequency.trim(),
          industry: profileIndustry.trim(),
        }
        : null;
      const bugInfo = isBug
        ? {
          frequency: bugFrequency,
          expected: bugExpected.trim(),
        }
        : null;

      await createSupportFeedback({
        accountId: effectiveUserId,
        feedbackType: isBug ? 'bug_report' : feedbackType,
        otherText: otherText.trim() || null,
        description: description.trim(),
        files: files.map((uploaded) => uploaded.file),
        contactInfo: contactInfo.trim() || null,
        profile,
        category: isBug ? 'bug' : 'suggestion',
        bugInfo,
      });
      clearSupportFeedbackDraft();
      clearFiles();
      setErrors({});
      setSubmitted(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('提交失败，请稍后重试'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError('');

    if (!authReady) {
      return;
    }
    if (!isAuthenticated || !userId) {
      setErrors((prev) => ({ ...prev, accountId: t('请先登录后再提交反馈') }));
      openLoginModal();
      return;
    }
    if (!validate()) {
      return;
    }

    await submitFeedback();
  };

  const handleReset = () => {
    clearSupportFeedbackDraft();
    setCategory('');
    setFeedbackType('');
    setOtherText('');
    setDescription('');
    setContactInfo('');
    setProfileSource('');
    setProfileRole('');
    setProfileAiGoal('');
    setProfileFrequency('');
    setProfileIndustry('');
    setBugFrequency('');
      setBugExpected('');
    clearFiles();
    setSubmitted(false);
    setIsSubmitting(false);
    setSubmitError('');
    setErrors({});
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected) return;
    const newFiles: UploadedFile[] = [];
    for (let i = 0; i < selected.length; i++) {
      const f = selected[i];
      if (!f) continue;
      if (f.size > MAX_FILE_SIZE) continue; // skip oversized
      newFiles.push({
        name: f.name,
        size: f.size,
        url: URL.createObjectURL(f),
        file: f,
      });
    }
    setFiles((prev) => [...prev, ...newFiles]);
    // reset input so same file can be re-selected
    e.target.value = '';
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => {
      const removed = prev[idx];
      if (removed) URL.revokeObjectURL(removed.url);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleUploadTrigger = () => {
    if (!isAuthenticated || !userId) {
      setErrors((prev) => ({ ...prev, accountId: t('请先登录后再上传附件') }));
      openLoginModal();
      return;
    }
    fileInputRef.current?.click();
  };

  return (
    <div
      className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden"
      style={{ color: 'var(--lw-fg)' }}
    >
      <PublicSiteHeader
        authControls={authControls}
        currentPath={currentPath}
        currentSection=""
        locale={activePublicLocale}
        localized={publicLocalized}
        position="fixed"
        renderLink={renderLink}
        renderLanguageSwitcher={renderLanguageSwitcher}
      />

      <main className="relative z-10 flex-grow pt-[60px]">
        <div className="mx-auto max-w-3xl px-6 py-16">
          {submitted ? (
            /* ── 提交成功 ── */
            <Card className="p-10 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-success)]/10">
                <svg className="h-8 w-8 text-[var(--color-success)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <DisplayTitle as="h2" size="section" className="mb-2">
                {t('提交成功')}
              </DisplayTitle>
              <p className="mb-6 text-sm text-[var(--text-secondary)]">
                {t('感谢您的反馈！我们已收到您的问题，会尽快处理。')}
              </p>
              <Button type="button" onClick={handleReset}>
                {t('继续反馈')}
              </Button>
            </Card>
          ) : (
            /* ── 问卷表单 ── */
            <Card>
              <CardContent className="space-y-10 pt-6">
                <form onSubmit={handleSubmit} className="space-y-10">
                  {/* 标题 */}
                  <div className="text-center">
                    <DisplayTitle as="h1" size="page">
                      {pageCopy.pageTitle}
                    </DisplayTitle>
                    <p className="mt-3 text-sm text-[var(--text-secondary)]">
                      {pageCopy.pageDesc}
                    </p>
                  </div>

              {/* 01 账号 ID */}
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <span className="text-red-500">*</span>
                  <span className="font-semibold text-[var(--text-tertiary)]">01</span>
                  {t('您的账号ID是？')}
                </Label>
                {isAuthenticated && userId ? (
                  <>
                    <Input
                      type="text"
                      value={userId}
                      readOnly
                      className={cn(
                        'bg-[var(--surface-muted)] text-[var(--text-tertiary)]',
                        errors.accountId && 'border-red-400 focus-visible:ring-red-400/20',
                      )}
                    />
                    <p className="text-xs text-[var(--text-tertiary)]">
                      {t('已自动读取当前登录账号ID；如需更换账号，请先切换登录身份后再提交。')}
                    </p>
                  </>
                ) : (
                  <div
                    className={cn(
                      'rounded-md border border-[var(--border-strong)] bg-white/90 p-4',
                      errors.accountId && 'border-red-400',
                    )}
                  >
                    <p className="text-sm text-[var(--text-secondary)]">
                      {t('登录后系统会自动读取您的账号ID，并在完成登录后返回当前页面继续提交。')}
                    </p>
                    <p className="mt-2 text-xs text-[var(--text-tertiary)]">
                      {t('您已填写的类型和问题描述会保留；为避免附件丢失，请登录后再上传文件。')}
                    </p>
                    <div className="mt-4">
                      <Button type="button" variant="outline" onClick={openLoginModal}>
                        {t('登录后继续')}
                      </Button>
                    </div>
                  </div>
                )}
                {errors.accountId && (
                  <p className="text-xs text-red-500">{errors.accountId}</p>
                )}
              </div>

              {/* 02 反馈大类（第一题：先选大类，再展开对应问题框） */}
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <span className="text-red-500">*</span>
                  <span className="font-semibold text-[var(--text-tertiary)]">02</span>
                  {t('您想反馈的是？')}
                </Label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCategory('suggestion');
                      if (category === 'bug') {
                        setBugFrequency(''); setBugExpected('');
                      }
                    }}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-xl border px-4 py-4 text-left transition-colors',
                      category === 'suggestion'
                        ? 'border-[var(--text-primary)] bg-[var(--surface-muted)]'
                        : 'border-[var(--border-strong)] bg-white hover:border-[var(--text-primary)]/40',
                    )}
                  >
                    <span className="text-sm font-medium text-[var(--text-primary)]">{t('建议/反馈')}</span>
                    <span className="text-xs text-[var(--text-tertiary)]">{t('功能建议、体验问题、吐槽等')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCategory('bug');
                      if (category === 'suggestion') {
                        setFeedbackType(''); setOtherText(''); setProfileSource(''); setProfileRole('');
                        setProfileAiGoal(''); setProfileFrequency(''); setProfileIndustry('');
                      }
                    }}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-xl border px-4 py-4 text-left transition-colors',
                      category === 'bug'
                        ? 'border-[var(--text-primary)] bg-[var(--surface-muted)]'
                        : 'border-[var(--border-strong)] bg-white hover:border-[var(--text-primary)]/40',
                    )}
                  >
                    <span className="text-sm font-medium text-[var(--text-primary)]">{t('Bug/异常')}</span>
                    <span className="text-xs text-[var(--text-tertiary)]">{t('程序出错、崩溃、异常等，需排障')}</span>
                  </button>
                </div>
                {errors.category && (
                  <p className="text-xs text-red-500">{errors.category}</p>
                )}
              </div>

              {category === 'suggestion' && (
                <div className="space-y-10">
                  {/* 调研问卷（必填） */}
                  <div className="space-y-4 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-muted)]/50 px-4 py-4">
                    <p className="flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
                      <span className="font-semibold text-[var(--text-tertiary)]">{localizeSupportLabel('调研问卷', activePublicLocale)}</span>
                      <span className="text-xs text-red-500">*</span>
                      {t('帮助我们更懂你')}
                    </p>
                    <div className="space-y-5 pt-0">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-[var(--text-tertiary)]">{t('您从哪里了解到 LightVela？')}</Label>
                          <select
                            value={profileSource}
                            onChange={(e) => setProfileSource(e.target.value as ProfileSource | '')}
                            className={cn(
                              'w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-[var(--text-primary)]',
                              errors.profileSource ? 'border-red-400' : 'border-[var(--border-strong)]',
                            )}
                          >
                            <option value="">{t('下拉选择')}</option>
                            {profileSourceOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>{localizeSupportLabel(opt.label, activePublicLocale)}</option>
                            ))}
                          </select>
                          {errors.profileSource && <p className="text-xs text-red-500">{errors.profileSource}</p>}
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-[var(--text-tertiary)]">{t('您的角色是？')}</Label>
                          <select
                            value={profileRole}
                            onChange={(e) => setProfileRole(e.target.value as ProfileRole | '')}
                            className={cn(
                              'w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-[var(--text-primary)]',
                              errors.profileRole ? 'border-red-400' : 'border-[var(--border-strong)]',
                            )}
                          >
                            <option value="">{t('下拉选择')}</option>
                            {profileRoleOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>{localizeSupportLabel(opt.label, activePublicLocale)}</option>
                            ))}
                          </select>
                          {errors.profileRole && <p className="text-xs text-red-500">{errors.profileRole}</p>}
                        </div>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-[var(--text-tertiary)]">{t('您平时使用 LightVela 的频率？')}</Label>
                          <select
                            value={profileFrequency}
                            onChange={(e) => setProfileFrequency(e.target.value as ProfileFrequency | '')}
                            className={cn(
                              'w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-[var(--text-primary)]',
                              errors.profileFrequency ? 'border-red-400' : 'border-[var(--border-strong)]',
                            )}
                          >
                            <option value="">{t('下拉选择')}</option>
                            {profileFrequencyOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>{localizeSupportLabel(opt.label, activePublicLocale)}</option>
                            ))}
                          </select>
                          {errors.profileFrequency && <p className="text-xs text-red-500">{errors.profileFrequency}</p>}
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-[var(--text-tertiary)]">{t('您所在的行业是？')}</Label>
                          <select
                            value={profileIndustry}
                            onChange={(e) => setProfileIndustry(e.target.value as ProfileIndustry | '')}
                            className={cn(
                              'w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-[var(--text-primary)]',
                              errors.profileIndustry ? 'border-red-400' : 'border-[var(--border-strong)]',
                            )}
                          >
                            <option value="">{t('下拉选择')}</option>
                            {profileIndustryOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>{localizeSupportLabel(opt.label, activePublicLocale)}</option>
                            ))}
                          </select>
                          {errors.profileIndustry && <p className="text-xs text-red-500">{errors.profileIndustry}</p>}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-[var(--text-tertiary)]">{t('您希望用 AI 来做什么？')}</Label>
                        <Input
                          type="text"
                          value={profileAiGoal}
                          onChange={(e) => setProfileAiGoal(e.target.value)}
                          placeholder={t('例如：写代码、做设计、整理资料、学习新东西…')}
                          className={errors.profileAiGoal ? 'border-red-400 focus-visible:ring-red-400/20' : ''}
                        />
                        {errors.profileAiGoal && <p className="text-xs text-red-500">{errors.profileAiGoal}</p>}
                      </div>
                    </div>
                  </div>

                  {/* 细分类型 */}
                  <div className="space-y-3">
                    <Label className="flex items-center gap-1.5">
                      <span className="text-red-500">*</span>
                      {t('具体是哪一类？')}
                    </Label>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {suggestionFeedbackOptions.map((opt) => {
                        const selected = feedbackType === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => { setFeedbackType(opt.value); if (opt.value !== 'other') setOtherText(''); }}
                            className={cn(
                              'flex items-center gap-2 rounded-xl border px-3 py-3 text-left text-sm transition-colors',
                              selected
                                ? 'border-[var(--text-primary)] bg-[var(--surface-muted)] font-medium text-[var(--text-primary)]'
                                : 'border-[var(--border-strong)] bg-white text-[var(--text-secondary)] hover:border-[var(--text-primary)]/40',
                            )}
                          >
                            <span
                              className={cn(
                                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                                selected ? 'border-[var(--text-primary)]' : 'border-[var(--border-strong)]',
                              )}
                            >
                              {selected && <span className="h-2 w-2 rounded-full bg-[var(--text-primary)]" />}
                            </span>
                            <span>{opt.label}</span>
                          </button>
                        );
                      })}
                    </div>
                    {feedbackType === 'other' && (
                      <Input
                        type="text"
                        value={otherText}
                        onChange={(e) => setOtherText(e.target.value)}
                        placeholder={t('请填写具体类型')}
                        className={errors.otherText ? 'border-red-400 focus-visible:ring-red-400/20' : ''}
                      />
                    )}
                    {errors.feedbackType && (
                      <p className="text-xs text-red-500">{errors.feedbackType}</p>
                    )}
                    {errors.otherText && (
                      <p className="text-xs text-red-500">{errors.otherText}</p>
                    )}
                  </div>

                  {/* 描述 */}
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1.5">
                      <span className="text-red-500">*</span>
                      {t('您具体希望反馈的问题或建议是？')}
                    </Label>
                    <p className="text-xs text-[var(--text-tertiary)]">
                      {t('您可以在此填写详细说明')}
                    </p>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={6}
                      placeholder={t('请输入')}
                      className={errors.description ? 'border-red-400 focus-visible:ring-red-400/20' : ''}
                    />
                    {errors.description && (
                      <p className="text-xs text-red-500">{errors.description}</p>
                    )}
                  </div>
                </div>
              )}

              {category === 'bug' && (
                <div className="space-y-10">
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1.5">
                      <span className="text-red-500">*</span>
                      {t('请描述您遇到的问题现象')}
                    </Label>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={5}
                      placeholder={t('例如：在「对话」页面，发送消息后 Agent 无响应/报错，页面卡住…')}
                      className={errors.description ? 'border-red-400 focus-visible:ring-red-400/20' : ''}
                    />
                    {errors.description && (
                      <p className="text-xs text-red-500">{errors.description}</p>
                    )}
                  </div>

                  <div className="space-y-3">
                    <Label className="flex items-center gap-1.5">
                      <span className="text-red-500">*</span>
                      {t('发生频率')}
                    </Label>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {bugFrequencyOptions.map((opt) => {
                        const selected = bugFrequency === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setBugFrequency(opt.value)}
                            className={cn(
                              'rounded-xl border px-3 py-2.5 text-sm transition-colors',
                              selected
                                ? 'border-[var(--text-primary)] bg-[var(--surface-muted)] font-medium text-[var(--text-primary)]'
                                : 'border-[var(--border-strong)] bg-white text-[var(--text-secondary)] hover:border-[var(--text-primary)]/40',
                            )}
                          >
                            {localizeSupportLabel(opt.label, activePublicLocale)}
                          </button>
                        );
                      })}
                    </div>
                    {errors.bugFrequency && (
                      <p className="text-xs text-red-500">{errors.bugFrequency}</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs text-[var(--text-tertiary)]">{t('期望结果')}</Label>
                    <Textarea
                      value={bugExpected}
                      onChange={(e) => setBugExpected(e.target.value)}
                      rows={3}
                      placeholder={t('您期望发生什么')}
                    />
                  </div>
                </div>
              )}

              {/* 03 联系方式（可选） */}
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <span className="font-semibold text-[var(--text-tertiary)]">03</span>
                  {t('您的联系方式（选填）')}
                </Label>
                <div className="space-y-1 text-xs text-[var(--text-tertiary)]">
                  <p>{pageCopy.contactHintPrimary}</p>
                  <p>{pageCopy.contactHintExamples}</p>
                </div>
                <Input
                  type="text"
                  value={contactInfo}
                  onChange={(e) => setContactInfo(e.target.value)}
                  placeholder={t('微信号 / 邮箱（选填）')}
                />
              </div>

              {/* 04 文件上传 */}
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <span className="font-semibold text-[var(--text-tertiary)]">04</span>
                  {t('如您有需要上传的图片或文件，可添加至此处')}
                </Label>
                <div
                  className={cn(
                    'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 transition-colors',
                    isAuthenticated && userId
                      ? 'cursor-pointer border-[var(--border-strong)] bg-white hover:border-[var(--text-primary)]/30 hover:bg-[var(--surface-muted)]'
                      : 'cursor-pointer border-[var(--border-strong)] bg-[var(--surface-muted)]/70',
                  )}
                  onClick={handleUploadTrigger}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleUploadTrigger();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border-strong)] bg-white text-[var(--text-primary)]">
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {isAuthenticated && userId
                      ? t('点击上传或拖拽图片/文件至此处')
                      : t('请先登录，登录后可上传图片或文件')}
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  disabled={!isAuthenticated || !userId}
                  className="hidden"
                  onChange={handleFileChange}
                />
                <p className="text-xs text-[var(--text-tertiary)]">
                  ⓘ {isAuthenticated && userId
                    ? t('单个图片/文件大小不超过300MB')
                    : t('登录跳转会刷新页面，为避免文件丢失，请先登录后再上传附件')}
                </p>

                {/* 已上传文件列表 */}
                {files.length > 0 && (
                  <ul className="space-y-2">
                    {files.map((f, i) => (
                      <li
                        key={f.name + i}
                        className="flex items-center justify-between rounded-xl bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]"
                      >
                        <span className="truncate">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => removeFile(i)}
                          className="ml-2 text-red-500 hover:text-red-600"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* 提交按钮 */}
              <div className="flex flex-col items-center gap-3 pt-4">
                {submitError && (
                  <p className="text-sm text-red-500">{submitError}</p>
                )}
                <Button type="submit" disabled={isSubmitting} size="lg" className="px-12">
                  {isSubmitting
                    ? t('提交中...')
                    : isAuthenticated && userId
                      ? t('提交')
                      : !authReady
                        ? t('正在读取登录状态...')
                        : t('登录后提交')}
                </Button>
              </div>
            </form>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <LegalFooter />
      <LoginModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={() => {
          setShowLoginModal(false);
          setSubmitError('');
        }}
      />
    </div>
  );
}

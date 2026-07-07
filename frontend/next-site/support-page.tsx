/**
 * Support / LightVela Product Feedback — 用户端问卷表单页面
 * ──────────────────────────────────────────────────────────────
 * 对照中文问卷内容 1:1 做英文国际站版本。
 */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

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
import { isGlobal } from '@/lib/region';
import { cn } from '@/lib/utils';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
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
  feedbackType: FeedbackType | '';
  otherText: string;
  description: string;
  contactInfo: string;
  profileSource: string;
  profileRole: string;
  profileAiGoal: string;
  profileFrequency: string;
  profileIndustry: string;
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
  const { i18n } = useTranslation();
  const { session, authReady, isAuthenticated } = useSession();
  const userId = session.user?.id?.trim() ?? '';
  const isEnglish = isGlobal && !i18n.language.startsWith('zh');
  const activePublicLocale: PublicSiteLocale = isGlobal
    ? (isEnglish ? 'en-US' : 'zh-SG')
    : 'zh-CN';
  const pageCopy = {
    pageTitle: isEnglish ? 'Product Feedback' : t('产品反馈'),
    pageDesc: isEnglish
      ? 'Share your experience, report bugs, or suggest features to help us improve LightVela.'
      : t('您可以将使用 LightVela 过程中的任何体验问题或需求建议告诉我们，帮助我们变得更好！'),
    contactHintPrimary: isEnglish
      ? "Leave an email if you'd like a follow-up."
      : '可留下微信号或邮箱；',
    contactHintExamples: isEnglish
      ? 'Email example: 1234@gmail.com.'
      : '微信号如：lightvela_demo，邮箱如：1234@gmail.com',
  };

  const effectiveUserId = userId;
  /* Form state */
  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [feedbackType, setFeedbackType] = useState<FeedbackType | ''>('');
  const [otherText, setOtherText] = useState('');
  const [description, setDescription] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  // 用户画像（调研问卷，必填）——仅收集高信号字段，建议/反馈类使用
  const [profileSource, setProfileSource] = useState('');
  const [profileRole, setProfileRole] = useState('');
  const [profileAiGoal, setProfileAiGoal] = useState('');
  const [profileFrequency, setProfileFrequency] = useState('');
  const [profileIndustry, setProfileIndustry] = useState('');
  // Bug 类排障信息
  const [bugFrequency, setBugFrequency] = useState('');
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

  // Bug 类发生频率选项
  const bugFrequencyOptions: { value: string; label: string }[] = [
    { value: 'always', label: isEnglish ? 'Every time' : '每次必现' },
    { value: 'often', label: isEnglish ? 'Often' : '经常发生' },
    { value: 'sometimes', label: isEnglish ? 'Sometimes' : '偶尔发生' },
    { value: 'once', label: isEnglish ? 'First time' : '仅出现一次' },
  ];

  // 调研问卷（选填）用户画像选项 —— 仅收集高信号字段，最少问题拿最多信息
  const profileSourceOptions: { value: string; label: string }[] = [
    { value: 'search', label: isEnglish ? 'Search engine' : '搜索引擎' },
    { value: 'friend', label: isEnglish ? 'Friend / colleague' : '朋友/同事推荐' },
    { value: 'social', label: isEnglish ? 'Social media' : '社交媒体' },
    { value: 'official', label: isEnglish ? 'Official site / docs' : '官网/文档' },
    { value: 'community', label: isEnglish ? 'Community / forum' : '社区/论坛' },
    { value: 'ad', label: isEnglish ? 'Ads' : '广告投放' },
    { value: 'media', label: isEnglish ? 'News / media' : '新闻/媒体' },
    { value: 'other', label: isEnglish ? 'Other' : '其他' },
  ];
  const profileRoleOptions: { value: string; label: string }[] = [
    { value: 'student', label: isEnglish ? 'Student' : '学生' },
    { value: 'developer', label: isEnglish ? 'Developer' : '开发者' },
    { value: 'designer', label: isEnglish ? 'Designer' : '设计师' },
    { value: 'pm', label: isEnglish ? 'Product Manager' : '产品经理' },
    { value: 'founder', label: isEnglish ? 'Founder / Entrepreneur' : '创业者' },
    { value: 'ops', label: isEnglish ? 'Operations / Other' : '运营/其他' },
    { value: 'researcher', label: isEnglish ? 'Researcher / Academic' : '科研/学术' },
    { value: 'engineer', label: isEnglish ? 'Engineer (non-dev)' : '工程师（非开发）' },
    { value: 'marketer', label: isEnglish ? 'Marketer' : '市场/营销' },
    { value: 'sales', label: isEnglish ? 'Sales / BD' : '销售/商务' },
    { value: 'hr', label: isEnglish ? 'HR / Recruiting' : '人力/招聘' },
    { value: 'writer', label: isEnglish ? 'Writer / Content' : '写作/内容' },
    { value: 'teacher', label: isEnglish ? 'Teacher / Educator' : '教师/教育' },
    { value: 'freelancer', label: isEnglish ? 'Freelancer' : '自由职业者' },
    { value: 'analyst', label: isEnglish ? 'Analyst / Consultant' : '分析师/咨询' },
    { value: 'manager', label: isEnglish ? 'Team Lead / Manager' : '团队负责人/管理者' },
    { value: 'other', label: isEnglish ? 'Other' : '其他' },
  ];
  const profileFrequencyOptions: { value: string; label: string }[] = [
    { value: 'daily', label: isEnglish ? 'Daily' : '几乎每天' },
    { value: 'weekly', label: isEnglish ? 'Several times a week' : '每周几次' },
    { value: 'monthly', label: isEnglish ? 'A few times a month' : '每月几次' },
    { value: 'occasionally', label: isEnglish ? 'Occasionally' : '偶尔用用' },
    { value: 'first', label: isEnglish ? 'Just started' : '刚接触' },
  ];
  const profileIndustryOptions: { value: string; label: string }[] = [
    { value: 'internet', label: isEnglish ? 'Internet / Software' : '互联网/软件' },
    { value: 'ai', label: isEnglish ? 'AI / Tech' : 'AI/科技' },
    { value: 'education', label: isEnglish ? 'Education' : '教育' },
    { value: 'finance', label: isEnglish ? 'Finance / Insurance' : '金融/保险' },
    { value: 'media', label: isEnglish ? 'Media / Content' : '媒体/内容' },
    { value: 'ecommerce', label: isEnglish ? 'E-commerce / Retail' : '电商/零售' },
    { value: 'healthcare', label: isEnglish ? 'Healthcare / Biotech' : '医疗/生物' },
    { value: 'manufacturing', label: isEnglish ? 'Manufacturing / Hardware' : '制造/硬件' },
    { value: 'gaming', label: isEnglish ? 'Gaming / Entertainment' : '游戏/文娱' },
    { value: 'government', label: isEnglish ? 'Government / Public' : '政府/公共' },
    { value: 'research', label: isEnglish ? 'Research / Academic' : '科研/学术' },
    { value: 'freelance', label: isEnglish ? 'Self-employed / Freelance' : '自由职业/个体' },
    { value: 'student', label: isEnglish ? 'Student' : '学生' },
    { value: 'other', label: isEnglish ? 'Other' : '其他' },
  ];

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
                      <span className="font-semibold text-[var(--text-tertiary)]">调研问卷</span>
                      <span className="text-xs text-red-500">*</span>
                      {t('帮助我们更懂你')}
                    </p>
                    <div className="space-y-5 pt-0">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-[var(--text-tertiary)]">{t('您从哪里了解到 LightVela？')}</Label>
                          <select
                            value={profileSource}
                            onChange={(e) => setProfileSource(e.target.value)}
                            className={cn(
                              'w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-[var(--text-primary)]',
                              errors.profileSource ? 'border-red-400' : 'border-[var(--border-strong)]',
                            )}
                          >
                            <option value="">{t('下拉选择')}</option>
                            {profileSourceOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                          {errors.profileSource && <p className="text-xs text-red-500">{errors.profileSource}</p>}
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-[var(--text-tertiary)]">{t('您的角色是？')}</Label>
                          <select
                            value={profileRole}
                            onChange={(e) => setProfileRole(e.target.value)}
                            className={cn(
                              'w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-[var(--text-primary)]',
                              errors.profileRole ? 'border-red-400' : 'border-[var(--border-strong)]',
                            )}
                          >
                            <option value="">{t('下拉选择')}</option>
                            {profileRoleOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
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
                            onChange={(e) => setProfileFrequency(e.target.value)}
                            className={cn(
                              'w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-[var(--text-primary)]',
                              errors.profileFrequency ? 'border-red-400' : 'border-[var(--border-strong)]',
                            )}
                          >
                            <option value="">{t('下拉选择')}</option>
                            {profileFrequencyOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                          {errors.profileFrequency && <p className="text-xs text-red-500">{errors.profileFrequency}</p>}
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-[var(--text-tertiary)]">{t('您所在的行业是？')}</Label>
                          <select
                            value={profileIndustry}
                            onChange={(e) => setProfileIndustry(e.target.value)}
                            className={cn(
                              'w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-[var(--text-primary)]',
                              errors.profileIndustry ? 'border-red-400' : 'border-[var(--border-strong)]',
                            )}
                          >
                            <option value="">{t('下拉选择')}</option>
                            {profileIndustryOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
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
                            {opt.label}
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
                  placeholder={isEnglish ? t('邮箱（选填）') : t('微信号 / 邮箱（选填）')}
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
 
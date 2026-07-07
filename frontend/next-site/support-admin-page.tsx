/**
 * Support Admin / Feedback Console（独立后台）
 * ──────────────────────────────────────────────────────────────
 * 直接使用 cos-js-sdk-v5 从腾讯云 COS 拉取反馈数据（无后端 API 依赖）。
 * 独立页面，不依赖产品前端导航/布局。
 */
'use client';

import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LoginModal } from '@/components/site/login-modal';
import { useSession } from '@/contexts/session-context';
import { isGlobal } from '@/lib/region';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import type { SupportFeedbackRecord } from '@/lib/support-feedback-cos-client';

import { renderNextLanguageSwitcher } from './language-switcher';

/* ──────────────────────────────────────────────────────────
 * 常量（与 support-page.tsx / COS 反馈记录对齐，避免魔法字符串）
 * ────────────────────────────────────────────────────────── */

/** 反馈类型枚举值 */
const FEEDBACK_TYPE = {
  ExperienceIssue: 'experience_issue',
  BugReport: 'bug_report',
  FeatureRequest: 'feature_request',
  Rant: 'rant',
  Performance: 'performance',
  Billing: 'billing',
  Security: 'security',
  Docs: 'docs',
  Other: 'other',
} as const;

/** 类型筛选下拉的「全部」选项值 */
const FEEDBACK_FILTER_ALL = 'all';

/* ──────────────────────────────────────────────────────────
 * 辅助函数
 * ────────────────────────────────────────────────────────── */

function formatDate(iso: string, locale: 'zh-CN' | 'en-US'): string {
  return new Date(iso).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function getFeedbackTypeLabel(type: string, otherText: string | null, globalSite: boolean): string {
  switch (type) {
    case FEEDBACK_TYPE.ExperienceIssue:
      return globalSite ? 'Experience issue' : '体验问题反馈';
    case FEEDBACK_TYPE.BugReport:
      return globalSite ? 'Bug report' : 'Bug/异常';
    case FEEDBACK_TYPE.FeatureRequest:
      return globalSite ? 'Feature request' : '产品功能建议';
    case FEEDBACK_TYPE.Rant:
      return globalSite ? 'Product rant' : '产品吐槽';
    case FEEDBACK_TYPE.Performance:
      return globalSite ? 'Performance issue' : '性能/卡顿问题';
    case FEEDBACK_TYPE.Billing:
      return globalSite ? 'Billing issue' : '账单/费用问题';
    case FEEDBACK_TYPE.Security:
      return globalSite ? 'Security / privacy issue' : '安全/隐私问题';
    case FEEDBACK_TYPE.Docs:
      return globalSite ? 'Docs / help issue' : '文档/帮助问题';
    case FEEDBACK_TYPE.Other: {
      const label = globalSite ? 'Other' : '其他';
      return otherText?.trim() ? `${label} · ${otherText.trim()}` : label;
    }
    default:
      return type;
  }
}

function getCategoryLabel(category: string | null | undefined, globalSite: boolean): string {
  if (category === 'bug') return globalSite ? 'Bug' : 'Bug/异常';
  if (category === 'suggestion') return globalSite ? 'Suggestion' : '建议/反馈';
  return globalSite ? 'Uncategorized' : '未分类';
}

/* ──────────────────────────────────────────────────────────
 * 主组件
 * ────────────────────────────────────────────────────────── */

export function SupportAdminPage(): ReactElement {
  const { i18n } = useTranslation();
  const { authReady, isAuthenticated, session } = useSession();
  const isEnglish = isGlobal && !i18n.language.startsWith('zh');
  const locale: 'zh-CN' | 'en-US' = isEnglish ? 'en-US' : 'zh-CN';
  const activePublicLocale: PublicSiteLocale = isGlobal
    ? (isEnglish ? 'en-US' : 'zh-SG')
    : 'zh-CN';
  const [showLoginModal, setShowLoginModal] = useState(false);
  const copy = {
    eyebrow: isEnglish ? 'Feedback Console' : '反馈查询后台',
    title: isEnglish ? 'LightVela Feedback Console' : 'LightVela 反馈查询后台',
    siteBadge: isGlobal ? (isEnglish ? 'Global site' : '国际站') : '国内站',
    goToSupport: isEnglish ? 'Open feedback form' : '前往用户反馈页',
    countText: (count: number) => (isEnglish ? `${count} feedback items` : `共 ${count} 条反馈`),
    refresh: isEnglish ? 'Refresh' : '刷新列表',
    loading: isEnglish ? 'Loading...' : '加载中...',
    back: isEnglish ? 'Back to list' : '返回列表',
    accountId: isEnglish ? 'Account ID' : '账号 ID',
    contact: isEnglish ? 'Contact' : '联系方式',
    source: isEnglish ? 'Source' : '反馈来源',
    submittedAt: isEnglish ? 'Submitted at' : '提交时间',
    details: isEnglish ? 'Feedback details' : '反馈正文',
    attachments: isEnglish ? 'Attachments' : '附件',
    noAttachments: isEnglish ? 'No attachments uploaded' : '该反馈没有上传附件',
    openAttachment: isEnglish ? 'Open' : '打开附件',
    searchPlaceholder: isEnglish
      ? 'Search by feedback ID, account ID, title, or description...'
      : '搜索反馈 ID、账号 ID、标题或正文...',
    allTypes: isEnglish ? 'All types' : '全部类型',
    feedback: isEnglish ? 'Feedback' : '反馈',
    type: isEnglish ? 'Type' : '类型',
    fileCount: isEnglish ? 'Files' : '附件',
    action: isEnglish ? 'Action' : '操作',
    emptyLoaded: isEnglish ? 'No feedback records yet' : '暂无反馈数据',
    emptyLoading: isEnglish ? 'Loading...' : '正在加载...',
    viewDetails: isEnglish ? 'View details' : '查看详情',
    unknownValue: '—',
    configError: isEnglish
      ? 'Feedback console is not available. Please check the backend API connection.'
      : '反馈后台暂不可用：请检查后端服务连接',
    listError: isEnglish ? 'Failed to load feedback list' : '读取反馈列表失败',
    signedUrlError: isEnglish ? 'Failed to generate attachment link' : '无法生成附件访问链接',
    openAttachmentError: isEnglish ? 'Unable to open attachment' : '无法打开附件',
  };

  const [records, setRecords] = useState<SupportFeedbackRecord[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState<string>(FEEDBACK_FILTER_ALL);
  const [categoryFilter, setCategoryFilter] = useState<string>(FEEDBACK_FILTER_ALL);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<SupportFeedbackRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const filteredRecords = useMemo(() => {
    return records.filter((record) => {
      if (categoryFilter !== FEEDBACK_FILTER_ALL && record.category !== categoryFilter) return false;
      if (feedbackFilter !== FEEDBACK_FILTER_ALL && record.feedbackType !== feedbackFilter) return false;
      if (!searchQuery.trim()) return true;

      const query = searchQuery.trim().toLowerCase();
      return Boolean(
        record.id?.toLowerCase().includes(query)
        || record.accountId?.toLowerCase().includes(query)
        || record.subject?.toLowerCase().includes(query)
        || record.description?.toLowerCase().includes(query),
      );
    });
  }, [categoryFilter, feedbackFilter, records, searchQuery]);

  const feedbackTypes = useMemo(() => {
    return Array.from(new Set(records.map((record) => record.feedbackType)));
  }, [records]);

  const loadRecords = async () => {
    setIsLoading(true);
    setLoadError('');

    try {
      const mod = await import('@/lib/support-feedback-cos-client');
      if (!mod.isSupportCosConfigured()) {
        throw new Error(copy.configError);
      }

      const list = await mod.listSupportFeedback();
      setRecords(list);
      setSelectedRecord(null);
      setHasLoadedOnce(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : copy.listError);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!authReady || !isAuthenticated) {
      return;
    }
    void loadRecords();
  }, [authReady, isAuthenticated]);

  const openAttachment = async (storageKey: string) => {
    try {
      const mod = await import('@/lib/support-feedback-cos-client');
      const url = await mod.getSignedAttachmentUrl(storageKey);
      if (!url) {
        throw new Error(copy.signedUrlError);
      }
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : copy.openAttachmentError);
    }
  };

  // 未登录时显示登录提示
  if (authReady && !isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">
            {isEnglish ? 'Sign in required' : '请先登录'}
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            {isEnglish ? 'You need to sign in to access the feedback console.' : '登录后即可访问反馈查询后台。'}
          </p>
          <button
            type="button"
            onClick={() => setShowLoginModal(true)}
            className="mt-6 rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800"
          >
            {isEnglish ? 'Sign in' : '登录'}
          </button>
          <LoginModal
            open={showLoginModal}
            onClose={() => setShowLoginModal(false)}
            onSuccess={() => setShowLoginModal(false)}
          />
        </div>
      </div>
    );
  }

  // 登录态加载中
  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <div className="text-sm text-slate-400">
          {isEnglish ? 'Checking login status...' : '正在检查登录状态...'}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
              {copy.eyebrow}
            </p>
            <h1 className="mt-1 text-lg font-bold text-slate-900">
              {copy.title}
              <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs font-normal text-blue-700">
                {copy.siteBadge}
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {isGlobal ? renderNextLanguageSwitcher({
              activeLocale: activePublicLocale,
              reloadAfterSwitch: false,
              variant: 'dropdown',
            }) : null}
            {session.user && (
              <span className="text-xs text-slate-400">
                {session.user.name || session.user.id}
              </span>
            )}
            <a
              href="/support/"
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50"
            >
              {copy.goToSupport}
            </a>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-500">{copy.countText(filteredRecords.length)}</p>
            <button
              type="button"
              onClick={() => void loadRecords()}
              disabled={isLoading}
              className="w-fit rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isLoading ? copy.loading : copy.refresh}
            </button>
          </div>

          {loadError && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              <span>{loadError}</span>
              <button
                type="button"
                onClick={() => setShowLoginModal(true)}
                className="shrink-0 text-xs font-medium text-red-700 underline hover:text-red-800"
              >
                {isEnglish ? 'Re-login' : '重新登录'}
              </button>
            </div>
          )}
        </div>

        {selectedRecord ? (
          <div className="space-y-5">
            <button
              type="button"
              onClick={() => setSelectedRecord(null)}
              className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              {copy.back}
            </button>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-slate-400">{selectedRecord.id}</span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {getFeedbackTypeLabel(selectedRecord.feedbackType, selectedRecord.otherText, isGlobal)}
                </span>
                <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600">
                  {getCategoryLabel(selectedRecord.category, isGlobal)}
                </span>
              </div>

              <h2 className="mt-3 text-xl font-semibold text-slate-900">{selectedRecord.subject}</h2>

              <div className="mt-4 grid gap-3 text-sm text-slate-600 md:grid-cols-3 lg:grid-cols-4">
                <div>
                  <p className="text-xs text-slate-400">{copy.accountId}</p>
                  <p className="mt-1 font-medium text-slate-800">{selectedRecord.accountId}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">{copy.contact}</p>
                  <p className="mt-1 font-medium text-slate-800">{selectedRecord.contactInfo || copy.unknownValue}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">{copy.source}</p>
                  <p className="mt-1 font-medium text-slate-800">{selectedRecord.source}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">{copy.submittedAt}</p>
                  <p className="mt-1 font-medium text-slate-800">{formatDate(selectedRecord.createdAt, locale)}</p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-900">{copy.details}</h3>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                {selectedRecord.description}
              </p>
            </div>

            {selectedRecord.category === 'bug' && selectedRecord.bugInfo && (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-sm font-semibold text-slate-900">{isGlobal ? 'Troubleshooting info' : '排障信息'}</h3>
                <dl className="mt-3 space-y-3 text-sm text-slate-700">
                  {selectedRecord.bugInfo.frequency && (
                    <div>
                      <dt className="text-xs text-slate-400">{isGlobal ? 'Frequency' : '发生频率'}</dt>
                      <dd className="mt-1">{selectedRecord.bugInfo.frequency}</dd>
                    </div>
                  )}
                  {selectedRecord.bugInfo.expected && (
                    <div>
                      <dt className="text-xs text-slate-400">{isGlobal ? 'Expected' : '期望结果'}</dt>
                      <dd className="mt-1 whitespace-pre-wrap leading-6">{selectedRecord.bugInfo.expected}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            {selectedRecord.profile && (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-sm font-semibold text-slate-900">{isGlobal ? 'User profile' : '用户画像'}</h3>
                <dl className="mt-3 grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
                  {selectedRecord.profile.source && (
                    <div>
                      <dt className="text-xs text-slate-400">{isGlobal ? 'How did they find us' : '了解渠道'}</dt>
                      <dd className="mt-1">{selectedRecord.profile.source}</dd>
                    </div>
                  )}
                  {selectedRecord.profile.role && (
                    <div>
                      <dt className="text-xs text-slate-400">{isGlobal ? 'Role' : '角色'}</dt>
                      <dd className="mt-1">{selectedRecord.profile.role}</dd>
                    </div>
                  )}
                  {selectedRecord.profile.frequency && (
                    <div>
                      <dt className="text-xs text-slate-400">{isGlobal ? 'Usage frequency' : '使用频率'}</dt>
                      <dd className="mt-1">{selectedRecord.profile.frequency}</dd>
                    </div>
                  )}
                  {selectedRecord.profile.industry && (
                    <div>
                      <dt className="text-xs text-slate-400">{isGlobal ? 'Industry' : '行业'}</dt>
                      <dd className="mt-1">{selectedRecord.profile.industry}</dd>
                    </div>
                  )}
                  {selectedRecord.profile.aiGoal && (
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-slate-400">{isGlobal ? 'AI use case' : 'AI 用途'}</dt>
                      <dd className="mt-1 whitespace-pre-wrap leading-6">{selectedRecord.profile.aiGoal}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-900">{copy.attachments}</h3>
              {selectedRecord.attachments.length === 0 ? (
                <p className="mt-3 text-sm text-slate-400">{copy.noAttachments}</p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {selectedRecord.attachments.map((attachment) => (
                    <li
                      key={attachment.storageKey}
                      className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-700"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="font-medium text-slate-900">{attachment.fileName}</p>
                          <p className="mt-1 text-xs text-slate-400">
                            {attachment.contentType || 'application/octet-stream'}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="rounded-full bg-white px-2.5 py-1 text-xs text-slate-500">
                            {formatBytes(attachment.size)}
                          </span>
                          <button
                            type="button"
                            onClick={() => void openAttachment(attachment.storageKey)}
                            className="text-xs font-medium text-blue-600 hover:text-blue-700"
                          >
                            {copy.openAttachment}
                          </button>
                        </div>
                      </div>
                      <p className="mt-2 break-all font-mono text-[11px] text-slate-400">{attachment.storageKey}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
              <div className="relative min-w-[260px] flex-1">
                <svg
                  className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={copy.searchPlaceholder}
                  className="w-full rounded-lg border border-slate-200 py-2 pl-10 pr-4 text-sm outline-none transition-colors focus:border-blue-500"
                />
              </div>

              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
              >
                <option value={FEEDBACK_FILTER_ALL}>{isGlobal ? 'All categories' : '全部大类'}</option>
                <option value="suggestion">{isGlobal ? 'Suggestion' : '建议/反馈'}</option>
                <option value="bug">{isGlobal ? 'Bug' : 'Bug/异常'}</option>
              </select>

              <select
                value={feedbackFilter}
                onChange={(event) => setFeedbackFilter(event.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
              >
                <option value={FEEDBACK_FILTER_ALL}>{copy.allTypes}</option>
                {feedbackTypes.map((type) => (
                  <option key={type} value={type}>
                    {getFeedbackTypeLabel(type, null, isGlobal)}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-100 bg-slate-50">
                  <tr>
                    <th className="px-5 py-3 text-xs font-medium uppercase text-slate-500">{copy.feedback}</th>
                    <th className="px-5 py-3 text-xs font-medium uppercase text-slate-500">{copy.accountId}</th>
                    <th className="px-5 py-3 text-xs font-medium uppercase text-slate-500">{copy.type}</th>
                    <th className="px-5 py-3 text-xs font-medium uppercase text-slate-500">{copy.fileCount}</th>
                    <th className="px-5 py-3 text-xs font-medium uppercase text-slate-500">{copy.submittedAt}</th>
                    <th className="px-5 py-3 text-xs font-medium uppercase text-slate-500">{copy.action}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {!isLoading && filteredRecords.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-5 py-12 text-center text-slate-400">
                        {hasLoadedOnce ? copy.emptyLoaded : copy.emptyLoading}
                      </td>
                    </tr>
                  ) : (
                    filteredRecords.map((record) => (
                      <tr key={record.id} className="hover:bg-slate-50">
                        <td className="px-5 py-4">
                          <div>
                            <p className="font-medium text-slate-900">{record.subject}</p>
                            <p className="mt-1 line-clamp-2 text-xs text-slate-500">{record.description}</p>
                            <p className="mt-1 font-mono text-[11px] text-slate-300">{record.id}</p>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-xs text-slate-600">{record.accountId}</td>
                        <td className="px-5 py-4">
                          <div className="flex flex-col gap-1">
                            <span className="w-fit rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                              {getFeedbackTypeLabel(record.feedbackType, record.otherText, isGlobal)}
                            </span>
                            <span className="w-fit rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600">
                              {getCategoryLabel(record.category, isGlobal)}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-xs text-slate-500">{record.attachments.length}</td>
                        <td className="px-5 py-4 whitespace-nowrap text-xs text-slate-500">
                          {formatDate(record.createdAt, locale)}
                        </td>
                        <td className="px-5 py-4">
                          <button
                            type="button"
                            onClick={() => setSelectedRecord(record)}
                            className="text-xs font-medium text-blue-600 hover:text-blue-700"
                          >
                            {copy.viewDetails}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <LoginModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={() => setShowLoginModal(false)}
      />
    </div>
  );
}

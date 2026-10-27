import { LocaleRuntime } from '@opencraft/i18n';

const english = {
  "title": "Accounts and members",
  "intro": "Manage your account, sign-in methods and server members.",
  "setup": "Set up OpenCraft",
  "mode": "Use this device to",
  "web": "Provide a remote WebUI",
  "desktop": "Work on this device",
  "connect": "Connect to another server",
  "proof": "Installer setup code",
  "username": "Username",
  "password": "Password (at least 12 characters)",
  "remote": "Server address",
  "continue": "Continue",
  "identity": "Current identity",
  "workbench": "Open workbench",
  "login": "Sign in and linked identities",
  "native": "Use desktop identity",
  "accept": "Accept an invitation",
  "code": "Invitation code",
  "join": "Join server",
  "members": "Instance members",
  "membersHint": "Member administration does not grant access to another person’s private resources.",
  "invite": "Create invitation",
  "reset": "Reset account password",
  "revoke": "Revoke access",
  "enable": "Restore access",
  "admin": "Administrator",
  "member": "Member",
  "done": "Saved.",
  "failed": "Unable to complete the operation. Check the input and try again.",
  "pending": "Setup was interrupted. Continue with the original username and password.",
  "closed": "Setup is complete. Sign in to continue.",
  "try_later": "Too many attempts. Try again later.",
  "setup_proof_required": "Enter the setup code provided by the installer.",
  "username_unavailable": "This username is already in use.",
  "account_verification_required": "Use the original account password to resume.",
  "recent_login_required": "Sign in again before managing accounts.",
  "administrator_required": "An instance administrator is required.",
  "invitation_unavailable": "This invitation has expired or has already been used.",
  "invalid_username": "Use 3–64 letters, numbers, dots, underscores or hyphens.",
  "resume_original_setup": "Resume the original setup choice and username."
} as const;
const chinese = {
  "title": "账号与成员",
  "intro": "管理你的账号、登录方式与服务器成员。",
  "setup": "初始化 OpenCraft",
  "mode": "这台设备的用途",
  "web": "提供远程 WebUI",
  "desktop": "在本机使用",
  "connect": "连接其他服务器",
  "proof": "安装者初始化凭证",
  "username": "用户名",
  "password": "密码（至少十二个字符）",
  "remote": "服务器地址",
  "continue": "继续",
  "identity": "当前身份",
  "workbench": "进入工作台",
  "login": "登录与身份绑定",
  "native": "使用桌面身份",
  "accept": "接受邀请",
  "code": "邀请凭证",
  "join": "加入服务器",
  "members": "实例成员",
  "membersHint": "管理成员不会自动获得其他人的私有资源访问权。",
  "invite": "生成邀请",
  "reset": "重置账号密码",
  "revoke": "撤销访问",
  "enable": "恢复访问",
  "admin": "管理员",
  "member": "成员",
  "done": "已保存。",
  "failed": "未能完成操作，请检查输入后重试。",
  "pending": "初始化中途停止，请使用原用户名和密码继续。",
  "closed": "初始化已完成，请登录后继续。",
  "try_later": "操作过于频繁，请稍后重试。",
  "setup_proof_required": "请输入安装者提供的初始化凭证。",
  "username_unavailable": "该用户名已被使用。",
  "account_verification_required": "请使用原账号密码继续初始化。",
  "recent_login_required": "请重新登录后管理账号。",
  "administrator_required": "需要实例管理员权限。",
  "invitation_unavailable": "邀请已过期或已被使用。",
  "invalid_username": "用户名需为3至64位字母、数字、点、下划线或连字符。",
  "resume_original_setup": "请继续原来的初始化模式和用户名。"
};
export type AccountDocumentMessage = keyof typeof english;
const descriptors = Object.fromEntries(Object.entries(english).map(([key, defaultMessage]) => [key, { id: 'localAccount.document.' + key, defaultMessage }])) as Record<AccountDocumentMessage, { id: string; defaultMessage: string }>;

/** The pre-Workbench document owns a request-scoped IntlRuntime. */
export async function accountDocumentCopy(requestedLocale: string) {
  const runtime = new LocaleRuntime([{ locale: 'zh-CN', label: '中文', load: async () => Object.fromEntries(Object.entries(chinese).map(([key, value]) => ['localAccount.document.' + key, value])) }]);
  await runtime.update({ systemLocale: requestedLocale, localeSource: 'SYSTEM' });
  const { intl } = runtime.getSnapshot();
  const copy = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, intl.formatMessage(descriptor)])) as Record<AccountDocumentMessage, string>;
  const locale = intl.locale;
  runtime.dispose();
  return { copy, locale };
}

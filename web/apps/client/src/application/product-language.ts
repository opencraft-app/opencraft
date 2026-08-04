const messagingProviderPattern = /腾讯云|\bIM\b|\bTopic\b/iu;
const infrastructureProviderPattern =
  /\b(?:TAT|PTY|Region|Enrollment|provider)\b/iu;

export function productErrorMessage(message: string): string {
  if (messagingProviderPattern.test(message)) {
    return "消息服务暂时不可用，请稍后重试";
  }
  if (infrastructureProviderPattern.test(message)) {
    return "操作失败，请稍后重试";
  }
  return message;
}

import type {Member} from "@vela/client-core";

import {
  memberIdentityLabel,
  memberKindLabel,
  memberRoleLabel,
  memberStatusLabel,
} from "../../member-identity";

export interface MemberListItemViewModel {
  accessibilityLabel: string;
  id: string;
  identityLabel?: string;
  meta: string;
  selected: boolean;
  status: string;
  subtitle: string;
  title: string;
}

export function memberListItemViewModel(
  member: Member,
  selected: boolean,
): MemberListItemViewModel {
  const identityLabel = memberIdentityLabel(member) ?? undefined;
  const subtitle = `${memberKindLabel[member.kind]} · ${memberRoleLabel[member.role]}`;
  return {
    accessibilityLabel: `打开成员 ${member.displayName}${identityLabel ? ` ${identityLabel}` : ""}`,
    id: member.id,
    identityLabel,
    meta: `${identityLabel ? `${identityLabel} · ` : ""}${subtitle}`,
    selected,
    status: memberStatusLabel[member.status],
    subtitle,
    title: member.displayName,
  };
}

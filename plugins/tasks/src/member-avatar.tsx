import { PersonIcon } from "@opencraft/design-system-web/action-icons";
import { useContext } from "react";
import { AvatarImage, IdentityAvatarContext } from "@opencraft/extension-react";
import type { TaskMember } from "@opencraft/appserver-protocol";

/** Profile references are explicit presentation data, independent of responsibility or login. */
export function MemberAvatar({ member, name, assigned }: { member?: TaskMember; name: string; assigned: boolean }) {
  const provider = useContext(IdentityAvatarContext);
  const words = name.trim().split(/\s+/u);
  const initials = words.length > 1
    ? `${Array.from(words[0]!)[0]}${Array.from(words.at(-1)!)[0]}`.toLocaleUpperCase()
    : Array.from(name).slice(0, 1).join("").toLocaleUpperCase();
  const identity = member?.identity;
  const src = assigned && identity ? provider?.resolve(identity.kind, identity.id) ?? null : null;
  return <span className={`tasks-avatar${assigned ? "" : " tasks-avatar--empty"}`} aria-hidden="true">
    <AvatarImage src={src} fallback={assigned ? initials : <PersonIcon size={14} />} />
  </span>;
}

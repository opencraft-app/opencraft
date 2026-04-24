export interface TopUserDetailTarget {
  user_id: string;
}

export function getTopUserDetailHref(user: TopUserDetailTarget): string | null {
  const businessUserID = user.user_id.trim();
  if (!businessUserID) {
    return null;
  }

  return `/users/${businessUserID}`;
}

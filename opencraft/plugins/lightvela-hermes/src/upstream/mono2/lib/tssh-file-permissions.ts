// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
export interface TsshFilePermissionInfo {
  owner?: number;
  group?: number;
  rights?: string;
  longname?: string;
}

export interface TsshFilePermissionSubject {
  uid?: number;
  gid?: number;
  groups?: number[];
  userName?: string;
}

interface LongnameIdentity {
  ownerName?: string;
  groupName?: string;
}

const SYMBOLIC_MODE_PATTERN = /^[bcdlps-]?[rwxstST-]{9}$/;
const OCTAL_MODE_PATTERN = /^[0-7]{3,4}$/;

const octalToSymbolicPermissions = (value: string) => {
  const permissionDigits = value.slice(-3);
  return permissionDigits
    .split("")
    .map((digit) => {
      const mode = Number.parseInt(digit, 8);
      return `${mode & 4 ? "r" : "-"}${mode & 2 ? "w" : "-"}${mode & 1 ? "x" : "-"}`;
    })
    .join("");
};

const normalizeModeCandidate = (value: string) => {
  const token = value.trim().split(/\s+/)[0] ?? "";
  if (!token) {
    return null;
  }
  if (SYMBOLIC_MODE_PATTERN.test(token)) {
    return token.length === 10 ? token.slice(1) : token;
  }
  if (OCTAL_MODE_PATTERN.test(token)) {
    return octalToSymbolicPermissions(token);
  }
  return null;
};

const parseLongnameIdentity = (longname?: string): LongnameIdentity => {
  if (!longname) {
    return {};
  }
  const tokens = longname.trim().split(/\s+/);
  if (tokens.length < 4 || !normalizeModeCandidate(tokens[0] ?? "")) {
    return {};
  }
  return {
    ownerName: tokens[2],
    groupName: tokens[3],
  };
};

export const extractTsshUnixPermissions = (file: TsshFilePermissionInfo) => {
  if (file.rights) {
    const rightsMode = normalizeModeCandidate(file.rights);
    if (rightsMode) {
      return rightsMode;
    }
  }
  if (file.longname) {
    return normalizeModeCandidate(file.longname);
  }
  return null;
};

export const canReadTsshFile = (file: TsshFilePermissionInfo, subject: TsshFilePermissionSubject) => {
  const permissions = extractTsshUnixPermissions(file);
  if (!permissions) {
    return true;
  }
  if (subject.uid === 0) {
    return true;
  }

  const ownerRead = permissions[0] === "r";
  const groupRead = permissions[3] === "r";
  const otherRead = permissions[6] === "r";
  if (otherRead) {
    return true;
  }

  const identity = parseLongnameIdentity(file.longname);
  if (ownerRead) {
    if (typeof file.owner === "number" && typeof subject.uid === "number" && file.owner === subject.uid) {
      return true;
    }
    if (identity.ownerName && subject.userName && identity.ownerName === subject.userName) {
      return true;
    }
  }

  if (!groupRead) {
    return false;
  }

  if (typeof file.group === "number") {
    if (typeof subject.gid === "number" && file.group === subject.gid) {
      return true;
    }
    if (subject.groups?.includes(file.group)) {
      return true;
    }
  }
  return Boolean(identity.groupName && subject.userName && identity.groupName === subject.userName);
};

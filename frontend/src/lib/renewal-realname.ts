import { REALNAME_LEVEL, type User } from "@/domain/types";

export const getRenewalRealnameFlowFlags = (
  user: User | null | undefined,
  realnamePhoneVerificationEnabled: boolean,
) => {
  const faceIdBackendEnabled = user?.realnameAssuranceMode === "observe"
    || user?.realnameAssuranceMode === "face_required";
  const facelessFlowEnabled = user?.realnameAssuranceMode === "faceless";
  const faceIdFlowEnabled = faceIdBackendEnabled || facelessFlowEnabled;
  const hasSafetyPhone = Boolean(user?.phone?.trim());

  return {
    faceIdBackendEnabled,
    facelessFlowEnabled,
    faceIdFlowEnabled,
    hasSafetyPhone,
    phoneProofEnabled: hasSafetyPhone && (realnamePhoneVerificationEnabled || faceIdFlowEnabled),
  };
};

export const isRenewalRealnameVerified = (
  user: User | null | undefined,
  realnamePhoneVerificationEnabled: boolean,
): boolean => {
  if (!user) return false;
  const { faceIdFlowEnabled } = getRenewalRealnameFlowFlags(user, realnamePhoneVerificationEnabled);

  if (faceIdFlowEnabled) {
    return user.realnameVerified === true && user.realnameLevel === REALNAME_LEVEL.PHONE_3FA;
  }

  if (realnamePhoneVerificationEnabled) {
    return user.realnameLevel === REALNAME_LEVEL.PHONE_3FA;
  }

  return Boolean(user.realnameVerified);
};

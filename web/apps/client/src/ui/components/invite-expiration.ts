import type {
  LocalDateTimeInputConfig,
  LocalDateTimePreset,
} from "./local-date-time-input.types";
import {formatInstantAsLocalDateTime} from "./local-date-time-model";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const INVITE_MINIMUM = 5 * MINUTE;
const INVITE_MAXIMUM = 30 * DAY;
const INVITE_DEFAULT = 7 * DAY;
const INVITE_STEP = 5;

export interface InviteExpirationSession extends LocalDateTimeInputConfig {
  maxValue: string;
  minValue: string;
  minuteStep: number;
  presets: readonly LocalDateTimePreset[];
  referenceNow: string;
  timezone: string;
  value: string;
}

export function createInviteExpirationSession(
  referenceNow: Date,
  timezone: string,
): InviteExpirationSession {
  const at = (offset: number, rounding: "ceil" | "floor" = "floor") =>
    formatInstantAsLocalDateTime(
      new Date(referenceNow.getTime() + offset),
      timezone,
      INVITE_STEP,
      rounding,
    );
  const presets: readonly LocalDateTimePreset[] = [
    {id: "24-hours", label: "24 小时", value: at(DAY)},
    {id: "7-days", label: "7 天", value: at(INVITE_DEFAULT)},
    {id: "30-days", label: "30 天", value: at(INVITE_MAXIMUM)},
  ];

  return {
    maxValue: at(INVITE_MAXIMUM),
    minValue: at(INVITE_MINIMUM, "ceil"),
    minuteStep: INVITE_STEP,
    presets,
    referenceNow: formatInstantAsLocalDateTime(referenceNow, timezone),
    timezone,
    value: presets[1]!.value,
  };
}

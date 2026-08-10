import {createInviteExpirationSession} from "./invite-expiration";

describe("invite expiration session", () => {
  it("uses one reference instant for the default, bounds and presets", () => {
    const session = createInviteExpirationSession(
      new Date("2026-08-10T04:02:30.000Z"),
      "Asia/Shanghai",
    );

    expect(session).toEqual({
      maxValue: "2026-09-09T12:00",
      minValue: "2026-08-10T12:10",
      minuteStep: 5,
      presets: [
        {id: "24-hours", label: "24 小时", value: "2026-08-11T12:00"},
        {id: "7-days", label: "7 天", value: "2026-08-17T12:00"},
        {id: "30-days", label: "30 天", value: "2026-09-09T12:00"},
      ],
      referenceNow: "2026-08-10T12:02",
      timezone: "Asia/Shanghai",
      value: "2026-08-17T12:00",
    });
  });

  it("interprets the same instant in the requested timezone", () => {
    const session = createInviteExpirationSession(
      new Date("2026-11-01T04:02:30.000Z"),
      "America/New_York",
    );

    expect(session.referenceNow).toBe("2026-11-01T00:02");
    expect(session.presets[0]?.value).toBe("2026-11-01T23:00");
  });
});

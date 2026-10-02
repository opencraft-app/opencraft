//! Minimal legacy CMOS/RTC surface used only to seed Linux wall time.

use std::{fmt, time::SystemTime};

const CMOS_REGISTER_COUNT: usize = 128;
const SECONDS_PER_DAY: u64 = 86_400;

const RTC_SECONDS: usize = 0x00;
const RTC_MINUTES: usize = 0x02;
const RTC_HOURS: usize = 0x04;
const RTC_WEEKDAY: usize = 0x06;
const RTC_DAY_OF_MONTH: usize = 0x07;
const RTC_MONTH: usize = 0x08;
const RTC_YEAR: usize = 0x09;
const RTC_STATUS_A: usize = 0x0a;
const RTC_STATUS_B: usize = 0x0b;
const RTC_STATUS_D: usize = 0x0d;
const RTC_CENTURY: usize = 0x32;

/// Failure to encode the trusted host wall clock in the legacy RTC format.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LegacyCmosError {
    /// The host wall clock predates the Unix epoch.
    BeforeUnixEpoch,
    /// The host wall-clock seconds cannot be represented by the calendar code.
    SecondsOutOfRange,
    /// The UTC year does not fit the two BCD year registers.
    YearOutOfRange(i64),
}

impl fmt::Display for LegacyCmosError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BeforeUnixEpoch => formatter.write_str("host clock predates the Unix epoch"),
            Self::SecondsOutOfRange => {
                formatter.write_str("host clock exceeds the calendar conversion range")
            }
            Self::YearOutOfRange(year) => {
                write!(formatter, "UTC year {year} is outside 0000..=9999")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct UtcCalendar {
    year: u16,
    month: u8,
    day: u8,
    weekday: u8,
    hour: u8,
    minute: u8,
    second: u8,
}

/// Narrow MC146818-compatible boot RTC on ports `0x70` and `0x71`.
///
/// Calendar registers are latched from host UTC on their first data read. A
/// restored clone re-arms that latch, so Linux can explicitly re-read current
/// wall time without advancing its TSC-based monotonic clock. The device does
/// not emulate alarms, periodic interrupts, or a continuously ticking RTC.
#[derive(Clone)]
pub(super) struct LegacyCmos {
    index: u8,
    registers: [u8; CMOS_REGISTER_COUNT],
    calendar_latched: bool,
}

impl Default for LegacyCmos {
    fn default() -> Self {
        let mut registers = [0; CMOS_REGISTER_COUNT];
        // 32.768 kHz divider, 24-hour BCD mode, and valid CMOS RAM.
        registers[RTC_STATUS_A] = 0x26;
        registers[RTC_STATUS_B] = 0x02;
        registers[RTC_STATUS_D] = 0x80;
        Self {
            index: 0,
            registers,
            calendar_latched: false,
        }
    }
}

impl LegacyCmos {
    pub(super) const INDEX: u16 = 0x70;
    pub(super) const DATA: u16 = 0x71;

    pub(super) const fn contains(port: u16) -> bool {
        port == Self::INDEX || port == Self::DATA
    }

    /// Copies snapshot-visible device state but re-arms host-time latching.
    pub(super) fn resumed_from(snapshot: &Self) -> Self {
        let mut resumed = snapshot.clone();
        resumed.calendar_latched = false;
        resumed
    }

    pub(super) fn read(&mut self, port: u16, output: &mut [u8]) -> Result<(), LegacyCmosError> {
        if port == Self::DATA && !self.calendar_latched {
            self.latch_host_realtime()?;
        }
        let value = if port == Self::INDEX {
            self.index
        } else {
            self.registers[usize::from(self.index & 0x7f)]
        };
        output.fill(value);
        Ok(())
    }

    pub(super) fn write(&mut self, port: u16, data: &[u8]) {
        let value = data.last().copied().unwrap_or(0);
        if port == Self::INDEX {
            self.index = value;
        } else {
            self.registers[usize::from(self.index & 0x7f)] = value;
        }
    }

    fn latch_host_realtime(&mut self) -> Result<(), LegacyCmosError> {
        let seconds = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|_| LegacyCmosError::BeforeUnixEpoch)?
            .as_secs();
        self.latch_unix_seconds(seconds)
    }

    fn latch_unix_seconds(&mut self, seconds: u64) -> Result<(), LegacyCmosError> {
        let calendar = utc_calendar(seconds)?;
        self.registers[RTC_SECONDS] = bcd(calendar.second);
        self.registers[RTC_MINUTES] = bcd(calendar.minute);
        self.registers[RTC_HOURS] = bcd(calendar.hour);
        self.registers[RTC_WEEKDAY] = bcd(calendar.weekday);
        self.registers[RTC_DAY_OF_MONTH] = bcd(calendar.day);
        self.registers[RTC_MONTH] = bcd(calendar.month);
        self.registers[RTC_YEAR] = bcd((calendar.year % 100) as u8);
        self.registers[RTC_CENTURY] = bcd(u8::try_from(calendar.year / 100)
            .map_err(|_| LegacyCmosError::YearOutOfRange(i64::from(calendar.year)))?);
        self.calendar_latched = true;
        Ok(())
    }
}

const fn bcd(value: u8) -> u8 {
    ((value / 10) << 4) | (value % 10)
}

fn utc_calendar(seconds: u64) -> Result<UtcCalendar, LegacyCmosError> {
    let days = seconds / SECONDS_PER_DAY;
    let seconds_of_day = seconds % SECONDS_PER_DAY;
    let days = i64::try_from(days).map_err(|_| LegacyCmosError::SecondsOutOfRange)?;

    // Howard Hinnant's civil_from_days conversion, with day zero at
    // 1970-01-01. It is pure integer arithmetic and therefore independent of
    // the host timezone and libc's mutable timezone state.
    let shifted = days
        .checked_add(719_468)
        .ok_or(LegacyCmosError::SecondsOutOfRange)?;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    if !(0..=9_999).contains(&year) {
        return Err(LegacyCmosError::YearOutOfRange(year));
    }

    // The MC146818 weekday convention is Sunday=1 through Saturday=7.
    let weekday = (days + 4).rem_euclid(7) + 1;
    Ok(UtcCalendar {
        year: u16::try_from(year).map_err(|_| LegacyCmosError::YearOutOfRange(year))?,
        month: u8::try_from(month).map_err(|_| LegacyCmosError::SecondsOutOfRange)?,
        day: u8::try_from(day).map_err(|_| LegacyCmosError::SecondsOutOfRange)?,
        weekday: u8::try_from(weekday).map_err(|_| LegacyCmosError::SecondsOutOfRange)?,
        hour: (seconds_of_day / 3_600) as u8,
        minute: ((seconds_of_day % 3_600) / 60) as u8,
        second: (seconds_of_day % 60) as u8,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        LegacyCmos, RTC_CENTURY, RTC_DAY_OF_MONTH, RTC_HOURS, RTC_MINUTES, RTC_MONTH, RTC_SECONDS,
        RTC_STATUS_A, RTC_STATUS_B, RTC_STATUS_D, RTC_WEEKDAY, RTC_YEAR,
    };

    #[test]
    fn unix_epoch_is_encoded_as_coherent_utc_bcd() {
        let mut cmos = LegacyCmos::default();
        cmos.latch_unix_seconds(0).expect("representable epoch");
        assert_eq!(cmos.registers[RTC_CENTURY], 0x19);
        assert_eq!(cmos.registers[RTC_YEAR], 0x70);
        assert_eq!(cmos.registers[RTC_MONTH], 0x01);
        assert_eq!(cmos.registers[RTC_DAY_OF_MONTH], 0x01);
        assert_eq!(cmos.registers[RTC_WEEKDAY], 0x05);
        assert_eq!(cmos.registers[RTC_HOURS], 0x00);
        assert_eq!(cmos.registers[RTC_MINUTES], 0x00);
        assert_eq!(cmos.registers[RTC_SECONDS], 0x00);
    }

    #[test]
    fn leap_day_and_subday_fields_are_encoded_in_utc() {
        let mut cmos = LegacyCmos::default();
        cmos.latch_unix_seconds(1_709_251_198)
            .expect("2024 timestamp");
        assert_eq!(cmos.registers[RTC_CENTURY], 0x20);
        assert_eq!(cmos.registers[RTC_YEAR], 0x24);
        assert_eq!(cmos.registers[RTC_MONTH], 0x02);
        assert_eq!(cmos.registers[RTC_DAY_OF_MONTH], 0x29);
        assert_eq!(cmos.registers[RTC_WEEKDAY], 0x05);
        assert_eq!(cmos.registers[RTC_HOURS], 0x23);
        assert_eq!(cmos.registers[RTC_MINUTES], 0x59);
        assert_eq!(cmos.registers[RTC_SECONDS], 0x58);
    }

    #[test]
    fn gregorian_century_year_is_not_treated_as_a_leap_year() {
        let mut cmos = LegacyCmos::default();
        cmos.latch_unix_seconds(4_107_542_400)
            .expect("2100 timestamp");
        assert_eq!(cmos.registers[RTC_CENTURY], 0x21);
        assert_eq!(cmos.registers[RTC_YEAR], 0x00);
        assert_eq!(cmos.registers[RTC_MONTH], 0x03);
        assert_eq!(cmos.registers[RTC_DAY_OF_MONTH], 0x01);
        assert_eq!(cmos.registers[RTC_WEEKDAY], 0x02);
    }

    #[test]
    fn resume_rearms_only_the_host_calendar_latch() {
        let mut snapshot = LegacyCmos {
            index: 0x8a,
            ..LegacyCmos::default()
        };
        snapshot.latch_unix_seconds(0).expect("representable epoch");
        snapshot.registers[0x20] = 0xa5;

        let resumed = LegacyCmos::resumed_from(&snapshot);
        assert!(!resumed.calendar_latched);
        assert_eq!(resumed.index, 0x8a);
        assert_eq!(resumed.registers[0x20], 0xa5);
        assert_eq!(resumed.registers[RTC_STATUS_A], 0x26);
        assert_eq!(resumed.registers[RTC_STATUS_B], 0x02);
        assert_eq!(resumed.registers[RTC_STATUS_D], 0x80);
    }

    #[test]
    fn index_nmi_bit_cannot_address_outside_cmos() {
        let mut cmos = LegacyCmos {
            calendar_latched: true,
            ..LegacyCmos::default()
        };
        cmos.write(LegacyCmos::INDEX, &[0xff]);
        cmos.write(LegacyCmos::DATA, &[0x5a]);
        assert_eq!(cmos.registers[0x7f], 0x5a);
    }
}

//! Public structured-command and PTY request types.

use std::{
    ffi::{OsStr, OsString},
    os::unix::ffi::OsStrExt,
    path::PathBuf,
    time::Duration,
};

use minisandbox_control_protocol::{WireCommandSpec, WirePtySize, WireUser};

use super::ControlError;

/// Guest credentials selected before direct execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandUser {
    /// Retains the agent credentials (root in the maintained guest).
    Current,
    /// Uses an explicit numeric uid and gid.
    Ids {
        /// Numeric user ID.
        uid: u32,
        /// Numeric group ID.
        gid: u32,
    },
    /// Resolves a user from the guest's `/etc/passwd` parser.
    Name(OsString),
}

/// Terminal dimensions used for PTY creation and resizing.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PtySize {
    /// Character rows.
    pub rows: u16,
    /// Character columns.
    pub columns: u16,
    /// Optional horizontal pixel count.
    pub pixel_width: u16,
    /// Optional vertical pixel count.
    pub pixel_height: u16,
}

impl PtySize {
    /// Creates character-only dimensions.
    #[must_use]
    pub const fn new(rows: u16, columns: u16) -> Self {
        Self {
            rows,
            columns,
            pixel_width: 0,
            pixel_height: 0,
        }
    }

    pub(super) const fn to_wire(self) -> WirePtySize {
        WirePtySize {
            rows: self.rows,
            columns: self.columns,
            pixel_width: self.pixel_width,
            pixel_height: self.pixel_height,
        }
    }
}

/// Direct `execve` request. No field is interpreted by a shell.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSpec {
    program: OsString,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    cwd: PathBuf,
    user: CommandUser,
    terminal: Option<PtySize>,
}

impl CommandSpec {
    /// Creates a direct command with cwd `/`, current credentials, an empty
    /// environment, and ordinary stdin/stdout/stderr pipes.
    #[must_use]
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            arguments: Vec::new(),
            environment: Vec::new(),
            cwd: PathBuf::from("/"),
            user: CommandUser::Current,
            terminal: None,
        }
    }

    /// Appends one raw Unix argument.
    #[must_use]
    pub fn arg(mut self, argument: impl Into<OsString>) -> Self {
        self.arguments.push(argument.into());
        self
    }

    /// Appends raw Unix arguments.
    #[must_use]
    pub fn args<I, S>(mut self, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.arguments.extend(arguments.into_iter().map(Into::into));
        self
    }

    /// Adds or replaces one environment entry in transmission order.
    #[must_use]
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        let key = key.into();
        self.environment.retain(|(existing, _)| existing != &key);
        self.environment.push((key, value.into()));
        self
    }

    /// Selects an absolute guest working directory.
    #[must_use]
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = cwd.into();
        self
    }

    /// Selects explicit numeric guest credentials.
    #[must_use]
    pub fn user_ids(mut self, uid: u32, gid: u32) -> Self {
        self.user = CommandUser::Ids { uid, gid };
        self
    }

    /// Selects a guest user resolved from `/etc/passwd` without helper processes.
    #[must_use]
    pub fn user_name(mut self, user: impl Into<OsString>) -> Self {
        self.user = CommandUser::Name(user.into());
        self
    }

    /// Allocates a controlling PTY and attaches the returned command session.
    #[must_use]
    pub fn terminal(mut self, size: PtySize) -> Self {
        self.terminal = Some(size);
        self
    }

    /// Absolute executable path.
    #[must_use]
    pub fn program(&self) -> &OsStr {
        &self.program
    }

    /// Whether this command requests an attached PTY.
    #[must_use]
    pub const fn has_terminal(&self) -> bool {
        self.terminal.is_some()
    }

    pub(super) fn encode(
        &self,
        command_timeout: Option<Duration>,
    ) -> Result<Vec<u8>, ControlError> {
        Ok(self.to_wire(command_timeout).encode()?)
    }

    fn to_wire(&self, command_timeout: Option<Duration>) -> WireCommandSpec {
        WireCommandSpec {
            program: self.program.as_bytes().to_vec(),
            arguments: self
                .arguments
                .iter()
                .map(|argument| argument.as_bytes().to_vec())
                .collect(),
            environment: self
                .environment
                .iter()
                .map(|(key, value)| (key.as_bytes().to_vec(), value.as_bytes().to_vec()))
                .collect(),
            cwd: self.cwd.as_os_str().as_bytes().to_vec(),
            user: match &self.user {
                CommandUser::Current => WireUser::Current,
                CommandUser::Ids { uid, gid } => WireUser::Ids {
                    uid: *uid,
                    gid: *gid,
                },
                CommandUser::Name(name) => WireUser::Name(name.as_bytes().to_vec()),
            },
            terminal: self.terminal.map(PtySize::to_wire),
            timeout_ms: command_timeout.map_or(0, duration_millis),
        }
    }
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis())
        .unwrap_or(u64::MAX)
        .max(1)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn builder_preserves_raw_structured_fields() {
        let command = CommandSpec::new("/usr/bin/env")
            .arg("raw")
            .env("KEY", "VALUE")
            .cwd(Path::new("/tmp"))
            .user_ids(1000, 1000)
            .terminal(PtySize::new(24, 80));
        let decoded = WireCommandSpec::decode(
            &command
                .encode(Some(Duration::from_micros(1)))
                .expect("encode"),
        )
        .expect("decode");
        assert_eq!(decoded.program, b"/usr/bin/env");
        assert_eq!(decoded.arguments, [b"raw"]);
        assert_eq!(decoded.environment, [(b"KEY".to_vec(), b"VALUE".to_vec())]);
        assert_eq!(decoded.cwd, b"/tmp");
        assert_eq!(
            decoded.user,
            WireUser::Ids {
                uid: 1000,
                gid: 1000
            }
        );
        assert_eq!(decoded.terminal, Some(PtySize::new(24, 80).to_wire()));
        assert_eq!(decoded.timeout_ms, 1);

        let immediate = WireCommandSpec::decode(
            &command
                .encode(Some(Duration::ZERO))
                .expect("encode immediate timeout"),
        )
        .expect("decode immediate timeout");
        assert_eq!(immediate.timeout_ms, 1);
    }
}

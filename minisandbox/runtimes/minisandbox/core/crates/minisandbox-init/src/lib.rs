//! Minimal Linux PID 1 and same-artifact command agent for a minisandbox guest.
//!
//! The init process owns only fixed early mounts, the optional writable-root
//! pivot, one workload process group, signal forwarding, child reaping, and an
//! orderly poweroff. Linux and this process are untrusted guest state; this
//! crate introduces no new host ABI or hypercall number.

mod agent;

use std::{
	env,
	ffi::{CString, OsStr, OsString},
	fmt, fs, io,
	os::{
		fd::{FromRawFd, RawFd},
		unix::{ffi::OsStrExt, fs::PermissionsExt, process::CommandExt},
	},
	path::Path,
	process::{Command, ExitCode},
	ptr,
	time::{Duration, Instant},
};

use minisandbox_control_protocol::WirePtySize;

const USAGE: &str = "Usage:\n  minisandbox init [--mode warm|console] [-- PROGRAM [ARG...]]\n  minisandbox-init [--mode warm|console] [-- PROGRAM [ARG...]]\n";
const WARM_PROGRAM: &str = "/opt/minisandbox/minisandbox-warm";
const TERM_GRACE: Duration = Duration::from_secs(2);
const KILL_GRACE: Duration = Duration::from_secs(1);
const DEFAULT_SHM_MIB: u32 = 32;
const MAX_SHM_MIB: u32 = 4096;
const EXEC_FAILURE_MESSAGE: &[u8] = b"minisandbox-init: workload exec failed\n";
// Linux x86-64 `_IO(0xb7, 3)` for the mode-0600 guest control device.
const MINISANDBOX_IOCTL_EXIT: libc::Ioctl = 0xB703;

fn fork_single_threaded() -> io::Result<libc::pid_t> {
	// SAFETY: Callers invoke this only before starting threads in their
	// process and keep the child branch inside the documented post-fork path.
	let child = unsafe { libc::fork() };
	if child < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(child)
	}
}

fn exit_immediately(status: libc::c_int) -> ! {
	// SAFETY: `_exit` terminates the calling process without touching shared
	// Rust or libc teardown state, which is exactly required post-fork.
	unsafe { libc::_exit(status) }
}

fn open_pty(size: WirePtySize) -> io::Result<(fs::File, fs::File)> {
	let mut master = -1;
	let mut slave = -1;
	let dimensions = libc::winsize {
		ws_row: size.rows,
		ws_col: size.columns,
		ws_xpixel: size.pixel_width,
		ws_ypixel: size.pixel_height,
	};
	// SAFETY: `master` and `slave` are writable descriptor outputs, the name
	// and termios pointers are intentionally null, and `dimensions` is initialized.
	let result = unsafe {
		libc::openpty(
			&raw mut master,
			&raw mut slave,
			ptr::null_mut(),
			ptr::null(),
			&raw const dimensions,
		)
	};
	if result != 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: A successful `openpty` returned two new owned descriptors.
	let master = unsafe { fs::File::from_raw_fd(master) };
	// SAFETY: The slave descriptor is distinct and likewise newly owned.
	let slave = unsafe { fs::File::from_raw_fd(slave) };
	set_close_on_exec(&master)?;
	set_close_on_exec(&slave)?;
	Ok((master, slave))
}

fn set_close_on_exec(descriptor: &impl std::os::fd::AsRawFd) -> io::Result<()> {
	// SAFETY: The borrowed descriptor is live for both non-pointer `fcntl` calls.
	let flags = unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_GETFD) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: The descriptor remains live and the flag word preserves existing bits.
	let result = unsafe {
		libc::fcntl(
			descriptor.as_raw_fd(),
			libc::F_SETFD,
			flags | libc::FD_CLOEXEC,
		)
	};
	cvt(result)
}

fn configure_command_child(
	command: &mut std::process::Command,
	terminal: bool,
	credentials: Option<(u32, u32)>,
) {
	// SAFETY: The closure runs after fork and before exec. It invokes only
	// allocation-free libc syscall wrappers and accesses no shared Rust state.
	unsafe {
		command.pre_exec(move || {
			if terminal {
				if libc::setsid() < 0 {
					return Err(io::Error::last_os_error());
				}
				if libc::ioctl(libc::STDIN_FILENO, libc::TIOCSCTTY, 0) < 0 {
					return Err(io::Error::last_os_error());
				}
			} else if libc::setpgid(0, 0) < 0 {
				return Err(io::Error::last_os_error());
			}
			if let Some((uid, gid)) = credentials
				&& (libc::setgroups(0, ptr::null()) < 0
					|| libc::setgid(gid) < 0
					|| libc::setuid(uid) < 0)
			{
				return Err(io::Error::last_os_error());
			}
			Ok(())
		});
	}
}

fn resize_pty(descriptor: RawFd, size: WirePtySize) -> io::Result<()> {
	let dimensions = libc::winsize {
		ws_row: size.rows,
		ws_col: size.columns,
		ws_xpixel: size.pixel_width,
		ws_ypixel: size.pixel_height,
	};
	// SAFETY: `descriptor` is the live PTY master retained by the command
	// worker, and the ioctl reads one initialized `winsize` value.
	let result = unsafe { libc::ioctl(descriptor, libc::TIOCSWINSZ, &raw const dimensions) };
	cvt(result)
}

#[cfg(test)]
fn process_exists(pid: libc::pid_t) -> io::Result<bool> {
	// SAFETY: Signal zero performs an existence/permission check only, and
	// `pid` is the positive child identifier observed in a protocol record.
	let result = unsafe { libc::kill(pid, 0) };
	if result == 0 {
		return Ok(true);
	}
	let error = io::Error::last_os_error();
	if error.raw_os_error() == Some(libc::ESRCH) {
		Ok(false)
	} else {
		Err(error)
	}
}

/// Run the guest init command with arguments following `init`.
///
/// A successful PID 1 invocation does not return: it supervises the selected
/// workload and powers off the guest after that workload exits.
pub fn entry(arguments: impl IntoIterator<Item = OsString>) -> ExitCode {
	let action = match Options::parse(arguments) {
		Ok(action) => action,
		Err(error) => {
			eprintln!("minisandbox-init: {error}\n{USAGE}");
			return ExitCode::from(2);
		}
	};
	let Action::Run(options) = action else {
		print!("{USAGE}");
		return ExitCode::SUCCESS;
	};

	// SAFETY: `getpid` has no pointer arguments or caller preconditions.
	if unsafe { libc::getpid() } != 1 {
		eprintln!("minisandbox-init: refusing to run outside global PID 1");
		return ExitCode::from(1);
	}

	if let Err(error) = run(options) {
		eprintln!("minisandbox-init: fatal: {error}");
		power_off(u8::MAX);
	}
	unreachable!("PID 1 poweroff fallback returned")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
	Warm,
	Console,
	Exec,
}

impl Mode {
	fn parse(value: &OsStr) -> Result<Self, String> {
		if value == "warm" {
			Ok(Self::Warm)
		} else if value == "console" {
			Ok(Self::Console)
		} else {
			Err(format!("unsupported init mode {}", value.to_string_lossy()))
		}
	}
}

impl fmt::Display for Mode {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Warm => formatter.write_str("warm"),
			Self::Console => formatter.write_str("console"),
			Self::Exec => formatter.write_str("exec"),
		}
	}
}

#[derive(Debug, Eq, PartialEq)]
struct Options {
	mode: Option<Mode>,
	program: Vec<OsString>,
}

enum Action {
	Help,
	Run(Options),
}

impl Options {
	fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Action, String> {
		let mut arguments = arguments.into_iter();
		let mut mode = None;
		let mut program = Vec::new();
		while let Some(argument) = arguments.next() {
			if argument == "-h" || argument == "--help" {
				return Ok(Action::Help);
			}
			if argument == "--mode" {
				let value = arguments
					.next()
					.ok_or_else(|| "--mode requires a value".to_owned())?;
				mode = Some(Mode::parse(&value)?);
				continue;
			}
			if argument == "--" {
				program.extend(arguments);
				break;
			}
			return Err(format!(
				"unexpected argument {}",
				argument.to_string_lossy()
			));
		}
		if mode.is_some() && !program.is_empty() {
			return Err("--mode and an explicit PROGRAM are mutually exclusive".to_owned());
		}
		Ok(Action::Run(Self { mode, program }))
	}
}

fn run(options: Options) -> Result<(), String> {
	prepare_kernel_filesystems().map_err(|error| format!("early mount setup failed: {error}"))?;
	let command_line = fs::read_to_string("/proc/cmdline")
		.map_err(|error| format!("cannot read /proc/cmdline: {error}"))?;
	if Path::new("/dev/vda").exists() || command_line_word(&command_line, "minisandbox.overlay=1") {
		pivot_to_overlay(&command_line)
			.map_err(|error| format!("writable-root pivot failed: {error}"))?;
	}
	prepare_runtime_filesystems(&command_line)
		.map_err(|error| format!("runtime mount setup failed: {error}"))?;

	let agent = agent::spawn().map_err(|error| format!("control agent startup failed: {error}"))?;
	println!(
		"MINISANDBOX_CONTROL_READY port={}",
		minisandbox_control_protocol::CONTROL_PORT
	);

	let (mode, program) = select_program(options, &command_line)?;
	println!("MINISANDBOX_INIT_READY mode={mode}");
	let status =
		supervise(&program, agent).map_err(|error| format!("supervisor failed: {error}"))?;
	unmount_shutdown_filesystems();
	println!("MINISANDBOX_INIT_WORKLOAD_EXIT status={status}");
	power_off(status.exit_code());
}

fn select_program(options: Options, command_line: &str) -> Result<(Mode, Vec<OsString>), String> {
	if !options.program.is_empty() {
		return Ok((Mode::Exec, options.program));
	}
	let command_line_mode = command_line
		.split_ascii_whitespace()
		.find_map(|word| word.strip_prefix("minisandbox.mode="));
	let mode = if let Some(mode) = options.mode {
		mode
	} else if let Some(mode) = command_line_mode {
		Mode::parse(OsStr::new(mode))?
	} else {
		Mode::Warm
	};
	let program = match mode {
		Mode::Warm => vec![OsString::from(WARM_PROGRAM)],
		Mode::Console => [
			"/sbin/agetty",
			"--autologin",
			"root",
			"--noclear",
			"--keep-baud",
			"ttyS0",
			"115200,57600,38400,9600",
			"vt100",
		]
		.into_iter()
		.map(OsString::from)
		.collect(),
		Mode::Exec => unreachable!("exec mode requires an explicit program"),
	};
	Ok((mode, program))
}

fn command_line_word(command_line: &str, expected: &str) -> bool {
	command_line
		.split_ascii_whitespace()
		.any(|word| word == expected)
}

fn command_line_u32(command_line: &str, key: &str, default: u32, maximum: u32) -> io::Result<u32> {
	let mut selected = None;
	for word in command_line.split_ascii_whitespace() {
		let Some(value) = word.strip_prefix(key) else {
			continue;
		};
		if selected.is_some() {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				format!("duplicate kernel command-line option {key}"),
			));
		}
		let value = value.parse::<u32>().map_err(|_| {
			io::Error::new(
				io::ErrorKind::InvalidInput,
				format!("invalid numeric kernel command-line option {key}{value}"),
			)
		})?;
		if value == 0 || value > maximum {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				format!("kernel command-line option {key} must be in 1..={maximum}"),
			));
		}
		selected = Some(value);
	}
	Ok(selected.unwrap_or(default))
}

fn prepare_kernel_filesystems() -> io::Result<()> {
	if !Path::new("/dev/null").exists() {
		mount_fs(
			"devtmpfs",
			"/dev",
			"devtmpfs",
			libc::MS_NOSUID,
			Some("mode=0755"),
		)?;
	}
	mount_fs(
		"proc",
		"/proc",
		"proc",
		libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
		None,
	)?;
	mount_fs(
		"sysfs",
		"/sys",
		"sysfs",
		libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
		None,
	)?;
	Ok(())
}

fn prepare_runtime_filesystems(command_line: &str) -> io::Result<()> {
	let shm_mib = command_line_u32(
		command_line,
		"minisandbox.shm_mib=",
		DEFAULT_SHM_MIB,
		MAX_SHM_MIB,
	)?;
	mount_tmpfs("/run", "mode=0755,size=16m")?;
	mount_tmpfs("/tmp", "mode=1777,size=64m")?;
	fs::create_dir_all("/dev/pts")?;
	mount_fs(
		"devpts",
		"/dev/pts",
		"devpts",
		libc::MS_NOSUID | libc::MS_NOEXEC,
		Some("mode=0620,ptmxmode=0666"),
	)?;
	fs::create_dir_all("/dev/shm")?;
	mount_tmpfs("/dev/shm", &format!("mode=1777,size={shm_mib}m"))?;
	fs::create_dir_all("/run/screen")?;
	fs::set_permissions("/run/screen", fs::Permissions::from_mode(0o775))?;
	Ok(())
}

fn pivot_to_overlay(command_line: &str) -> io::Result<()> {
	let has_app_layer = command_line_word(command_line, "minisandbox.app_layer=1");
	mount_tmpfs("/run", "mode=0755,size=16m")?;
	fs::create_dir_all("/run/minisandbox-upper")?;
	fs::create_dir_all("/run/minisandbox-root")?;
	if has_app_layer {
		mount_fs(
			"/dev/pmem1",
			"/run/minisandbox-app",
			"erofs",
			libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV,
			Some("dax=always"),
		)?;
	}
	mount_fs(
		"/dev/vda",
		"/run/minisandbox-upper",
		"ext4",
		libc::MS_NOATIME | libc::MS_LAZYTIME,
		Some("rw,commit=20,discard"),
	)?;
	require_directory("/run/minisandbox-upper/upper")?;
	require_directory("/run/minisandbox-upper/work")?;
	mount_fs(
		"overlay",
		"/run/minisandbox-root",
		"overlay",
		0,
		Some(overlay_mount_options(has_app_layer)),
	)?;
	for directory in [".oldroot", "dev", "proc", "sys"] {
		fs::create_dir_all(Path::new("/run/minisandbox-root").join(directory))?;
	}
	move_mount("/dev", "/run/minisandbox-root/dev")?;
	move_mount("/proc", "/run/minisandbox-root/proc")?;
	move_mount("/sys", "/run/minisandbox-root/sys")?;
	env::set_current_dir("/run/minisandbox-root")?;
	syscall_pivot_root(".", ".oldroot")?;
	env::set_current_dir("/")?;
	unmount("/.oldroot", libc::MNT_DETACH)?;
	let _ = fs::remove_dir("/.oldroot");
	Ok(())
}

fn overlay_mount_options(has_app_layer: bool) -> &'static str {
	if has_app_layer {
		"lowerdir=/run/minisandbox-app:/,upperdir=/run/minisandbox-upper/upper,workdir=/run/minisandbox-upper/work"
	} else {
		"lowerdir=/,upperdir=/run/minisandbox-upper/upper,workdir=/run/minisandbox-upper/work"
	}
}

fn require_directory(path: &str) -> io::Result<()> {
	if Path::new(path).is_dir() {
		Ok(())
	} else {
		Err(io::Error::new(
			io::ErrorKind::NotFound,
			format!("required directory {path} is missing"),
		))
	}
}

fn mount_tmpfs(target: &str, data: &str) -> io::Result<()> {
	mount_fs(
		"tmpfs",
		target,
		"tmpfs",
		libc::MS_NOSUID | libc::MS_NODEV,
		Some(data),
	)
}

fn mount_fs(
	source: &str,
	target: &str,
	filesystem: &str,
	flags: libc::c_ulong,
	data: Option<&str>,
) -> io::Result<()> {
	fs::create_dir_all(target)?;
	let source = CString::new(source)?;
	let target = path_cstring(target)?;
	let filesystem = CString::new(filesystem)?;
	let data = data.map(CString::new).transpose()?;
	let data_pointer = data
		.as_ref()
		.map_or(ptr::null(), |value| value.as_ptr().cast());
	// SAFETY: Every pointer references a live NUL-terminated `CString`; the
	// optional data pointer remains live for the duration of `mount`.
	let result = unsafe {
		libc::mount(
			source.as_ptr(),
			target.as_ptr(),
			filesystem.as_ptr(),
			flags,
			data_pointer,
		)
	};
	if result == 0 {
		return Ok(());
	}
	let error = io::Error::last_os_error();
	if error.raw_os_error() == Some(libc::EBUSY) {
		Ok(())
	} else {
		Err(error)
	}
}

fn move_mount(source: &str, target: &str) -> io::Result<()> {
	let source = path_cstring(source)?;
	let target = path_cstring(target)?;
	// SAFETY: Both pointers reference live NUL-terminated path strings.
	let result = unsafe {
		libc::mount(
			source.as_ptr(),
			target.as_ptr(),
			ptr::null(),
			libc::MS_MOVE,
			ptr::null(),
		)
	};
	cvt(result)
}

fn syscall_pivot_root(new_root: &str, put_old: &str) -> io::Result<()> {
	let new_root = path_cstring(new_root)?;
	let put_old = path_cstring(put_old)?;
	// SAFETY: Both pointers reference live NUL-terminated path strings and
	// this single-threaded PID 1 owns the guest mount namespace.
	let result =
		unsafe { libc::syscall(libc::SYS_pivot_root, new_root.as_ptr(), put_old.as_ptr()) };
	if result == 0 {
		Ok(())
	} else {
		Err(io::Error::last_os_error())
	}
}

fn unmount(target: &str, flags: libc::c_int) -> io::Result<()> {
	let target = path_cstring(target)?;
	// SAFETY: `target` is a live NUL-terminated path string.
	cvt(unsafe { libc::umount2(target.as_ptr(), flags) })
}

fn path_cstring(path: impl AsRef<OsStr>) -> io::Result<CString> {
	CString::new(path.as_ref().as_bytes()).map_err(Into::into)
}

fn cvt(result: libc::c_int) -> io::Result<()> {
	if result == 0 {
		Ok(())
	} else {
		Err(io::Error::last_os_error())
	}
}

struct SignalFd {
	descriptor: RawFd,
	old_mask: libc::sigset_t,
	old_term_action: libc::sigaction,
}

extern "C" fn supervisor_signal_handler(_signal: libc::c_int) {}

impl SignalFd {
	fn new() -> io::Result<Self> {
		// SAFETY: An all-zero value is used only as initialized storage for
		// `sigemptyset`, which writes the complete platform signal set.
		let mut mask = unsafe { std::mem::zeroed::<libc::sigset_t>() };
		// SAFETY: `mask` is valid writable storage for one `sigset_t`.
		cvt(unsafe { libc::sigemptyset(&raw mut mask) })?;
		for signal in [
			libc::SIGCHLD,
			libc::SIGHUP,
			libc::SIGINT,
			libc::SIGQUIT,
			libc::SIGTERM,
			libc::SIGUSR1,
			libc::SIGUSR2,
			libc::SIGCONT,
			libc::SIGTSTP,
			libc::SIGTTIN,
			libc::SIGTTOU,
			libc::SIGWINCH,
		] {
			// SAFETY: `mask` remains initialized and every listed signal is a
			// valid catchable Linux signal number.
			cvt(unsafe { libc::sigaddset(&raw mut mask, signal) })?;
		}
		// SAFETY: Zeroed storage is valid as the output destination that
		// `pthread_sigmask` initializes below.
		let mut old_mask = unsafe { std::mem::zeroed::<libc::sigset_t>() };
		// SAFETY: `mask` is initialized and `old_mask` is valid writable
		// storage. PID 1 has not created any other threads.
		let result =
			unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &raw const mask, &raw mut old_mask) };
		if result != 0 {
			return Err(io::Error::from_raw_os_error(result));
		}
		// Linux gives PID 1 special signal semantics: a signal with the
		// default disposition is ignored even when it is blocked for a
		// signalfd. Install a no-op disposition so the host's existing
		// structured Exec path can request SIGTERM without another control
		// opcode. The signal remains blocked and is consumed only below.
		// SAFETY: Both action structures are valid for one `sigaction` call,
		// and `supervisor_signal_handler` has the required C ABI.
		let mut term_action = unsafe { std::mem::zeroed::<libc::sigaction>() };
		term_action.sa_sigaction = supervisor_signal_handler as *const () as libc::sighandler_t;
		term_action.sa_flags = libc::SA_RESTART;
		// SAFETY: `sa_mask` is valid writable storage within `term_action`.
		if unsafe { libc::sigemptyset(&raw mut term_action.sa_mask) } < 0 {
			let error = io::Error::last_os_error();
			// SAFETY: `old_mask` was initialized by the successful mask call.
			unsafe {
				libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old_mask, ptr::null_mut());
			}
			return Err(error);
		}
		// SAFETY: Zeroed storage is valid as the output destination initialized
		// by the following `sigaction` call.
		let mut old_term_action = unsafe { std::mem::zeroed::<libc::sigaction>() };
		// SAFETY: The signal number is catchable and both action pointers are
		// valid for the duration of the call.
		if unsafe {
			libc::sigaction(
				libc::SIGTERM,
				&raw const term_action,
				&raw mut old_term_action,
			)
		} < 0
		{
			let error = io::Error::last_os_error();
			// SAFETY: `old_mask` was initialized by the successful mask call.
			unsafe {
				libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old_mask, ptr::null_mut());
			}
			return Err(error);
		}
		// SAFETY: `mask` remains initialized for the duration of the call.
		let descriptor =
			unsafe { libc::signalfd(-1, &raw const mask, libc::SFD_CLOEXEC | libc::SFD_NONBLOCK) };
		if descriptor < 0 {
			let error = io::Error::last_os_error();
			// SAFETY: Both saved values were initialized by successful calls;
			// the null output pointers explicitly discard the replaced state.
			unsafe {
				libc::sigaction(libc::SIGTERM, &raw const old_term_action, ptr::null_mut());
				libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old_mask, ptr::null_mut());
			}
			return Err(error);
		}
		Ok(Self {
			descriptor,
			old_mask,
			old_term_action,
		})
	}

	fn wait(&self, timeout: Option<Duration>) -> io::Result<Vec<libc::c_int>> {
		let timeout = timeout.map_or(-1, duration_millis);
		let mut poll_descriptor = libc::pollfd {
			fd: self.descriptor,
			events: libc::POLLIN,
			revents: 0,
		};
		// SAFETY: `poll_descriptor` is one initialized writable `pollfd` and
		// the count exactly matches that allocation.
		let result = unsafe { libc::poll(&raw mut poll_descriptor, 1, timeout) };
		if result < 0 {
			let error = io::Error::last_os_error();
			if error.kind() == io::ErrorKind::Interrupted {
				return Ok(Vec::new());
			}
			return Err(error);
		}
		if result == 0 {
			return Ok(Vec::new());
		}
		let mut signals = Vec::new();
		loop {
			// SAFETY: An all-zero signalfd record is valid writable storage
			// that is filled by the following `read`.
			let mut information = unsafe { std::mem::zeroed::<libc::signalfd_siginfo>() };
			// SAFETY: The descriptor is live and `information` owns exactly
			// the writable byte count supplied to `read`.
			let length = unsafe {
				libc::read(
					self.descriptor,
					(&raw mut information).cast(),
					size_of::<libc::signalfd_siginfo>(),
				)
			};
			if length == size_of::<libc::signalfd_siginfo>().cast_signed() {
				signals.push(information.ssi_signo.cast_signed());
				continue;
			}
			if length < 0 {
				let error = io::Error::last_os_error();
				if error.kind() == io::ErrorKind::WouldBlock {
					break;
				}
				return Err(error);
			}
			if length == 0 {
				break;
			}
			return Err(io::Error::new(
				io::ErrorKind::UnexpectedEof,
				"short signalfd record",
			));
		}
		Ok(signals)
	}
}

impl Drop for SignalFd {
	fn drop(&mut self) {
		// SAFETY: This object uniquely owns the live descriptor and stores the
		// initialized mask/action returned by the corresponding setup calls.
		unsafe {
			libc::close(self.descriptor);
			libc::sigaction(
				libc::SIGTERM,
				&raw const self.old_term_action,
				ptr::null_mut(),
			);
			libc::pthread_sigmask(libc::SIG_SETMASK, &raw const self.old_mask, ptr::null_mut());
		}
	}
}

fn duration_millis(duration: Duration) -> libc::c_int {
	libc::c_int::try_from(duration.as_millis()).unwrap_or(libc::c_int::MAX)
}

fn supervise(program: &[OsString], critical_child: libc::pid_t) -> io::Result<ProcessStatus> {
	if program.is_empty() {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty program"));
	}
	let arguments = program
		.iter()
		.map(|argument| CString::new(argument.as_bytes()))
		.collect::<Result<Vec<_>, _>>()?;
	let mut argument_pointers = arguments
		.iter()
		.map(|argument| argument.as_ptr())
		.collect::<Vec<_>>();
	argument_pointers.push(ptr::null());

	let signals = SignalFd::new()?;
	// SAFETY: PID 1 is single-threaded here. The child branch below calls only
	// async-signal-safe libc operations before `execvp` or `_exit`.
	let child = unsafe { libc::fork() };
	if child < 0 {
		return Err(io::Error::last_os_error());
	}
	if child == 0 {
		// SAFETY: This is the post-fork single-threaded child. All pointers
		// reference prebuilt storage, and failures terminate with `_exit`.
		unsafe {
			libc::sigaction(
				libc::SIGTERM,
				&raw const signals.old_term_action,
				ptr::null_mut(),
			);
			libc::pthread_sigmask(
				libc::SIG_SETMASK,
				&raw const signals.old_mask,
				ptr::null_mut(),
			);
			libc::setpgid(0, 0);
			libc::execvp(arguments[0].as_ptr(), argument_pointers.as_ptr());
			libc::write(
				libc::STDERR_FILENO,
				EXEC_FAILURE_MESSAGE.as_ptr().cast(),
				EXEC_FAILURE_MESSAGE.len(),
			);
			libc::_exit(127);
		}
	}
	// SAFETY: `child` is the positive PID returned by `fork` in this process.
	let set_group_result = unsafe { libc::setpgid(child, child) };
	if set_group_result != 0 {
		let error = io::Error::last_os_error();
		if !matches!(error.raw_os_error(), Some(libc::EACCES | libc::ESRCH)) {
			return Err(error);
		}
	}

	let mut primary_status = None;
	while primary_status.is_none() {
		reap_children(child, critical_child, &mut primary_status)?;
		if primary_status.is_some() {
			break;
		}
		for signal in signals.wait(None)? {
			if signal != libc::SIGCHLD {
				forward_to_group(child, signal)?;
			}
		}
	}
	terminate_remaining_children(&signals, child, critical_child, &mut primary_status)?;
	Ok(primary_status.expect("primary child status must be recorded"))
}

fn forward_to_group(group: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
	// SAFETY: Negative `group` deliberately addresses the workload process
	// group, and `signal` came from a validated signalfd record.
	let result = unsafe { libc::kill(-group, signal) };
	if result == 0 {
		return Ok(());
	}
	let error = io::Error::last_os_error();
	if error.raw_os_error() == Some(libc::ESRCH) {
		Ok(())
	} else {
		Err(error)
	}
}

fn terminate_remaining_children(
	signals: &SignalFd,
	primary: libc::pid_t,
	critical_child: libc::pid_t,
	primary_status: &mut Option<ProcessStatus>,
) -> io::Result<()> {
	signal_all_children(libc::SIGTERM)?;
	if wait_for_all_children(signals, primary, critical_child, primary_status, TERM_GRACE)? {
		return Ok(());
	}
	signal_all_children(libc::SIGKILL)?;
	let _ = wait_for_all_children(signals, primary, critical_child, primary_status, KILL_GRACE)?;
	Ok(())
}

fn signal_all_children(signal: libc::c_int) -> io::Result<()> {
	// SAFETY: As guest PID 1, kill(-1) targets every signalable guest process
	// except PID 1 itself; the caller supplies SIGTERM or SIGKILL only.
	let result = unsafe { libc::kill(-1, signal) };
	if result == 0 {
		return Ok(());
	}
	let error = io::Error::last_os_error();
	if error.raw_os_error() == Some(libc::ESRCH) {
		Ok(())
	} else {
		Err(error)
	}
}

fn wait_for_all_children(
	signals: &SignalFd,
	primary: libc::pid_t,
	critical_child: libc::pid_t,
	primary_status: &mut Option<ProcessStatus>,
	timeout: Duration,
) -> io::Result<bool> {
	let deadline = Instant::now() + timeout;
	loop {
		if !reap_children(primary, critical_child, primary_status)? {
			return Ok(true);
		}
		let now = Instant::now();
		if now >= deadline {
			return Ok(false);
		}
		let _ = signals.wait(Some((deadline - now).min(Duration::from_millis(50))))?;
	}
}

fn reap_children(
	primary: libc::pid_t,
	critical_child: libc::pid_t,
	primary_status: &mut Option<ProcessStatus>,
) -> io::Result<bool> {
	loop {
		let mut status = 0;
		// SAFETY: `status` is valid writable storage and `waitpid(-1)` is the
		// intended PID 1 operation for draining every reparented child.
		let pid = unsafe { libc::waitpid(-1, &raw mut status, libc::WNOHANG) };
		if pid > 0 {
			if pid == primary {
				*primary_status = Some(ProcessStatus(status));
			} else if pid == critical_child && primary_status.is_none() {
				return Err(io::Error::other("control agent exited"));
			}
			continue;
		}
		if pid == 0 {
			return Ok(true);
		}
		let error = io::Error::last_os_error();
		if error.raw_os_error() == Some(libc::ECHILD) {
			return Ok(false);
		}
		if error.kind() == io::ErrorKind::Interrupted {
			continue;
		}
		return Err(error);
	}
}

#[derive(Clone, Copy)]
struct ProcessStatus(libc::c_int);

impl ProcessStatus {
	fn exit_code(self) -> u8 {
		if libc::WIFEXITED(self.0) {
			u8::try_from(libc::WEXITSTATUS(self.0)).unwrap_or(u8::MAX)
		} else if libc::WIFSIGNALED(self.0) {
			u8::try_from(128_i32.saturating_add(libc::WTERMSIG(self.0))).unwrap_or(u8::MAX)
		} else {
			u8::MAX
		}
	}
}

impl fmt::Display for ProcessStatus {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		if libc::WIFEXITED(self.0) {
			write!(formatter, "exit:{}", libc::WEXITSTATUS(self.0))
		} else if libc::WIFSIGNALED(self.0) {
			write!(formatter, "signal:{}", libc::WTERMSIG(self.0))
		} else {
			write!(formatter, "wait:{:#x}", self.0)
		}
	}
}

fn power_off(status: u8) -> ! {
	// SAFETY: These process-wide Linux operations take no borrowed pointers;
	// the opened descriptor is checked before use and closed if ioctl returns.
	unsafe {
		libc::sync();
		let control = libc::open(c"/dev/minisandbox".as_ptr(), libc::O_RDWR | libc::O_CLOEXEC);
		if control >= 0 {
			libc::ioctl(control, MINISANDBOX_IOCTL_EXIT, libc::c_ulong::from(status));
			libc::close(control);
		}
		libc::reboot(libc::RB_POWER_OFF);
	}
	eprintln!(
		"minisandbox-init: reboot(RB_POWER_OFF) returned: {}",
		io::Error::last_os_error()
	);
	loop {
		// SAFETY: Polling zero descriptors with an infinite timeout is the
		// intentional no-memory-access fallback after all shutdown paths fail.
		unsafe {
			libc::poll(ptr::null_mut(), 0, -1);
		}
	}
}

fn unmount_shutdown_filesystems() {
	// ActorVolume mounts are created by a fixed host-owned protocol. Remove
	// the bind mount before the underlying ext4 mount so a graceful PVM stop
	// issues the filesystem's final FLUSH before the block backend is dropped.
	for path in [c"/opt/data", c"/workspace"] {
		loop {
			// SAFETY: Each path is a static NUL-terminated string and
			// UMOUNT_NOFOLLOW prevents guest replacement with a symlink from
			// changing the fixed shutdown target.
			if unsafe { libc::umount2(path.as_ptr(), libc::UMOUNT_NOFOLLOW) } == 0 {
				break;
			}
			let error = io::Error::last_os_error();
			match error.raw_os_error() {
				Some(libc::EINTR) => {}
				Some(libc::EINVAL | libc::ENOENT) => break,
				_ => {
					eprintln!(
						"minisandbox-init: cannot unmount {} during shutdown: {error}",
						path.to_string_lossy()
					);
					break;
				}
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::{
		Action, Mode, Options, ProcessStatus, command_line_u32, command_line_word,
		overlay_mount_options, select_program,
	};
	use std::ffi::OsString;

	fn parse(arguments: &[&str]) -> Action {
		Options::parse(arguments.iter().map(OsString::from)).expect("valid options")
	}

	#[test]
	fn default_mode_is_warm() {
		let Action::Run(options) = parse(&[]) else {
			panic!("unexpected help action");
		};
		let (mode, program) = select_program(options, "console=ttyS0").expect("select program");
		assert_eq!(mode, Mode::Warm);
		assert_eq!(program, [OsString::from(super::WARM_PROGRAM)]);
	}

	#[test]
	fn command_line_selects_console() {
		let Action::Run(options) = parse(&[]) else {
			panic!("unexpected help action");
		};
		let (mode, program) =
			select_program(options, "quiet minisandbox.mode=console").expect("select program");
		assert_eq!(mode, Mode::Console);
		assert_eq!(program[0], "/sbin/agetty");
	}

	#[test]
	fn explicit_program_is_preserved() {
		let Action::Run(options) = parse(&["--", "/bin/sh", "-c", "true"]) else {
			panic!("unexpected help action");
		};
		let (_, program) = select_program(options, "").expect("select program");
		assert_eq!(
			program,
			[
				OsString::from("/bin/sh"),
				OsString::from("-c"),
				OsString::from("true")
			]
		);
	}

	#[test]
	fn command_line_matching_is_token_bounded() {
		assert!(command_line_word(
			"quiet minisandbox.overlay=1 ro",
			"minisandbox.overlay=1"
		));
		assert!(!command_line_word(
			"quiet x=minisandbox.overlay=1 ro",
			"minisandbox.overlay=1"
		));
	}

	#[test]
	fn application_layer_precedes_the_base_lower_directory() {
		assert_eq!(
			overlay_mount_options(true),
			"lowerdir=/run/minisandbox-app:/,upperdir=/run/minisandbox-upper/upper,workdir=/run/minisandbox-upper/work"
		);
		assert_eq!(
			overlay_mount_options(false),
			"lowerdir=/,upperdir=/run/minisandbox-upper/upper,workdir=/run/minisandbox-upper/work"
		);
	}

	#[test]
	fn bounded_shm_size_is_parsed_from_one_complete_token() {
		assert_eq!(
			command_line_u32(
				"quiet minisandbox.shm_mib=1024 ro",
				"minisandbox.shm_mib=",
				32,
				4096,
			)
			.expect("valid shm size"),
			1024
		);
		assert_eq!(
			command_line_u32("quiet ro", "minisandbox.shm_mib=", 32, 4096)
				.expect("default shm size"),
			32
		);
	}

	#[test]
	fn invalid_or_duplicate_shm_size_is_rejected() {
		for command_line in [
			"minisandbox.shm_mib=0",
			"minisandbox.shm_mib=4097",
			"minisandbox.shm_mib=1g",
			"minisandbox.shm_mib=32 minisandbox.shm_mib=64",
		] {
			assert!(
				command_line_u32(command_line, "minisandbox.shm_mib=", 32, 4096).is_err(),
				"accepted {command_line}"
			);
		}
	}

	#[test]
	fn workload_status_is_normalized_to_one_byte() {
		assert_eq!(ProcessStatus(42 << 8).exit_code(), 42);
		assert_eq!(ProcessStatus(libc::SIGTERM).exit_code(), 128 + 15);
		assert_eq!(ProcessStatus(0xffff).exit_code(), u8::MAX);
	}
}

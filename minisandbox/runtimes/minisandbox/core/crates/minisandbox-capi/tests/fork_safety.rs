//! A child process must not inherit usable process-local handles.

#![cfg(unix)]

use minisandbox_capi::{
    Handle, RuntimeOptions, Status, minisandbox_release, minisandbox_runtime_create,
};

#[test]
fn handles_created_before_fork_are_invalid_in_the_child() {
    let options = RuntimeOptions::default();
    let mut runtime: Handle = 0;
    // SAFETY: Both pointers address live public ABI values.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(std::ptr::addr_of!(options), std::ptr::addr_of_mut!(runtime))
        },
        Status::Ok
    );

    // SAFETY: This single-test process has no application threads or registered
    // atfork callbacks; the child only calls async-process-local Rust/C code and
    // exits immediately without running parent destructors.
    let child = unsafe { libc::fork() };
    assert!(
        child >= 0,
        "fork failed: {}",
        std::io::Error::last_os_error()
    );
    if child == 0 {
        let status = minisandbox_release(runtime);
        // SAFETY: `_exit` terminates only the fork child without flushing or
        // touching inherited parent-side runtime state.
        unsafe { libc::_exit(i32::from(status != Status::InvalidHandle)) };
    }

    let mut wait_status = 0;
    // SAFETY: `child` is the positive PID returned above and `wait_status` is
    // writable for one wait status word.
    assert_eq!(
        unsafe { libc::waitpid(child, std::ptr::addr_of_mut!(wait_status), 0) },
        child
    );
    assert!(libc::WIFEXITED(wait_status));
    assert_eq!(libc::WEXITSTATUS(wait_status), 0);

    assert_eq!(minisandbox_release(runtime), Status::Ok);
}

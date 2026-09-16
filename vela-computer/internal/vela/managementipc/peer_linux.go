//go:build linux

package managementipc

import (
	"errors"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

func verifySameUser(connection *net.UnixConn) error {
	raw, err := connection.SyscallConn()
	if err != nil {
		return err
	}
	var peerUID uint32
	var controlErr error
	if err := raw.Control(func(fd uintptr) {
		credential, err := unix.GetsockoptUcred(
			int(fd),
			unix.SOL_SOCKET,
			unix.SO_PEERCRED,
		)
		if err != nil {
			controlErr = err
			return
		}
		peerUID = credential.Uid
	}); err != nil {
		return err
	}
	if controlErr != nil {
		return controlErr
	}
	if int(peerUID) != os.Geteuid() {
		return errors.New("Vela 管理 IPC 拒绝其他用户")
	}
	return nil
}

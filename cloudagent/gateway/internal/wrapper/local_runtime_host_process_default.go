//go:build !unix

package wrapper

import "os/exec"

func configureLocalRuntimeCommand(cmd *exec.Cmd) {}

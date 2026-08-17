//go:build !darwin && !linux

package install

func NewUserLaunchAgent() (Launcher, error) {
	return nil, ErrServiceInvalid
}

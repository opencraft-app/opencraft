//go:build !darwin

package install

func NewUserLaunchAgent() (Launcher, error) {
	return nil, ErrServiceInvalid
}

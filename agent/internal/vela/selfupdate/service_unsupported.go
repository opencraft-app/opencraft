//go:build !(darwin && arm64) && !(linux && amd64)

package selfupdate

func NewPlatformMainServiceManager() (MainServiceManager, error) {
	return nil, ErrTransactionInvalid
}

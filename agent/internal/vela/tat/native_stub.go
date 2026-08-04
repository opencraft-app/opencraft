//go:build !vela_tat_cgo || !darwin || !arm64

package tat

type unavailableBridge struct{}

func defaultNativeBridge() nativeBridge {
	return unavailableBridge{}
}

func (unavailableBridge) register(
	_ string,
	_ string,
	_ string,
	_ string,
	_ string,
) error {
	return ErrNativeUnavailable
}

func (unavailableBridge) start(_ string) (nativeHandle, error) {
	return nil, ErrNativeUnavailable
}

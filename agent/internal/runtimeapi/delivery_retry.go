package runtimeapi

import "errors"

type RetryDisposition string

const (
	RetryDelayedIdle  RetryDisposition = "delayed_idle"
	RetryTurnBoundary RetryDisposition = "turn_boundary"
)

type RetryableDeliveryError struct {
	Disposition RetryDisposition
	Cause       error
}

func NewRetryableDeliveryError(
	disposition RetryDisposition,
	cause error,
) *RetryableDeliveryError {
	return &RetryableDeliveryError{
		Disposition: disposition,
		Cause:       cause,
	}
}

func (e *RetryableDeliveryError) Error() string {
	if e == nil || e.Cause == nil {
		return "Runtime delivery was rejected"
	}
	return e.Cause.Error()
}

func (e *RetryableDeliveryError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func DeliveryRetryDisposition(err error) (RetryDisposition, bool) {
	var retryable *RetryableDeliveryError
	if !errors.As(err, &retryable) || retryable == nil {
		return "", false
	}
	switch retryable.Disposition {
	case RetryDelayedIdle, RetryTurnBoundary:
		return retryable.Disposition, true
	default:
		return "", false
	}
}

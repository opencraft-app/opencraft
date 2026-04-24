// Package util ...
package util

import (
	"fmt"

	"github.com/onsi/ginkgo"
)

// GinkgoTestReporter ...
type GinkgoTestReporter struct{}

// Errorf ...
func (g GinkgoTestReporter) Errorf(format string, args ...interface{}) {
	ginkgo.Fail(fmt.Sprint(format, args))
}

// Fatalf ...
func (g GinkgoTestReporter) Fatalf(format string, args ...interface{}) {
	ginkgo.Fail(fmt.Sprint(format, args))
}

// Package util ...
package util

import (
	"sync"
)

// MultiRunFunc ...
type MultiRunFunc func()

// MultiRun ...
func MultiRun(funcList []MultiRunFunc) {
	wg := new(sync.WaitGroup)
	for i := 0; i < len(funcList); i++ {
		f := funcList[i]
		wg.Add(1)

		go func() {
			defer wg.Done()
			f()
		}()
	}

	wg.Wait()
}

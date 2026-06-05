//go:build noprogress

/*
 * JuiceFS, Copyright 2026 Juicedata, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package utils

import "sync/atomic"

type Progress struct {
	Quiet bool
}

type Bar struct {
	total   atomic.Int64
	current atomic.Int64
	done    atomic.Bool
}

func (b *Bar) IncrTotal(n int64) {
	b.total.Add(n)
}

func (b *Bar) SetTotal(total int64) {
	b.total.Store(total)
}

func (b *Bar) GetTotal() int64 {
	return b.total.Load()
}

func (b *Bar) Done() {
	b.done.Store(true)
}

func (b *Bar) Completed() bool {
	return b.done.Load()
}

func (b *Bar) Increment() {
	b.current.Add(1)
}

func (b *Bar) IncrInt64(n int64) {
	b.current.Add(n)
}

func (b *Bar) SetCurrent(n int64) {
	b.current.Store(n)
}

func (b *Bar) Current() int64 {
	return b.current.Load()
}

type DoubleSpinner struct {
	count *Bar
	bytes *Bar
}

func (s *DoubleSpinner) IncrInt64(size int64) {
	s.count.Increment()
	s.bytes.IncrInt64(size)
}

func (s *DoubleSpinner) Done() {
	s.count.Done()
	s.bytes.Done()
}

func (s *DoubleSpinner) Current() (int64, int64) {
	return s.count.Current(), s.bytes.Current()
}

func (s *DoubleSpinner) SetCurrent(count, bytes int64) {
	s.count.SetCurrent(count)
	s.bytes.SetCurrent(bytes)
}

func NewProgress(quiet bool) *Progress {
	return &Progress{Quiet: true}
}

func (p *Progress) AddCountBar(name string, total int64) *Bar {
	bar := &Bar{}
	bar.SetTotal(total)
	return bar
}

func (p *Progress) AddCountSpinner(name string) *Bar {
	return &Bar{}
}

func (p *Progress) AddByteSpinner(name string) *Bar {
	return &Bar{}
}

func (p *Progress) AddIoSpeedBar(name string, total int64) *Bar {
	bar := &Bar{}
	bar.SetTotal(total)
	return bar
}

func (p *Progress) AddDoubleSpinner(name string) *DoubleSpinner {
	return &DoubleSpinner{
		p.AddCountSpinner(name),
		p.AddByteSpinner(name),
	}
}

func (p *Progress) AddDoubleSpinnerTwo(countName, sizeName string) *DoubleSpinner {
	return &DoubleSpinner{
		p.AddCountSpinner(countName),
		p.AddByteSpinner(sizeName),
	}
}

func (p *Progress) Done() {}

func MockProgress() (*Progress, *Bar) {
	progress := NewProgress(true)
	bar := progress.AddCountBar("Mock", 0)
	return progress, bar
}

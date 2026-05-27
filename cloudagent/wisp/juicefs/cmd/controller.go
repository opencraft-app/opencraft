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

package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/utils"
)

func openController(dpath string) (*os.File, error) {
	st, err := os.Stat(dpath)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		dpath = filepath.Dir(dpath)
	}
	fp, err := os.OpenFile(filepath.Join(dpath, ".jfs.control"), os.O_RDWR, 0)
	if os.IsNotExist(err) {
		fp, err = os.OpenFile(filepath.Join(dpath, ".control"), os.O_RDWR, 0)
	}
	return fp, err
}

func findMountpoint(fpath string) (string, error) {
	for p := fpath; p != "/"; p = filepath.Dir(p) {
		inode, err := utils.GetFileInode(p)
		if err != nil {
			return "", fmt.Errorf("get inode of %s: %s", p, err)
		}
		if inode == uint64(meta.RootInode) {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s is not inside JuiceFS", fpath)
}

const maxControlReadInterval = 300
const minControlReadInterval = 1

var controlReadInterval int

func readControl(cf *os.File, resp []byte) int {
	if controlReadInterval <= 0 {
		controlReadInterval = 10
	}
	for {
		n, err := cf.Read(resp)
		if err == nil {
			controlReadInterval = max(controlReadInterval/2, minControlReadInterval)
			return n
		}
		if err == io.EOF {
			controlReadInterval = min(controlReadInterval*2, maxControlReadInterval)
			time.Sleep(time.Millisecond * time.Duration(controlReadInterval))
			continue
		}
		if errors.Is(err, syscall.EBADF) {
			logger.Fatalf("JuiceFS client was restarted")
		}
		logger.Fatalf("Read message: %d %s", n, err)
	}
}

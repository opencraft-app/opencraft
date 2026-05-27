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
	"runtime"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/utils"
)

var ctx = meta.NewContext(1, uint32(utils.GetCurrentUID()), []uint32{uint32(utils.GetCurrentGID())})
var umask = uint16(utils.GetUmask())

func init() {
	// For all the juicefs command, we treat admin/elevated privilege user as root(0) on Windows
	// just like the mount option '-adminasroot' does for the mounted filesystem.
	if runtime.GOOS == "windows" && utils.IsWinAdminOrElevatedPrivilege() {
		ctx = meta.NewContext(1, 0, []uint32{0})
	}
}

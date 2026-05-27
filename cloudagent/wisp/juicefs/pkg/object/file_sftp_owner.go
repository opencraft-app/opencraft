//go:build !windows && !nosftp

package object

import (
	"github.com/juicedata/juicefs/pkg/utils"
	"github.com/pkg/sftp"
)

func getSFTPOwnerGroup(sys any) (string, string, bool) {
	st, ok := sys.(*sftp.FileStat)
	if !ok {
		return "", "", false
	}
	return utils.UserName(int(st.UID)), utils.GroupName(int(st.GID)), true
}

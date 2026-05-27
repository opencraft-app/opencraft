//go:build !windows && nosftp

package object

func getSFTPOwnerGroup(any) (string, string, bool) {
	return "", "", false
}

//go:build unix

package fileguard

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func tryLockStorageFile(file *os.File, exclusive bool) (bool, error) {
	op := unix.LOCK_SH
	if exclusive {
		op = unix.LOCK_EX
	}
	err := unix.Flock(int(file.Fd()), op|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EINTR) {
		return false, nil
	}
	return err == nil, err
}

func unlockStorageFile(file *os.File) { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN) }

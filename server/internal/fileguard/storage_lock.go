package fileguard

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var ErrStorageRecoveryRequired = errors.New("storage restore commit requires recovery")

func storageLockPaths(roots ...string) ([]string, error) {
	paths := map[string]bool{}
	for _, root := range roots {
		if strings.TrimSpace(root) == "" {
			continue
		}
		abs, err := filepath.Abs(root)
		if err != nil {
			return nil, err
		}
		parent := filepath.Dir(abs)
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return nil, err
		}
		parent, err = filepath.EvalSymlinks(parent)
		if err != nil {
			return nil, err
		}
		key := sha256.Sum256([]byte(filepath.Join(parent, filepath.Base(abs))))
		paths[filepath.Join(parent, fmt.Sprintf(".aivory-storage-%x.lock", key[:8]))] = true
	}
	ordered := make([]string, 0, len(paths))
	for path := range paths {
		ordered = append(ordered, path)
	}
	sort.Strings(ordered)
	return ordered, nil
}

// RequireStorageRecovery preserves a durable explanation next to the lock.
// Call only while holding the exclusive lock. Subsequent writers, cleaners,
// imports and exports must wait for an operator to resolve the DB outcome;
// otherwise a missing-file repair could delete still-valid old metadata.
func RequireStorageRecovery(details []byte, roots ...string) error {
	paths, err := storageLockPaths(roots...)
	if err != nil {
		return err
	}
	var errs []error
	for _, path := range paths {
		file, err := os.OpenFile(path+".recovery", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			if errors.Is(err, os.ErrExist) {
				if existing, readErr := os.ReadFile(path + ".recovery"); readErr == nil && string(existing) == string(details) {
					continue
				}
			}
			errs = append(errs, err)
			continue
		}
		_, writeErr := file.Write(details)
		syncErr := file.Sync()
		closeErr := file.Close()
		errs = append(errs, writeErr, syncErr, closeErr)
	}
	return errors.Join(errs...)
}

// ClearStorageRecovery removes only this restore's journal. The caller must
// still hold the exclusive storage lock and have resolved the DB outcome.
func ClearStorageRecovery(details []byte, roots ...string) error {
	paths, err := storageLockPaths(roots...)
	if err != nil {
		return err
	}
	var errs []error
	for _, path := range paths {
		path += ".recovery"
		existing, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err == nil && string(existing) != string(details) {
			err = fmt.Errorf("restore journal changed: %s", path)
		}
		if err == nil {
			err = os.Remove(path)
		}
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// LockStorage coordinates file writers/cleaners with backup and restore, also
// across API processes sharing the same storage. Lock files live BESIDE roots:
// restore renames/replaces the roots themselves. Never unlink these lock files.
// Take this lock before opening a database transaction, in every caller.
func LockStorage(ctx context.Context, exclusive bool, roots ...string) (func(), error) {
	ordered, err := storageLockPaths(roots...)
	if err != nil {
		return nil, err
	}
	var held []*os.File
	unlock := func() {
		for i := len(held) - 1; i >= 0; i-- {
			unlockStorageFile(held[i])
			_ = held[i].Close()
		}
		held = nil
	}
	for _, path := range ordered {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			unlock()
			return nil, err
		}
		for {
			if err = ctx.Err(); err != nil {
				break
			}
			var acquired bool
			acquired, err = tryLockStorageFile(file, exclusive)
			if err != nil || acquired {
				break
			}
			select {
			case <-ctx.Done():
			case <-time.After(25 * time.Millisecond):
			}
		}
		if err != nil {
			_ = file.Close()
			unlock()
			return nil, err
		}
		held = append(held, file)
	}
	for _, path := range ordered {
		if _, err := os.Stat(path + ".recovery"); err == nil {
			unlock()
			return nil, fmt.Errorf("%w: %s", ErrStorageRecoveryRequired, path+".recovery")
		} else if !errors.Is(err, os.ErrNotExist) {
			unlock()
			return nil, err
		}
	}
	return unlock, nil
}

package fileguard

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestStorageLockAcrossProcesses(t *testing.T) {
	const helperRoot = "AIVORY_TEST_STORAGE_LOCK_ROOT"
	if root := os.Getenv(helperRoot); root != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		if unlock, err := LockStorage(ctx, false, root); !errors.Is(err, context.DeadlineExceeded) {
			if unlock != nil {
				unlock()
			}
			t.Fatalf("other process bypassed exclusive lock: %v", err)
		}
		return
	}
	root := filepath.Join(t.TempDir(), "artifacts")
	unlock, err := LockStorage(t.Context(), true, root)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	cmd := exec.Command(os.Args[0], "-test.run=^TestStorageLockAcrossProcesses$")
	cmd.Env = append(os.Environ(), helperRoot+"="+root)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %v\n%s", err, output)
	}
}

func TestStorageSharedLockAllowsWritersAndSurvivesDirectoryReplacement(t *testing.T) {
	root := filepath.Join(t.TempDir(), "artifacts")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	first, err := LockStorage(t.Context(), false, root)
	if err != nil {
		t.Fatal(err)
	}
	defer first()
	second, err := LockStorage(t.Context(), false, root)
	if err != nil {
		t.Fatal(err)
	}
	second()
	if err := os.Rename(root, root+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if unlock, err := LockStorage(ctx, true, root); !errors.Is(err, context.DeadlineExceeded) {
		if unlock != nil {
			unlock()
		}
		t.Fatalf("replacement bypassed existing lock: %v", err)
	}
}

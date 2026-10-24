package api

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"aivory/server/internal/fileguard"
	"aivory/server/internal/store"
)

type backupExportSnapshot struct {
	tx                     *sql.Tx
	uploadDir, artifactDir string
}

func (s *backupExportSnapshot) release() {
	_ = s.tx.Rollback()
	for _, dir := range []string{s.uploadDir, s.artifactDir} {
		if dir != "" {
			_ = os.RemoveAll(dir)
		}
	}
}

// Coordinate the database snapshot and file pins, then release the storage lock
// BEFORE compression or remote I/O. Local objects use unique immutable names;
// hard links keep their bytes alive even when normal cleanup unlinks originals.
func prepareBackupExport(ctx context.Context, d Deps, includeFiles bool) (*backupExportSnapshot, error) {
	unlock := func() {}
	if includeFiles {
		var err error
		unlock, err = fileguard.LockStorage(ctx, true, d.Config.UploadDir, d.Config.ArtifactDir)
		if err != nil {
			return nil, err
		}
		defer unlock()
		count, err := store.RepairMissingStorage(ctx, d.DB, d.Config.UploadDir, d.Config.ArtifactDir)
		if err != nil {
			return nil, fmt.Errorf("repair missing stored files: %w", err)
		}
		if count > 0 && d.Logger != nil {
			d.Logger.Printf("backup export: removed %d missing local file records and repaired conversation references", count)
		}
	}
	tx, err := beginBackupSnapshot(ctx, d.DB)
	if err != nil {
		return nil, err
	}
	snapshot := &backupExportSnapshot{tx: tx}
	if includeFiles {
		// BEGIN alone does not materialize a repeatable-read snapshot.
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM artifacts`).Scan(&count); err != nil {
			snapshot.release()
			return nil, err
		}
		snapshot.uploadDir, err = pinBackupStorageTree(ctx, d.Config.UploadDir)
		if err == nil {
			snapshot.artifactDir, err = pinBackupStorageTree(ctx, d.Config.ArtifactDir)
		}
		if err != nil {
			snapshot.release()
			return nil, fmt.Errorf("snapshot stored files: %w", err)
		}
	}
	return snapshot, nil
}

func pinBackupStorageTree(ctx context.Context, root string) (string, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(filepath.Dir(abs), ".aivory-backup-snapshot-")
	if err != nil {
		return "", err
	}
	err = filepath.WalkDir(abs, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() || !entry.Type().IsRegular() {
			return nil
		}
		safe, err := fileguard.ResolveExisting(path, abs)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(abs, path)
		if err != nil {
			return err
		}
		dest := filepath.Join(stage, rel)
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return err
		}
		if err := os.Link(safe, dest); err == nil {
			return nil
		}
		// Filesystems without hard links still get an isolated copy, while the
		// storage lock prevents file replacement/deletion during the copy.
		in, err := os.Open(safe)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	if err != nil {
		_ = os.RemoveAll(stage)
		return "", err
	}
	return stage, nil
}

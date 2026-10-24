package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrStoragePersistenceUncertain means a commit may have succeeded. Callers
// must retain the bytes even when a subsequent read fails or finds no row:
// the original transaction could still be completing on the server.
var ErrStoragePersistenceUncertain = errors.New("stored file commit outcome is uncertain")

// ErrArtifactPersistenceUncertain is retained for artifact callers.
var ErrArtifactPersistenceUncertain = ErrStoragePersistenceUncertain

func commitStorageRecord(ctx context.Context, db *sql.DB, tx *sql.Tx, table, id, path string) error {
	if err := tx.Commit(); err != nil {
		verifyCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		var storedPath string
		// table is supplied only by the file/document/artifact insert functions.
		if readErr := db.QueryRowContext(verifyCtx, "SELECT storage_path FROM "+table+" WHERE id=?", id).Scan(&storedPath); readErr == nil && storedPath == path {
			return nil
		}
		return fmt.Errorf("%w: %w", ErrStoragePersistenceUncertain, err)
	}
	return nil
}

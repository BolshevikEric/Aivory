package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"aivory/server/internal/fileguard"
	"aivory/server/internal/store"
)

type backupRestoreTokenKey struct{}

const backupRestoreCommitSetting = "internal_backup_restore_commit"

type backupCommitUncertainError struct {
	token string
	cause error
}

func (e *backupCommitUncertainError) Error() string {
	return fmt.Sprintf("backup restore commit outcome is uncertain (token=%s): %v", e.token, e.cause)
}
func (e *backupCommitUncertainError) Unwrap() error { return e.cause }

type backupCommitReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// Write a fresh witness in the SAME transaction as the restored rows. The
// archive's own values and pre-existing rows cannot prove this import committed.
func commitBackupRestore(ctx context.Context, tx *sql.Tx, reader backupCommitReader) error {
	token, _ := ctx.Value(backupRestoreTokenKey{}).(string)
	if token == "" {
		token = store.GenID("restore")
	}
	value, _ := json.Marshal(token)
	if _, err := tx.ExecContext(ctx, `INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, backupRestoreCommitSetting, string(value), time.Now().Unix()); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		verifyCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		var committed string
		if readErr := reader.QueryRowContext(verifyCtx, `SELECT value FROM settings WHERE key=?`, backupRestoreCommitSetting).Scan(&committed); readErr == nil && committed == string(value) {
			return nil
		}
		return &backupCommitUncertainError{token: token, cause: err}
	}
	return nil
}

// An unknown outcome must never run compensating deletes: either set of rows
// may be authoritative. Retain both trees and the Qdrant rollback archive, and
// block later storage mutation until the witness can be checked by an operator.
func preserveUncertainBackupRestore(d Deps, files *backupFileRestore, qdrant *backupQdrantRestore, uncertain *backupCommitUncertainError) error {
	details, err := backupRestoreRecoveryDetails(files, qdrant, uncertain.token)
	retainBackupRestoreState(files, qdrant)
	if err == nil {
		err = fileguard.RequireStorageRecovery(details, d.Config.UploadDir, d.Config.ArtifactDir)
	}
	if d.Logger != nil {
		d.Logger.Printf("backup import requires recovery; both file versions retained: %s; marker error: %v", details, err)
	}
	return errors.Join(uncertain, err)
}

func retainBackupRestoreState(files *backupFileRestore, qdrant *backupQdrantRestore) {
	if files != nil {
		files.committed = true // suppress automatic rollback/cleanup; retain both trees
	}
	if qdrant != nil {
		qdrant.committed = true
		if qdrant.previousFile != nil {
			_ = qdrant.previousFile.Close()
		}
	}
}

func backupRestoreRecoveryDetails(files *backupFileRestore, qdrant *backupQdrantRestore, token string) ([]byte, error) {
	type recoveryTree struct {
		Target    string `json:"target"`
		Previous  string `json:"previous"`
		Stage     string `json:"stage"`
		HadTarget bool   `json:"had_target"`
	}
	state := struct {
		Token          string         `json:"token"`
		Setting        string         `json:"commit_setting"`
		Trees          []recoveryTree `json:"trees"`
		QdrantPrevious string         `json:"qdrant_previous,omitempty"`
	}{Token: token, Setting: backupRestoreCommitSetting}
	if files != nil {
		for _, tree := range files.trees {
			state.Trees = append(state.Trees, recoveryTree{tree.target, tree.previous, tree.stage, tree.hadTarget})
		}
	}
	if qdrant != nil {
		state.QdrantPrevious = qdrant.previousPath
	}
	return json.MarshalIndent(state, "", "  ")
}

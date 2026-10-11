package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// Queue physical work before deleting its source rows. The ledger has no FKs:
// committing a deletion or restarting the server cannot lose its resource IDs.
func queueConversationCleanupTx(ctx context.Context, tx *sql.Tx, ids, paths []string, userID string) (*ConversationDeletionState, error) {
	state := &ConversationDeletionState{ConversationIDs: ids, StoragePaths: paths}
	// Prevent a concurrently provisioned sandbox ID from being committed after
	// its cleanup snapshot but before the conversation DELETE.
	if len(ids) > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE conversations SET id=id WHERE id IN (`+idPlaceholders(len(ids))+`)`, anySlice(ids)...); err != nil {
			return nil, err
		}
	}
	if err := insertPendingStorageCleanupTx(ctx, tx, userID, paths); err != nil {
		return nil, err
	}
	for _, id := range ids {
		var raw string
		if err := tx.QueryRowContext(ctx, `SELECT provider_state FROM conversations WHERE id=?`, id).Scan(&raw); err != nil {
			return nil, err
		}
		var provider struct {
			SessionID *string `json:"sandbox_id"`
		}
		_ = json.Unmarshal([]byte(raw), &provider)
		if provider.SessionID == nil {
			continue // this conversation never provisioned a sandbox or archive
		}
		item := ConversationSandboxDiscard{ConversationID: id, SessionID: *provider.SessionID}
		if err := insertPendingSandboxCleanup(ctx, tx, item); err != nil {
			return nil, err
		}
		state.SandboxDiscards = append(state.SandboxDiscards, item)
	}
	return state, nil
}

type cleanupExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func migrateCleanupLedger(db *sql.DB) error {
	for _, column := range []struct{ name, ddl string }{
		{"attempts", "INTEGER NOT NULL DEFAULT 0"},
		{"last_error", "TEXT NOT NULL DEFAULT ''"},
	} {
		exists, err := columnExists(db, "pending_storage_cleanup", column.name)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := db.Exec(`ALTER TABLE pending_storage_cleanup ADD COLUMN ` + column.name + ` ` + column.ddl); err != nil {
				return err
			}
		}
	}
	for _, table := range []string{"pending_storage_cleanup", "pending_sandbox_cleanup"} {
		if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_` + table + `_retry ON ` + table + `(attempts,created_at)`); err != nil {
			return err
		}
	}
	return nil
}

func insertPendingStorageCleanupTx(ctx context.Context, tx *sql.Tx, userID string, paths []string) error {
	for _, path := range paths {
		if path == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO pending_storage_cleanup(path,user_id,created_at) VALUES(?,?,?) ON CONFLICT(path) DO NOTHING`, path, userID, time.Now().Unix()); err != nil {
			return err
		}
	}
	return nil
}

func insertPendingSandboxCleanup(ctx context.Context, ex cleanupExecer, item ConversationSandboxDiscard) error {
	_, err := ex.ExecContext(ctx, `INSERT INTO pending_sandbox_cleanup(conversation_id,session_id,created_at) VALUES(?,?,?) ON CONFLICT(conversation_id,session_id) DO NOTHING`, item.ConversationID, item.SessionID, time.Now().Unix())
	return err
}

// QueueSandboxCleanup also covers sessions provisioned while their conversation
// was being deleted, too late to appear in the deletion transaction's snapshot.
func QueueSandboxCleanup(ctx context.Context, db *sql.DB, item ConversationSandboxDiscard) error {
	return insertPendingSandboxCleanup(ctx, db, item)
}

func DeletePendingSandboxCleanup(ctx context.Context, db *sql.DB, item ConversationSandboxDiscard) error {
	_, err := db.ExecContext(ctx, `DELETE FROM pending_sandbox_cleanup WHERE conversation_id=? AND session_id=?`, item.ConversationID, item.SessionID)
	return err
}

func RecordSandboxCleanupFailure(ctx context.Context, db *sql.DB, item ConversationSandboxDiscard, failure error) error {
	_, err := db.ExecContext(ctx, `UPDATE pending_sandbox_cleanup SET attempts=attempts+1,last_error=? WHERE conversation_id=? AND session_id=?`, cleanupErrorText(failure), item.ConversationID, item.SessionID)
	return err
}

func RecordStorageCleanupAttempt(ctx context.Context, db *sql.DB, path string, failure error) error {
	_, err := db.ExecContext(ctx, `UPDATE pending_storage_cleanup SET attempts=attempts+1,last_error=? WHERE path=?`, cleanupErrorText(failure), path)
	return err
}

func cleanupErrorText(err error) string {
	if err == nil {
		return ""
	}
	text := []rune(err.Error())
	return string(text[:min(len(text), 2048)])
}

func PendingStorageCleanupBatch(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT path FROM pending_storage_cleanup ORDER BY attempts,created_at,path LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	paths := []string{}
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, rows.Err()
}

func ListPendingSandboxCleanup(ctx context.Context, db *sql.DB) ([]ConversationSandboxDiscard, error) {
	rows, err := db.QueryContext(ctx, `SELECT conversation_id,session_id FROM pending_sandbox_cleanup ORDER BY attempts,created_at,conversation_id,session_id LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ConversationSandboxDiscard{}
	for rows.Next() {
		var item ConversationSandboxDiscard
		if err := rows.Scan(&item.ConversationID, &item.SessionID); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

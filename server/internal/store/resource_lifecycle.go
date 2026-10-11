package store

import (
	"context"
	"database/sql"
)

// Deletion triggers cover direct deletes and every FK cascade (file, draft,
// conversation, KB and user), including deletions in another API process.
func migrateResourceLifecycles(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS resource_lifecycle_migrations (key TEXT PRIMARY KEY)`); err != nil {
		return err
	}
	if usePostgres {
		statements := []string{
			`CREATE OR REPLACE FUNCTION queue_deleted_document_vectors() RETURNS trigger AS $$
BEGIN
 INSERT INTO pending_vector_cleanup(document_id,created_at) VALUES(OLD.id,EXTRACT(EPOCH FROM NOW())::BIGINT)
 ON CONFLICT(document_id) DO NOTHING;
 RETURN OLD;
END; $$ LANGUAGE plpgsql`,
			`DROP TRIGGER IF EXISTS queue_deleted_document_vectors ON documents`,
			`CREATE TRIGGER queue_deleted_document_vectors AFTER DELETE ON documents FOR EACH ROW EXECUTE FUNCTION queue_deleted_document_vectors()`,
			`CREATE OR REPLACE FUNCTION queue_deleted_user_avatars() RETURNS trigger AS $$
BEGIN
 UPDATE avatar_objects SET state='deleting' WHERE user_id=OLD.id;
 RETURN OLD;
END; $$ LANGUAGE plpgsql`,
			`DROP TRIGGER IF EXISTS queue_deleted_user_avatars ON users`,
			`CREATE TRIGGER queue_deleted_user_avatars AFTER DELETE ON users FOR EACH ROW EXECUTE FUNCTION queue_deleted_user_avatars()`,
		}
		for _, statement := range statements {
			if _, err := db.Exec(statement); err != nil {
				return err
			}
		}
	} else {
		_, err := db.Exec(`
CREATE TRIGGER IF NOT EXISTS queue_deleted_document_vectors AFTER DELETE ON documents BEGIN
 INSERT INTO pending_vector_cleanup(document_id,created_at) VALUES(OLD.id,strftime('%s','now')) ON CONFLICT(document_id) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS queue_deleted_user_avatars AFTER DELETE ON users BEGIN
 UPDATE avatar_objects SET state='deleting' WHERE user_id=OLD.id;
END;`)
		if err != nil {
			return err
		}
	}
	var backfilled int
	if err := db.QueryRow(`SELECT COUNT(*) FROM resource_lifecycle_migrations WHERE key='avatar_ownership_v1'`).Scan(&backfilled); err != nil {
		return err
	}
	if backfilled == 0 {
		if err := BackfillManagedAvatarOwnership(context.Background(), db); err != nil {
			return err
		}
		if _, err := db.Exec(`INSERT INTO resource_lifecycle_migrations(key) VALUES('avatar_ownership_v1') ON CONFLICT(key) DO NOTHING`); err != nil {
			return err
		}
	}
	return nil
}

// Register a bounded external write while briefly locking its source row.
// The transaction ends before network I/O, so a slow Qdrant cannot hold the
// SQLite writer lock or block unrelated requests.
func BeginDocumentVectorWrite(ctx context.Context, db *sql.DB, documentID, writeID string, expiresAt int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE documents SET id=id WHERE id=?`, documentID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO document_vector_writes(write_id,document_id,expires_at) VALUES(?,?,?)`, writeID, documentID, expiresAt); err != nil {
		return err
	}
	return tx.Commit()
}

func FinishDocumentVectorWrite(ctx context.Context, db *sql.DB, writeID string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM document_vector_writes WHERE write_id=?`, writeID)
	return err
}

func PendingVectorCleanup(ctx context.Context, db *sql.DB, now int64) ([]string, error) {
	if _, err := db.ExecContext(ctx, `DELETE FROM document_vector_writes WHERE expires_at<=?`, now); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT p.document_id FROM pending_vector_cleanup p
 WHERE NOT EXISTS(SELECT 1 FROM document_vector_writes w WHERE w.document_id=p.document_id)
 AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.id=p.document_id)
 ORDER BY p.attempts,p.created_at,p.document_id LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func VectorCleanupReady(ctx context.Context, db *sql.DB, documentID string) (bool, error) {
	var n int
	err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pending_vector_cleanup p WHERE p.document_id=?
 AND NOT EXISTS(SELECT 1 FROM document_vector_writes w WHERE w.document_id=p.document_id)
 AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.id=p.document_id)`, documentID).Scan(&n)
	return n > 0, err
}

func CompleteVectorCleanup(ctx context.Context, db *sql.DB, documentID string, failure error) error {
	if failure != nil {
		_, err := db.ExecContext(ctx, `UPDATE pending_vector_cleanup SET attempts=attempts+1,last_error=? WHERE document_id=?`, cleanupErrorText(failure), documentID)
		return err
	}
	_, err := db.ExecContext(ctx, `DELETE FROM pending_vector_cleanup WHERE document_id=?`, documentID)
	return err
}

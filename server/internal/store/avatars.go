package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrAvatarUnavailable = errors.New("avatar is expired, deleted, or belongs to another account")

const avatarURLPrefix = "/api/avatars/"

func managedAvatarFilename(value any) string {
	url, _ := value.(string)
	if !strings.HasPrefix(url, avatarURLPrefix) {
		return ""
	}
	filename := strings.TrimPrefix(url, avatarURLPrefix)
	if filename == "" || strings.ContainsAny(filename, "/\\?#") || strings.Contains(filename, "..") {
		return ""
	}
	if !strings.HasSuffix(filename, ".png") && !strings.HasSuffix(filename, ".jpeg") {
		return ""
	}
	return filename
}

// BackfillManagedAvatarOwnership supports imports from backups created before
// avatar objects had an ownership ledger. Call it after restoring users and any
// avatar_objects table from the archive.
func BackfillManagedAvatarOwnership(ctx context.Context, ex RowExecer) error {
	rows, err := ex.QueryContext(ctx, `SELECT id,settings FROM users`)
	if err != nil {
		return err
	}
	type legacyAvatar struct{ filename, userID string }
	var legacy []legacyAvatar
	for rows.Next() {
		var userID, raw string
		if err := rows.Scan(&userID, &raw); err != nil {
			rows.Close()
			return err
		}
		var settings map[string]any
		_ = json.Unmarshal([]byte(raw), &settings)
		if filename := managedAvatarFilename(settings["avatar_url"]); filename != "" {
			legacy = append(legacy, legacyAvatar{filename, userID})
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range legacy {
		if _, err := ex.ExecContext(ctx, `INSERT INTO avatar_objects(filename,user_id,state,created_at,expires_at) VALUES(?,?,'attached',0,0) ON CONFLICT(filename) DO NOTHING`, item.filename, item.userID); err != nil {
			return err
		}
	}
	return nil
}

// Register before Put: even a crash or a failed settings save leaves a bounded
// pending object. Retain the record across user deletion to retry physical I/O.
func RegisterAvatarUpload(ctx context.Context, db *sql.DB, userID, filename string, writeUntil int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE users SET id=id WHERE id=? AND status='active'`, userID)
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
	if _, err := tx.ExecContext(ctx, `UPDATE avatar_objects SET state='deleting' WHERE user_id=? AND state='pending'`, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO avatar_objects(filename,user_id,state,created_at,expires_at,write_until) VALUES(?,?,'pending',?,?,?)`, filename, userID, time.Now().Unix(), time.Now().Add(time.Hour).Unix(), writeUntil); err != nil {
		return err
	}
	return tx.Commit()
}

func FinishAvatarUpload(ctx context.Context, db *sql.DB, filename string, success bool) error {
	if !success {
		// Keep write_until: a timed-out object request may still finish remotely.
		_, err := db.ExecContext(ctx, `UPDATE avatar_objects SET state='deleting' WHERE filename=?`, filename)
		return err
	}
	_, err := db.ExecContext(ctx, `UPDATE avatar_objects SET write_until=0 WHERE filename=?`, filename)
	if err != nil {
		return err
	}
	var state string
	err = db.QueryRowContext(ctx, `SELECT a.state FROM avatar_objects a JOIN users u ON u.id=a.user_id WHERE a.filename=? AND u.status='active'`, filename).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && state != "pending") {
		return ErrAvatarUnavailable
	}
	return err
}

func updateAvatarSettingsTx(ctx context.Context, tx *sql.Tx, userID string, current, patch map[string]any) error {
	value, changed := patch["avatar_url"]
	if !changed {
		return nil
	}
	url, valid := value.(string)
	if !valid {
		return ErrAvatarUnavailable
	}
	old := managedAvatarFilename(current["avatar_url"])
	filename := managedAvatarFilename(url)
	if strings.HasPrefix(url, avatarURLPrefix) && filename == "" {
		return ErrAvatarUnavailable
	}
	if filename != "" {
		// This conditional write also serializes attachment against cleanup. Once
		// cleanup claims 'deleting', no stale settings request can reattach it.
		res, err := tx.ExecContext(ctx, `UPDATE avatar_objects SET state='attached',expires_at=0 WHERE filename=? AND user_id=? AND write_until=0
 AND (state='attached' OR (state='pending' AND expires_at>?))
 AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')`, filename, userID, time.Now().Unix(), userID)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrAvatarUnavailable
		}
	}
	if old != "" && old != filename {
		_, err := tx.ExecContext(ctx, `UPDATE avatar_objects SET state='deleting' WHERE filename=? AND user_id=?`, old, userID)
		return err
	}
	return nil
}

// A public URL is valid only while a live account still references this avatar.
// Storage is private; revocation is enforced before reading any object bytes.
func AvatarVisible(ctx context.Context, db *sql.DB, filename string) (bool, error) {
	var raw string
	err := db.QueryRowContext(ctx, `SELECT u.settings FROM avatar_objects a JOIN users u ON u.id=a.user_id WHERE a.filename=? AND a.state='attached' AND u.status<>'deleting'`, filename).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var settings map[string]any
	_ = json.Unmarshal([]byte(raw), &settings)
	return managedAvatarFilename(settings["avatar_url"]) == filename, nil
}

func AvatarCleanupBatch(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT filename FROM avatar_objects WHERE write_until<=? AND (state='deleting' OR (state='pending' AND expires_at<=?)) ORDER BY attempts,created_at,filename LIMIT 100`, time.Now().Unix(), time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var filenames []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		filenames = append(filenames, name)
	}
	return filenames, rows.Err()
}

func ClaimAvatarCleanup(ctx context.Context, db *sql.DB, filename string) (bool, error) {
	res, err := db.ExecContext(ctx, `UPDATE avatar_objects SET state='deleting' WHERE filename=? AND write_until<=? AND (state='deleting' OR (state='pending' AND expires_at<=?))`, filename, time.Now().Unix(), time.Now().Unix())
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func CompleteAvatarCleanup(ctx context.Context, db *sql.DB, filename string, failure error) error {
	if failure != nil {
		_, err := db.ExecContext(ctx, `UPDATE avatar_objects SET attempts=attempts+1,last_error=? WHERE filename=?`, cleanupErrorText(failure), filename)
		return err
	}
	_, err := db.ExecContext(ctx, `DELETE FROM avatar_objects WHERE filename=? AND state='deleting'`, filename)
	return err
}

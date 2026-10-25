package store

import (
	"context"
	"database/sql"
	"errors"
)

// Keep existing rule keys and their dependent matches/users while allowing a
// NULL workspace. SQLite must rebuild the parent with FK actions disabled on
// the same connection, otherwise dropping it would cascade-delete those rows.
func migrateRegistrationDomainOptionalWorkspace(db *sql.DB) (err error) {
	if usePostgres {
		_, err = db.Exec(`ALTER TABLE registration_domains ALTER COLUMN workspace_id DROP NOT NULL`)
		return err
	}
	rows, err := db.Query(`PRAGMA table_info(registration_domains)`)
	if err != nil {
		return err
	}
	rebuild := false
	for rows.Next() {
		var id, notNull, primaryKey int
		var name, kind string
		var defaultValue any
		if err := rows.Scan(&id, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			_ = rows.Close()
			return err
		}
		if name == "workspace_id" {
			rebuild = notNull != 0
		}
	}
	err = errors.Join(rows.Err(), rows.Close())
	if err != nil || !rebuild {
		return err
	}
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var foreignKeys int
	if err := conn.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
		return err
	}
	defer func() {
		if foreignKeys != 0 {
			_, restoreErr := conn.ExecContext(ctx, `PRAGMA foreign_keys=ON`)
			err = errors.Join(err, restoreErr)
		}
	}()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range []string{
		`CREATE TABLE registration_domains_optional (
			subscription_purchase_disabled INTEGER NOT NULL DEFAULT 0 CHECK(subscription_purchase_disabled IN (0,1)),
			domain TEXT PRIMARY KEY,
			workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
			lock_personal INTEGER NOT NULL DEFAULT 0 CHECK(lock_personal IN (0,1)),
			email_verification_required INTEGER NOT NULL DEFAULT 1 CHECK(email_verification_required IN (0,1)),
			initial_group_id TEXT REFERENCES user_groups(id) ON DELETE SET NULL,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
		)`,
		`INSERT INTO registration_domains_optional(domain,workspace_id,lock_personal,email_verification_required,initial_group_id,enabled,subscription_purchase_disabled)
		 SELECT domain,workspace_id,lock_personal,email_verification_required,initial_group_id,enabled,subscription_purchase_disabled FROM registration_domains`,
		`DROP TABLE registration_domains`,
		`ALTER TABLE registration_domains_optional RENAME TO registration_domains`,
		`CREATE INDEX idx_registration_domains_workspace ON registration_domains(workspace_id)`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return tx.Commit()
}

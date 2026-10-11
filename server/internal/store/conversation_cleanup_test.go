package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestConversationCleanupLedgerCommitsWithDeletionAndRollsBackOnFailure(t *testing.T) {
	ctx := context.Background()
	db, err := Open(filepath.Join(t.TempDir(), "cleanup-ledger.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	exec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	exec(t, db, `INSERT INTO conversations(id,user_id,title,provider_state) VALUES('root','u','Root','{"sandbox_id":"active"}'),('child','u','Child','{"sandbox_id":"reaped"}')`)
	exec(t, db, `UPDATE conversations SET inline_source_conv='root' WHERE id='child'`)
	exec(t, db, `INSERT INTO files(id,user_id,conversation_id,filename,storage_path) VALUES('f','u','child','x','storage://x')`)
	exec(t, db, `CREATE TRIGGER reject_delete BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END`)
	if _, err := DeleteConversationWithState(ctx, db, "root", "u"); err == nil {
		t.Fatal("delete must fail")
	}
	for _, table := range []string{"pending_storage_cleanup", "pending_sandbox_cleanup"} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("rolled-back %s count=%d err=%v", table, n, err)
		}
	}
	if _, err := GetConversation(ctx, db, "child", "u"); err != nil {
		t.Fatal("rollback lost child")
	}
	exec(t, db, `DROP TRIGGER reject_delete`)
	state, err := DeleteConversationWithState(ctx, db, "root", "u")
	if err != nil {
		t.Fatal(err)
	}
	if len(state.SandboxDiscards) != 2 || len(state.StoragePaths) != 1 {
		t.Fatalf("cleanup state=%+v", state)
	}
	items, err := ListPendingSandboxCleanup(ctx, db)
	if err != nil || len(items) != 2 {
		t.Fatalf("sandbox ledger=%+v err=%v", items, err)
	}
	paths, err := ListPendingStorageCleanup(ctx, db)
	if err != nil || len(paths) != 1 || paths[0] != "storage://x" {
		t.Fatalf("storage ledger=%v err=%v", paths, err)
	}
}

func TestCleanupLedgerMigrationPreservesLegacyPendingPaths(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "legacy-cleanup.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec(t, db, `CREATE TABLE pending_storage_cleanup(path TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_at INTEGER NOT NULL)`)
	exec(t, db, `INSERT INTO pending_storage_cleanup VALUES('storage://still-pending','gone',1)`)
	for range 2 {
		if err := Migrate(db); err != nil {
			t.Fatal(err)
		}
	}
	var attempts int
	var lastError string
	if err := db.QueryRow(`SELECT attempts,last_error FROM pending_storage_cleanup WHERE path='storage://still-pending'`).Scan(&attempts, &lastError); err != nil || attempts != 0 || lastError != "" {
		t.Fatalf("legacy row lost: %d %q %v", attempts, lastError, err)
	}
}

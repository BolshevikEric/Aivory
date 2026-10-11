package store

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestDisabledModelSkillSnapshotMigrationAndMessagePath(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "disabled-skills.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`ALTER TABLE messages DROP COLUMN disabled_model_skill_ids`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users(id,email,password_hash) VALUES('u1','snapshot@example.test','h')`); err != nil {
		t.Fatal(err)
	}
	conv, err := CreateConversation(t.Context(), db, Conversation{UserID: "u1", Title: "Snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := CreateMessagePath(t.Context(), db, []Message{{ConversationID: conv.ID, Role: "user", Blocks: json.RawMessage(`[{"kind":"text","text":"Question"}]`), DisabledModelSkillIDs: json.RawMessage(`["sk_visual"]`)}, {ConversationID: conv.ID, Role: "assistant", Blocks: json.RawMessage(`[{"kind":"text","text":"Answer"}]`)}})
	if err != nil {
		t.Fatal(err)
	}
	path, err := ListMessages(t.Context(), db, conv.ID, leaf)
	if err != nil || len(path) != 2 {
		t.Fatalf("path=%+v err=%v", path, err)
	}
	if string(path[0].DisabledModelSkillIDs) != `["sk_visual"]` || string(path[1].DisabledModelSkillIDs) != `[]` {
		t.Fatalf("snapshot/defaults not preserved: %+v", path)
	}
}

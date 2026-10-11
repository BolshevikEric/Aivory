package store

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
)

func TestNormalFirstSendsDoNotConsumeOrDiscardUploadDraft(t *testing.T) {
	ctx := context.Background()
	db, err := Open(filepath.Join(t.TempDir(), "first-send.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	exec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	draft, err := ReserveConversationDraft(ctx, db, Conversation{UserID: "u"})
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	results := make(chan *Conversation, 8)
	errors := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conv, err := CreateConversation(ctx, db, Conversation{UserID: "u"})
			if err != nil {
				errors <- err
				return
			}
			results <- conv
		}()
	}
	wg.Wait()
	close(errors)
	close(results)
	for err := range errors {
		t.Errorf("normal first send blocked: %v", err)
	}
	seen := map[string]bool{}
	for conv := range results {
		if conv.ID == draft.ID || seen[conv.ID] {
			t.Fatalf("independent questions merged: %s", conv.ID)
		}
		seen[conv.ID] = true
	}
	if len(seen) != 8 {
		t.Fatalf("created %d of 8 conversations", len(seen))
	}
	rows, err := ListConversations(ctx, db, "u", "", "active", 100, 0)
	if err != nil || len(rows) != 9 {
		t.Fatalf("failed first sends must be manageable; visible=%d err=%v", len(rows), err)
	}
	for _, row := range rows {
		if row.IsDraft != (row.ID == draft.ID) {
			t.Fatalf("incorrect draft marker: %+v", row)
		}
	}
	_, deleted, err := SwitchConversationDraftScope(ctx, db, "u", "", "", "draw")
	if err != nil {
		t.Fatal(err)
	}
	if len(deleted.ConversationIDs) != 1 || deleted.ConversationIDs[0] != draft.ID {
		t.Fatalf("scope switch deleted normal sends: %+v", deleted)
	}
	for id := range seen {
		if _, err := GetConversation(ctx, db, id, "u"); err != nil {
			t.Fatalf("first-send row lost: %v", err)
		}
	}
}

func TestLegacyBlankDraftsAreRecoverableAndDeduplicated(t *testing.T) {
	ctx := context.Background()
	db, err := Open(filepath.Join(t.TempDir(), "legacy-drafts.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	exec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	// Old failed first sends lack both a marker and uploaded files.
	exec(t, db, `INSERT INTO conversations(id,user_id,title,updated_at) VALUES('old','u','',10),('latest','u','',20)`)
	exec(t, db, `UPDATE conversations SET draft_scope='chat' WHERE id='latest'`)
	exec(t, db, `INSERT INTO files(id,user_id,conversation_id,filename,storage_path,draft) VALUES('f','u','old','x.txt','/tmp/x.txt',1)`)
	draft, deleted, err := SwitchConversationDraftScope(ctx, db, "u", "", "", "chat")
	if err != nil || draft == nil || draft.ID != "latest" {
		t.Fatalf("legacy recovery=%+v err=%v", draft, err)
	}
	if len(deleted.ConversationIDs) != 1 || deleted.ConversationIDs[0] != "old" || len(deleted.StoragePaths) != 1 {
		t.Fatalf("legacy duplicate cleanup=%+v", deleted)
	}
	reused, err := ReserveConversationDraft(ctx, db, Conversation{UserID: "u"})
	if err != nil || reused.ID != draft.ID || !reused.DraftReused {
		t.Fatalf("reservation=%+v err=%v", reused, err)
	}
	if _, err := CreateMessageForUser(ctx, db, Message{ConversationID: draft.ID, Role: "user", AuthorID: "u"}, "u"); err != nil {
		t.Fatal(err)
	}
	next, err := ReserveConversationDraft(ctx, db, Conversation{UserID: "u"})
	if err != nil || next.ID == draft.ID {
		t.Fatalf("new upload reservation blocked after send: %+v %v", next, err)
	}
	if sent, err := GetConversation(ctx, db, draft.ID, "u"); err != nil || sent.IsDraft || sent.DraftScope != "" {
		t.Fatalf("sent draft deleted: %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM conversations c WHERE c.user_id='u' AND ` + unusedConversationDraftSQL).Scan(&count); err != nil || count != 1 {
		t.Fatalf("unused drafts=%d err=%v", count, err)
	}
}

func TestLegacyBlankGhostCannotDisplaceRealUploadDraft(t *testing.T) {
	ctx := context.Background()
	db, err := Open(filepath.Join(t.TempDir(), "legacy-ghost.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	exec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	exec(t, db, `INSERT INTO conversations(id,user_id,title,updated_at) VALUES('upload','u','',10),('ghost','u','',20)`)
	exec(t, db, `INSERT INTO files(id,user_id,conversation_id,filename,storage_path,draft) VALUES('f','u','upload','x.txt','/tmp/x.txt',1)`)
	draft, deleted, err := SwitchConversationDraftScope(ctx, db, "u", "", "", "chat")
	if err != nil || draft == nil || draft.ID != "upload" {
		t.Fatalf("ghost displaced actual upload: %+v %v", draft, err)
	}
	if len(deleted.ConversationIDs) != 1 || deleted.ConversationIDs[0] != "ghost" {
		t.Fatalf("ghost not discarded: %+v", deleted)
	}
	if !fileExists(t, db, "f") {
		t.Fatal("upload lost during legacy recovery")
	}
}

func TestConcurrentUploadReservationsRemainOnePerAccount(t *testing.T) {
	ctx := context.Background()
	db, err := Open(filepath.Join(t.TempDir(), "draft-cap.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	exec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := ReserveConversationDraft(ctx, db, Conversation{UserID: "u"})
			if err != nil {
				errs <- err
			} else {
				ids <- c.ID
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	seen := map[string]bool{}
	for id := range ids {
		seen[id] = true
	}
	if len(seen) != 1 {
		t.Fatalf("concurrent reservations=%v", seen)
	}
}

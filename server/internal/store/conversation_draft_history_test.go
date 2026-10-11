package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestConversationDraftHistoryVisibilityAndFirstSend(t *testing.T) {
	ctx := context.Background()
	db, err := Open(filepath.Join(t.TempDir(), "draft-history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	exec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('owner','owner@test','h'),('member','member@test','h')`)
	exec(t, db, `INSERT INTO workspaces(id,name,owner_id,invite_token) VALUES('ws','Shared','owner','invite')`)
	exec(t, db, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES('ws','owner','owner'),('ws','member','member')`)
	// Public visibility must not expose someone else's unsent reservation.
	exec(t, db, `INSERT INTO conversations(id,user_id,workspace_id,title,is_public,draft_scope) VALUES
		('draft-owner','owner','ws','',1,'chat'),
		('draft-member','member','ws','',1,'draw'),
		('saved','owner','ws','Published',1,'sending')`)
	for _, userID := range []string{"owner", "member"} {
		rows, err := ListWorkspaceConversationsForUser(ctx, db, "ws", "", "active", userID, 100, 0)
		if err != nil || len(rows) != 2 {
			t.Fatalf("%s history=%+v err=%v", userID, rows, err)
		}
		for _, row := range rows {
			if row.ID == "saved" {
				if row.IsDraft || row.DraftScope != "" {
					t.Fatalf("saved row marked draft: %+v", row)
				}
			} else if row.UserID != userID || !row.IsDraft || row.DraftScope == "" {
				t.Fatalf("draft visibility/state wrong: %+v", row)
			}
		}
	}
	if _, err := CreateMessageForUser(ctx, db, Message{ConversationID: "draft-owner", Role: "user", AuthorID: "owner"}, "owner"); err != nil {
		t.Fatal(err)
	}
	rows, err := ListWorkspaceConversationsForUser(ctx, db, "ws", "", "active", "member", 100, 0)
	if err != nil || len(rows) != 3 {
		t.Fatalf("committed conversation not in shared history: %+v err=%v", rows, err)
	}
	for _, row := range rows {
		if row.ID == "draft-owner" && (row.IsDraft || row.DraftScope != "") {
			t.Fatalf("first send did not clear derived draft state: %+v", row)
		}
	}

	draft, err := ReserveConversationDraft(ctx, db, Conversation{UserID: "owner"})
	if err != nil || !draft.IsDraft || draft.DraftScope != "chat" {
		t.Fatalf("create response=%+v err=%v", draft, err)
	}
	personal, err := ListConversations(ctx, db, "owner", "", "active", 20, 0)
	if err != nil || len(personal) != 1 || personal[0].ID != draft.ID || !personal[0].IsDraft {
		t.Fatalf("personal draft missing: %+v err=%v", personal, err)
	}
	if _, err := DeleteConversationDraftWithState(ctx, db, draft.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	personal, err = ListConversations(ctx, db, "owner", "", "active", 20, 0)
	if err != nil || len(personal) != 0 {
		t.Fatalf("discarded draft still listed: %+v err=%v", personal, err)
	}
}

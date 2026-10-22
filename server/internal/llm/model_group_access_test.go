package llm

import (
	"context"
	"errors"
	"testing"

	"aivory/server/internal/store"
)

func TestModelGroupAccessRejectsRuntimePrivateAndFallback(t *testing.T) {
	o, provider, model, conv, _, db := setupToolRouteTest(t)
	ctx := context.Background()
	if _, err := db.Exec(`UPDATE users SET role='user' WHERE id='u1'`); err != nil {
		t.Fatal(err)
	}
	user, err := store.FindUserByID(ctx, db, "u1")
	if err != nil {
		t.Fatal(err)
	}
	model.DeniedGroupIDs = []string{user.GroupID}
	model, err = store.UpdateModel(ctx, db, model.ID, *model)
	if err != nil {
		t.Fatal(err)
	}
	_, err = o.Run(ctx, RunRequest{UserID: "u1", ConversationID: conv.ID, ModelID: model.ID, UserText: "hello"}, func(SseEvent) {})
	if !errors.Is(err, store.ErrModelGroupAccess) {
		t.Fatalf("Run: %v", err)
	}
	_, _, _, err = o.buildFallbackRequest(ctx, UnifiedChatRequest{UserID: "u1"}, model.ID)
	if !errors.Is(err, store.ErrModelGroupAccess) {
		t.Fatalf("fallback: %v", err)
	}
	err = o.RunPrivate(ctx, "u1", model, []UnifiedMessage{{Role: "user", Blocks: []UnifiedBlock{{Kind: "text", Text: "hello"}}}}, func(SseEvent) {})
	if !errors.Is(err, store.ErrModelGroupAccess) {
		t.Fatalf("private: %v", err)
	}
	_, err = o.task.Run(ctx, TaskVerify, "audit", RunOpts{UserID: "u1", ModelID: model.ID})
	if !errors.Is(err, store.ErrModelGroupAccess) {
		t.Fatalf("auxiliary task: %v", err)
	}
	_, _, err = o.privateCall(ctx, "u1", model, nil, "", "moderation", 0, func(SseEvent) {})
	if !errors.Is(err, store.ErrModelGroupAccess) {
		t.Fatalf("private auxiliary call: %v", err)
	}
	if len(provider.mainRequests) != 0 {
		t.Fatal("denied model reached provider")
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM messages WHERE conversation_id=?`, conv.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("denied runtime persisted messages=%d err=%v", count, err)
	}
}

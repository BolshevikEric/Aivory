package tools

import (
	"context"
	"errors"
	"testing"

	"aivory/server/internal/llm"
	"aivory/server/internal/store"
)

func TestImageToolModelGroupAccessExplicitAndAutomatic(t *testing.T) {
	db := openToolsTestDB(t)
	ctx := context.Background()
	for _, query := range []string{
		`INSERT INTO users(id,email,password_hash,role,group_id) VALUES('image-member','image-member@example.test','h','user','ug_free')`,
		`INSERT INTO channels(id,name,type,enabled,base_url,api_key) VALUES('image-access-channel','Images','openai',1,'https://images.example.test','key')`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	denied, err := store.CreateModel(ctx, db, store.Model{ChannelID: "image-access-channel", Kind: "image", RequestID: "restricted-image", Label: "Restricted", Enabled: true, SortOrder: 0, DeniedGroupIDs: []string{store.DefaultGroupID}})
	if err != nil {
		t.Fatal(err)
	}
	allowed, err := store.CreateModel(ctx, db, store.Model{ChannelID: "image-access-channel", Kind: "image", RequestID: "allowed-image", Label: "Allowed", Enabled: true, SortOrder: 1})
	if err != nil {
		t.Fatal(err)
	}
	tool := &imageGenerateTool{db: db}
	if _, err := tool.resolveImageModel(ctx, &llm.ToolContext{UserID: "image-member", ImageModelID: denied.ID}); !errors.Is(err, store.ErrModelGroupAccess) {
		t.Fatalf("explicit denied image: %v", err)
	}
	selected, err := tool.resolveImageModel(ctx, &llm.ToolContext{UserID: "image-member"})
	if err != nil || selected.ID != allowed.ID {
		t.Fatalf("automatic image=%v err=%v", selected, err)
	}
	if _, err := db.Exec(`UPDATE models SET denied_group_ids='["ug_free"]' WHERE id=?`, allowed.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tool.resolveImageModel(ctx, &llm.ToolContext{UserID: "image-member"}); err == nil {
		t.Fatal("all-denied image models were callable")
	}
}

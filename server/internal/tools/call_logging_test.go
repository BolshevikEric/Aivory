package tools

import (
	"context"
	"io"
	"log"
	"path/filepath"
	"strings"
	"testing"

	"aivory/server/internal/config"
	"aivory/server/internal/llm"
	"aivory/server/internal/store"
)

func TestLogToolFailurePersistsTrackedNoProgress(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "tool-logs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := store.Migrate(db); err != nil {
		t.Fatal(err)
	}
	user, err := store.CreateUser(ctx, db, "tool-log@example.test", "Tool Log", "hash")
	if err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(db, config.Config{}, log.New(io.Discard, "", 0))
	registry.LogToolFailure(ctx, "aivory_web_search", []byte(`{"query":"today news"}`), &llm.ToolContext{
		UserID: user.ID, ConvID: "conv_1", MessageID: "msg_1", ModelID: "model_1",
	}, &llm.ErrToolNoProgress{Kind: "no_new_evidence", Tool: "aivory_web_search"})
	if err := registry.CloseToolLogs(ctx); err != nil {
		t.Fatal(err)
	}
	logs, total, err := store.ListToolCallLogs(ctx, db, store.ToolCallLogFilter{Status: "error"}, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(logs) != 1 {
		t.Fatalf("tool logs = %d/%d, want one error log", len(logs), total)
	}
	detail, err := store.GetToolCallLog(ctx, db, logs[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail.Error, "no_new_evidence") {
		t.Fatalf("error = %q, want no-progress reason", detail.Error)
	}
	if !strings.Contains(detail.Input, "today news") {
		t.Fatalf("input = %q, want search query", detail.Input)
	}
	if !strings.Contains(detail.Output, "duplicates an earlier") {
		t.Fatalf("output = %q, want user-visible skip reason", detail.Output)
	}
}

package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"aivory/server/internal/llm"
	"aivory/server/internal/store"
	"aivory/server/internal/tools"
)

type editAttachmentsProvider struct {
	requests []llm.UnifiedChatRequest
}

func (p *editAttachmentsProvider) ID() string { return "openai" }

func (p *editAttachmentsProvider) Stream(_ context.Context, req llm.UnifiedChatRequest, _ llm.ToolRunner, emit func(llm.SseEvent)) (*llm.UnifiedResult, error) {
	p.requests = append(p.requests, req)
	emit(llm.SseEvent{Type: "text_delta", Text: "edited answer"})
	return &llm.UnifiedResult{
		Blocks: []llm.UnifiedBlock{{Kind: "text", Text: "edited answer"}}, StopReason: "stop",
	}, nil
}

func TestPostMessageEditResendPreservesExistingImage(t *testing.T) {
	for _, parentID := range []string{"", "previous-answer"} {
		t.Run("parent="+parentID, func(t *testing.T) {
			fx := seedImageCapabilityFixture(t)
			ctx, db := t.Context(), fx.deps.DB
			if parentID != "" {
				if _, err := store.CreateMessage(ctx, db, store.Message{
					ID: parentID, ConversationID: "c1", Role: "assistant",
				}); err != nil {
					t.Fatal(err)
				}
			}
			imagePath := filepath.Join(t.TempDir(), "question.png")
			writeFile(t, imagePath, []byte("\x89PNG\r\n\x1a\n"))
			if _, err := store.CreateFile(ctx, db, store.File{
				ID: "original-image", UserID: "u1", ConversationID: "c1", Filename: "question.png",
				MimeType: "image/png", Kind: "image", StoragePath: imagePath, BranchMessageID: "original-question",
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := store.CreateMessage(ctx, db, store.Message{
				ID: "original-question", ConversationID: "c1", ParentID: parentID, Role: "user",
				Blocks:      json.RawMessage(`[{"kind":"text","text":"original question"}]`),
				Attachments: json.RawMessage(`[{"id":"original-image","kind":"image"}]`),
			}); err != nil {
				t.Fatal(err)
			}
			// Another active branch must not change which original message is edited.
			if _, err := store.CreateMessage(ctx, db, store.Message{
				ID: "other-question", ConversationID: "c1", ParentID: parentID, Role: "user",
			}); err != nil {
				t.Fatal(err)
			}
			provider := &editAttachmentsProvider{}
			logger := log.New(io.Discard, "", 0)
			registry := llm.NewRegistry(logger)
			registry.Register(provider)
			fx.deps.Logger = logger
			toolRegistry := tools.NewRegistry(db, fx.deps.Config, logger)
			fx.deps.Orchestrator = llm.NewOrchestrator(db, registry, toolRegistry, nil, fx.deps.Cache, nil, nil, nil, logger)
			body, err := json.Marshal(map[string]any{
				"text": "edited question", "model_id": "m_vision", "parent_id": parentID,
				"branch": true, "edited_message_id": "original-question", "tool_mode": "disabled",
				"attachments": []map[string]string{{"id": "original-image", "kind": "other", "filename": "forged.txt"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			rec := postEditAttachments(t, fx, body)
			if rec.Code != http.StatusOK {
				t.Fatalf("edit resend status=%d body=%s", rec.Code, rec.Body.String())
			}
			frames := branchHTTPReadSSE(t, rec.Result(), nil)
			branchHTTPAssertTerminal(t, "image edit resend", frames, "stop")
			if len(provider.requests) != 1 {
				t.Fatalf("provider requests=%d, want 1", len(provider.requests))
			}
			history := provider.requests[0].History
			last := history[len(history)-1]
			if len(last.Attachments) != 1 || last.Attachments[0].ID != "original-image" || last.Attachments[0].Kind != "image" || last.Attachments[0].Filename != "question.png" {
				t.Fatalf("provider lost canonical image attachment: %+v", last)
			}
			messages, err := store.ListAllMessages(ctx, db, "c1")
			if err != nil {
				t.Fatal(err)
			}
			var edited *store.Message
			for i := range messages {
				if branchHTTPMessageText(t, messages[i]) == "edited question" {
					edited = &messages[i]
				}
			}
			if edited == nil || edited.ParentID != parentID {
				t.Fatalf("edited message is not a sibling: %+v", edited)
			}
			var attachments []llm.Attachment
			if err := json.Unmarshal(edited.Attachments, &attachments); err != nil {
				t.Fatal(err)
			}
			if len(attachments) != 1 || attachments[0].ID != "original-image" {
				t.Fatalf("persisted edit lost image: %+v", attachments)
			}
			visible, err := store.ListFilesByConversationBranch(ctx, db, "c1", "u1", edited.ID)
			if err != nil || len(visible) != 1 || visible[0].ID != "original-image" {
				t.Fatalf("edited branch image files=%+v err=%v", visible, err)
			}
		})
	}
}

func TestPostMessageEditResendRejectsUnrelatedAttachmentsAndSources(t *testing.T) {
	fx := seedImageCapabilityFixture(t)
	ctx, db := t.Context(), fx.deps.DB
	if _, err := store.CreateConversation(ctx, db, store.Conversation{ID: "c2", UserID: "u1", Title: "Other"}); err != nil {
		t.Fatal(err)
	}
	for _, message := range []store.Message{
		{ID: "question", ConversationID: "c1", Role: "user"},
		{ID: "answer", ConversationID: "c1", ParentID: "question", Role: "assistant"},
		{ID: "later-question", ConversationID: "c1", ParentID: "answer", Role: "user", Attachments: json.RawMessage(`[{"id":"later-image"}]`)},
		{ID: "sibling", ConversationID: "c1", Role: "user", Attachments: json.RawMessage(`[{"id":"sibling-image"}]`)},
		{ID: "foreign", ConversationID: "c2", Role: "user", Attachments: json.RawMessage(`[{"id":"foreign-image"}]`)},
	} {
		if _, err := store.CreateMessage(ctx, db, message); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"later-image", "sibling-image", "foreign-image"} {
		conversationID := "c1"
		if id == "foreign-image" {
			conversationID = "c2"
		}
		if _, err := store.CreateFile(ctx, db, store.File{
			ID: id, UserID: "u1", ConversationID: conversationID, Filename: "image.png", Kind: "image", StoragePath: "/missing/image.png",
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name, sourceID, parentID, fileID string
		branch                           bool
		status                           int
	}{
		{name: "missing source", sourceID: "missing", branch: true, status: http.StatusConflict},
		{name: "foreign source", sourceID: "foreign", branch: true, status: http.StatusConflict},
		{name: "assistant source", sourceID: "answer", parentID: "question", branch: true, status: http.StatusConflict},
		{name: "different parent", sourceID: "later-question", branch: true, status: http.StatusConflict},
		{name: "source on append", sourceID: "question", status: http.StatusConflict},
		{name: "sibling image", sourceID: "question", fileID: "sibling-image", branch: true, status: http.StatusBadRequest},
		{name: "descendant image", sourceID: "question", fileID: "later-image", branch: true, status: http.StatusBadRequest},
		{name: "foreign image", sourceID: "question", fileID: "foreign-image", branch: true, status: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"text": "edited question", "parent_id": tc.parentID, "branch": tc.branch, "edited_message_id": tc.sourceID,
				"attachments": []map[string]string{{"id": tc.fileID}},
			})
			if err != nil {
				t.Fatal(err)
			}
			rec := postEditAttachments(t, fx, body)
			if rec.Code != tc.status {
				t.Fatalf("status=%d body=%s, want %d", rec.Code, rec.Body.String(), tc.status)
			}
			messages, err := store.ListAllMessages(ctx, db, "c1")
			if err != nil || len(messages) != 4 {
				t.Fatalf("rejected edit changed messages: count=%d err=%v", len(messages), err)
			}
		})
	}
}

func postEditAttachments(t *testing.T, fx imageCapabilityFixture, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/conversations/c1/messages", bytes.NewReader(body))
	ctx := context.WithValue(req.Context(), userCtxKey{}, fx.user)
	ctx = context.WithValue(ctx, pathCtxKey{}, map[string]string{"id": "c1"})
	rec := httptest.NewRecorder()
	postMessageHandler(fx.deps, rec, req.WithContext(ctx))
	return rec
}

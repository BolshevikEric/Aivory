package llm

import (
	"context"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"aivory/server/internal/store"
)

func TestComputeCostCacheTokenSemantics(t *testing.T) {
	usage := Usage{InputTokens: 100, OutputTokens: 7, CacheReadTokens: 40, CacheWriteTokens: 20}
	for _, protocol := range []string{"openai.chat", "openai.responses", "gemini.generateContent", "anthropic.messages"} {
		t.Run(protocol, func(t *testing.T) {
			model := store.Model{Protocol: protocol, PriceInput: 10, PriceOutput: 5, PriceCacheRead: 1, PriceCacheWrite: 2}
			// OpenAI and Gemini include 40 read + 20 write tokens in the 100
			// input tokens; Anthropic reports 100 ordinary input tokens separately.
			want := float64(40*10+7*5+40*1+20*2) / 1_000_000
			if protocol == "anthropic.messages" {
				want = float64(100*10+7*5+40*1+20*2) / 1_000_000
			}
			if got := computeCost(model, usage); math.Abs(got-want) > 1e-12 {
				t.Fatalf("cost = %.9f, want %.9f", got, want)
			}
		})
	}
	t.Run("missing input does not create negative charges", func(t *testing.T) {
		model := store.Model{Protocol: "openai.chat", PriceInput: 10, PriceCacheRead: 1}
		if got := computeCost(model, Usage{CacheReadTokens: 40}); math.Abs(got-0.00004) > 1e-12 {
			t.Fatalf("cost = %.9f, want 0.00004", got)
		}
	})
}

func TestOrchestratorPersistsProviderCacheUsageForAdminLogs(t *testing.T) {
	tests := []struct {
		protocol, channelType, apiFormat, stream string
		cacheWrite                               int
		cost                                     float64
	}{
		{
			protocol: "openai.chat", channelType: "openai", apiFormat: "chat", cacheWrite: 20, cost: 0.000515,
			stream: cacheUsageSSE(
				`{"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}`,
				`{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}`,
				"[DONE]",
			),
		},
		{
			protocol: "openai.responses", channelType: "openai", apiFormat: "responses", cacheWrite: 20, cost: 0.000515,
			stream: cacheUsageSSE(`{"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"answer"}]}],"usage":{"input_tokens":100,"output_tokens":7,"input_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}}`),
		},
		{
			protocol: "anthropic.messages", channelType: "anthropic", cacheWrite: 20, cost: 0.001115,
			stream: cacheUsageSSE(
				`{"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":20}}}`,
				`{"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}`,
				`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
				`{"type":"message_stop"}`,
			),
		},
		{
			protocol: "gemini.generateContent", channelType: "google", cost: 0.000675,
			stream: cacheUsageSSE(`{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":7,"cachedContentTokenCount":40}}`),
		},
	}
	for _, tt := range tests {
		t.Run(tt.protocol, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("content-type", "text/event-stream")
				_, _ = io.WriteString(w, tt.stream)
			}))
			t.Cleanup(server.Close)
			store.InvalidateConfig()
			t.Cleanup(store.InvalidateConfig)
			ctx := context.Background()
			db, err := store.Open(filepath.Join(t.TempDir(), "cache-usage.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db.Close() })
			if err := store.Migrate(db); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO user_groups(id,name,is_default) VALUES('ug_free','Free',1)`); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO users(id,email,password_hash,role) VALUES('u1','cache@example.test','hash','user')`); err != nil {
				t.Fatal(err)
			}
			channel, err := store.CreateChannel(ctx, db, "Cache test", tt.channelType, tt.apiFormat, server.URL, "test-key")
			if err != nil {
				t.Fatal(err)
			}
			model, err := store.CreateModel(ctx, db, store.Model{
				ChannelID: channel.ID, Kind: "chat", Protocol: tt.protocol, RequestID: "cache-test", Label: "Cache test",
				Enabled: true, Stream: true, ToolMode: "none", Currency: "USD",
				PriceInput: 10, PriceOutput: 5, PriceCacheRead: 1, PriceCacheWrite: 2,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := store.SetModelQuotas(ctx, db, model.ID, []store.ModelGroupQuota{{GroupID: store.DefaultGroupID, LimitType: "count", LimitValue: 0}}); err != nil {
				t.Fatal(err)
			}
			conversation, err := store.CreateConversation(ctx, db, store.Conversation{ID: "c1", UserID: "u1", Title: "Cache usage", ModelID: model.ID})
			if err != nil {
				t.Fatal(err)
			}
			logger := log.New(io.Discard, "", 0)
			orchestrator := NewOrchestrator(db, NewRegistry(logger), channelFallbackUsageTools{}, nil, nil, nil, nil, nil, logger)
			result, err := orchestrator.Run(ctx, RunRequest{
				UserID: "u1", ConversationID: conversation.ID, ModelID: model.ID, UserText: "hello", ToolMode: ToolModeDisabled,
			}, func(SseEvent) {})
			if err != nil || result == nil || result.AssistantMessage == nil {
				t.Fatalf("result = %+v, error = %v", result, err)
			}
			rows, err := store.AdminUsageRecords(ctx, db, store.UsageFilter{ModelID: model.ID, Purpose: "chat"}, 50, 0)
			if err != nil || len(rows) != 1 {
				t.Fatalf("admin usage records = %+v, error = %v; want one chat request", rows, err)
			}
			row := rows[0]
			if row.InputTokens != 100 || row.OutputTokens != 7 || row.CacheReadTokens != 40 || row.CacheWriteTokens != tt.cacheWrite {
				t.Fatalf("admin usage record = %+v, want tokens 100/7/40/%d", row, tt.cacheWrite)
			}
			if math.Abs(row.Cost-tt.cost) > 1e-12 {
				t.Fatalf("admin cost = %.9f, want %.9f", row.Cost, tt.cost)
			}
		})
	}
}

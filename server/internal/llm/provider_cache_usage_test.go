package llm

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func cacheUsageSSE(events ...string) string {
	return "data: " + strings.Join(events, "\n\ndata: ") + "\n\n"
}

func TestReadOpenAIChatStreamCacheUsage(t *testing.T) {
	tests := []struct {
		name   string
		frames []string
		want   Usage
	}{
		{
			name:   "official details after finish",
			frames: []string{`{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}`},
			want:   Usage{InputTokens: 100, OutputTokens: 7, CacheReadTokens: 40, CacheWriteTokens: 20},
		},
		{
			name: "cumulative snapshots preserve omitted details",
			frames: []string{
				`{"usage":{"prompt_tokens":100,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}`,
				`{"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}`,
				`{"usage":{"prompt_tokens":100,"completion_tokens":7}}`,
			},
			want: Usage{InputTokens: 100, OutputTokens: 7, CacheReadTokens: 40, CacheWriteTokens: 20},
		},
		{
			name: "explicit zero overrides earlier snapshots and aliases",
			frames: []string{
				`{"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_cache_hit_tokens":40,"cache_creation_input_tokens":20}}`,
				`{"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0},"prompt_cache_hit_tokens":40,"cache_creation_input_tokens":20}}`,
			},
			want: Usage{InputTokens: 100, OutputTokens: 7},
		},
		{
			name:   "deepseek cache misses are not writes",
			frames: []string{`{"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_cache_hit_tokens":40,"prompt_cache_miss_tokens":60}}`},
			want:   Usage{InputTokens: 100, OutputTokens: 7, CacheReadTokens: 40},
		},
		{
			name:   "relay anthropic counters",
			frames: []string{`{"usage":{"prompt_tokens":100,"completion_tokens":7,"cache_read_input_tokens":40,"cache_creation_input_tokens":20}}`},
			want:   Usage{InputTokens: 100, OutputTokens: 7, CacheReadTokens: 40, CacheWriteTokens: 20},
		},
		{
			name:   "relay canonical counters",
			frames: []string{`{"usage":{"prompt_tokens":100,"completion_tokens":7,"cache_read_tokens":40,"cache_write_tokens":20}}`},
			want:   Usage{InputTokens: 100, OutputTokens: 7, CacheReadTokens: 40, CacheWriteTokens: 20},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			frames := append([]string{`{"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}`}, tt.frames...)
			stream := cacheUsageSSE(append(frames, "[DONE]")...)
			_, _, _, _, usage, err := readOpenAIChatStream(strings.NewReader(stream), func(SseEvent) {})
			if err != nil || usage != tt.want {
				t.Fatalf("usage = %+v, error = %v; want %+v", usage, err, tt.want)
			}
		})
	}
}

func TestOpenAIResponsesCacheUsage(t *testing.T) {
	want := Usage{InputTokens: 100, OutputTokens: 7, CacheReadTokens: 40, CacheWriteTokens: 20}
	response := `{"output":[{"type":"message","content":[{"type":"output_text","text":"answer"}]}],"usage":{"input_tokens":100,"output_tokens":7,"input_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}`
	for _, event := range []string{"response.completed", "response.incomplete"} {
		t.Run(event, func(t *testing.T) {
			stream := cacheUsageSSE(`{"type":"` + event + `","response":` + response + `}`)
			_, _, _, _, _, usage, _, err := readOpenAIResponsesStream(strings.NewReader(stream), func(SseEvent) {})
			if err != nil || usage != want {
				t.Fatalf("usage = %+v, error = %v; want %+v", usage, err, want)
			}
		})
	}
	t.Run("non-streaming", func(t *testing.T) {
		text, _, usage := parseResponsesOutput([]byte(response))
		if text != "answer" || usage != want {
			t.Fatalf("text/usage = %q/%+v, want answer/%+v", text, usage, want)
		}
	})
}

func TestReadGeminiStreamCacheUsage(t *testing.T) {
	stream := cacheUsageSSE(
		`{"candidates":[{"content":{"parts":[{"text":"answer"}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":2,"cachedContentTokenCount":40}}`,
		`{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":4,"cachedContentTokenCount":40}}`,
		`{"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":5,"thoughtsTokenCount":2}}`,
	)
	_, _, _, _, _, usage, err := readGeminiStream(strings.NewReader(stream), func(SseEvent) {})
	want := Usage{InputTokens: 100, OutputTokens: 7, CacheReadTokens: 40}
	if err != nil || usage != want {
		t.Fatalf("usage = %+v, error = %v; want %+v", usage, err, want)
	}
}

func TestGooglePromptRoundCacheUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"answer"}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":5,"thoughtsTokenCount":2,"cachedContentTokenCount":40}}`)
	}))
	t.Cleanup(server.Close)
	round, err := (&GoogleProvider{}).promptRunOnce(UnifiedChatRequest{
		Model: ModelInfo{RequestID: "gemini-test", BaseURL: server.URL, APIKey: "test-key"},
	})(context.Background(), []UnifiedMessage{{Role: "user", Blocks: []UnifiedBlock{{Kind: "text", Text: "hello"}}}}, "")
	want := Usage{InputTokens: 100, OutputTokens: 7, CacheReadTokens: 40}
	if err != nil || round.Text != "answer" || round.Usage != want {
		t.Fatalf("round = %+v, error = %v; want answer and %+v", round, err, want)
	}
}

func TestProviderToolRoundsAccumulateCacheUsage(t *testing.T) {
	tests := []struct {
		name, apiFormat string
		provider        Provider
		first, last     string
		partial         string
		want            Usage
	}{
		{
			name: "chat", provider: &OpenAIProvider{},
			first:   cacheUsageSSE(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}`, "[DONE]"),
			last:    cacheUsageSSE(`{"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}`, "[DONE]"),
			partial: cacheUsageSSE(`{"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}`),
			want:    Usage{InputTokens: 200, OutputTokens: 14, CacheReadTokens: 80, CacheWriteTokens: 40},
		},
		{
			name: "responses", apiFormat: "responses", provider: &OpenAIProvider{},
			first: cacheUsageSSE(`{"type":"response.completed","response":{"output":[{"type":"function_call","id":"item_1","call_id":"call_1","name":"lookup","arguments":"{}"}],"usage":{"input_tokens":100,"output_tokens":7,"input_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}}`),
			last:  cacheUsageSSE(`{"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"answer"}]}],"usage":{"input_tokens":100,"output_tokens":7,"input_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}}}`),
			want:  Usage{InputTokens: 200, OutputTokens: 14, CacheReadTokens: 80, CacheWriteTokens: 40},
		},
		{
			name: "gemini", provider: &GoogleProvider{},
			first:   cacheUsageSSE(`{"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":7,"cachedContentTokenCount":40}}`),
			last:    cacheUsageSSE(`{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":7,"cachedContentTokenCount":40}}`),
			partial: cacheUsageSSE(`{"candidates":[{"content":{"parts":[{"text":"partial"}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":7,"cachedContentTokenCount":40}}`),
			want:    Usage{InputTokens: 200, OutputTokens: 14, CacheReadTokens: 80},
		},
	}
	for _, tt := range tests {
		for _, interrupt := range []bool{false, true} {
			name := tt.name
			if interrupt {
				name += "/interrupted second round"
			}
			t.Run(name, func(t *testing.T) {
				var hits atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("content-type", "text/event-stream")
					stream := tt.last
					if hits.Add(1) == 1 {
						stream = tt.first
					} else if interrupt {
						// The completed first round remains billable when a later request fails.
						stream = tt.partial + cacheUsageSSE(`{"error":{"message":"second round failed"}}`)
					}
					_, _ = io.WriteString(w, stream)
				}))
				t.Cleanup(server.Close)
				tools := &countingFallbackToolRunner{}
				result, err := tt.provider.Stream(context.Background(), UnifiedChatRequest{
					Model:   ModelInfo{RequestID: "cache-test", BaseURL: server.URL, APIKey: "test-key", APIFormat: tt.apiFormat},
					History: []UnifiedMessage{{Role: "user", Blocks: []UnifiedBlock{{Kind: "text", Text: "hello"}}}},
					Tools:   []ToolDef{{Name: "lookup", Description: "Look up a value", InputSchema: []byte(`{"type":"object","properties":{}}`)}},
				}, tools, func(SseEvent) {})
				want := tt.want
				if interrupt && tt.partial == "" {
					want = Usage{InputTokens: want.InputTokens / 2, OutputTokens: want.OutputTokens / 2, CacheReadTokens: want.CacheReadTokens / 2, CacheWriteTokens: want.CacheWriteTokens / 2}
				}
				if (err != nil) != interrupt || result == nil || result.Usage != want || hits.Load() != 2 || tools.calls.Load() != 1 {
					t.Fatalf("result = %+v, error = %v, requests/tools = %d/%d; want usage %+v and 2/1 requests/tools", result, err, hits.Load(), tools.calls.Load(), want)
				}
			})
		}
	}
}

package typesafe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const noulResponse = `{"model":"jev-1.13.0","answers":{"yes":{"type":"noul","noul":0}},"usage":{"input_tokens":100,"output_tokens":10}}`

func request() Request {
	return Request{State: "private user text", Questions: map[string]Question{"yes": NewNoul("Is this relevant?", nil)}}
}

func testClient(t *testing.T, handler http.HandlerFunc, adjust func(*Config)) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	cfg := Config{APIKey: "secret-key", BaseURL: srv.URL, Timeout: time.Second, RetryBaseDelay: time.Millisecond}
	if adjust != nil {
		adjust(&cfg)
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestMixedQuestionsStructuredJSONAndVersion(t *testing.T) {
	var logs bytes.Buffer
	var record Record
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/systemone" || r.Header.Get("Authorization") != "Bearer secret-key" {
			t.Errorf("unexpected request method/path/auth")
		}
		body, _ := io.ReadAll(r.Body)
		if bytes.Contains(body, []byte("local-user")) || bytes.Contains(body, []byte("task.test")) {
			t.Error("local metadata leaked upstream")
		}
		var req Request
		if err := json.Unmarshal(body, &req); err != nil || req.Model != "jev-latest" || len(req.Questions) != 3 {
			t.Errorf("unexpected request: %s", body)
		}
		w.Header().Set("X-Request-ID", "req-123")
		fmt.Fprint(w, `{"model":"jev-1.13.0","answers":{
		 "route":{"type":"choice","choice":"none","confidence":0.8,"probabilities":{"none":0.9,"web":0.1}},
		 "quality":{"type":"score","score":0.2,"confidence":0.5,"probabilities":{"0":0.8,"1":0.2},"legend":{"0":{"description":"low"},"1":"high"}},
		 "yes":{"type":"noul","noul":0}
		},"usage":{"input_tokens":123,"output_tokens":45}}`)
	}, func(cfg *Config) {
		cfg.Model = "jev-latest"
		cfg.Logger = log.New(&logs, "", 0)
		cfg.Recorder = func(_ context.Context, r Record) error { record = r; return nil }
	})
	req := request()
	req.State = map[string]any{"message": "private user text", "count": 1}
	req.Questions["route"] = NewChoice(map[string]any{"question": "Which route?"}, map[string]any{"none": nil, "web": []string{"search"}})
	req.Questions["quality"] = NewScore("Quality?", []any{map[string]any{"description": "low"}, "high"})
	result, err := c.Evaluate(context.Background(), req, Options{Metadata: Metadata{UserID: "local-user", Purpose: "task.test"}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Model != DefaultModel || result.RequestedModel != "jev-latest" || result.RequestID != "req-123" || *result.Answers["yes"].Noul != 0 || result.Answers["yes"].Confidence != nil {
		t.Fatalf("incorrect result: %+v", result)
	}
	if record.Attempts != 1 || !record.UsageKnown || record.Usage.InputTokens != 123 || record.ServedModel != DefaultModel {
		t.Fatalf("incorrect record: %+v", record)
	}
	for _, secret := range []string{"private user text", "secret-key", "Which route?", "Quality?"} {
		if strings.Contains(logs.String(), secret) {
			t.Errorf("sensitive text in logs: %s", secret)
		}
	}
}

func TestCustomHeadersOverrideDefaults(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("A") != "a" || r.Header.Get("Authorization") != "Bearer override" {
			t.Errorf("headers=%v", r.Header)
		}
		fmt.Fprint(w, noulResponse)
	}, func(cfg *Config) { cfg.Headers = map[string]string{"A": "a", "Authorization": "Bearer override"} })
	if _, err := c.Evaluate(context.Background(), request(), Options{}); err != nil {
		t.Fatal(err)
	}
}

func TestDiagnosticsAreOptInAndExcludedFromLogger(t *testing.T) {
	for _, capture := range []bool{false, true} {
		t.Run(fmt.Sprint(capture), func(t *testing.T) {
			var record Record
			var logs bytes.Buffer
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusUnprocessableEntity)
				fmt.Fprint(w, `{"detail":"private response"}`)
			}, func(cfg *Config) {
				cfg.CaptureDiagnostics = capture
				cfg.Logger = log.New(&logs, "", 0)
				cfg.Recorder = func(_ context.Context, r Record) error { record = r; return nil }
			})
			_, err := c.Evaluate(context.Background(), request(), Options{})
			if KindOf(err) != ErrValidation || (record.Request != nil) != capture || (record.ResponseBody != "") != capture {
				t.Fatalf("wrong diagnostic capture: error=%v record=%+v", err, record)
			}
			if capture {
				body, readErr := record.Request.GetBody()
				if readErr != nil {
					t.Fatal(readErr)
				}
				raw, _ := io.ReadAll(body)
				body.Close()
				if !strings.Contains(string(raw), "private user text") || !strings.Contains(record.ResponseBody, "private response") {
					t.Fatal("exact request/response not retained for recorder")
				}
			}
			if strings.Contains(logs.String()+err.Error(), "private response") || strings.Contains(logs.String(), "private user text") || strings.Contains(logs.String(), "secret-key") {
				t.Fatal("transport diagnostics leaked to logger or returned error")
			}
		})
	}
}

func TestInvalidRequestsNeverReachServer(t *testing.T) {
	var calls atomic.Int32
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }, nil)
	tests := []Request{
		{State: nil, Questions: request().Questions},
		{State: 123, Questions: request().Questions},
		{State: "test"},
		{State: make(chan int), Questions: request().Questions},
		{State: "test", Questions: map[string]Question{"x": {Type: "invalid"}}},
		{State: "test", Questions: map[string]Question{"x": NewChoice("q", nil)}},
		{State: "test", Questions: map[string]Question{"x": NewScore("q", []any{"only one"})}},
		{State: "test", Questions: map[string]Question{"x": NewNoul("q", map[string]any{"wrong": "yes"})}},
	}
	for i, req := range tests {
		if _, err := c.Evaluate(context.Background(), req, Options{}); KindOf(err) != ErrValidation {
			t.Errorf("case %d: expected validation error, got %v", i, err)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid requests sent upstream")
	}
}

func TestResponseValidationRetainsUsage(t *testing.T) {
	tests := []struct {
		name, body string
		kind       ErrorKind
		usage      bool
	}{
		{"missing answer", strings.Replace(noulResponse, `"yes":`, `"wrong":`, 1), ErrResponse, true},
		{"missing value", strings.Replace(noulResponse, `,"noul":0`, ``, 1), ErrResponse, true},
		{"range", strings.Replace(noulResponse, `"noul":0`, `"noul":1.5`, 1), ErrResponse, true},
		{"wrong type", strings.Replace(noulResponse, `"type":"noul"`, `"type":"choice"`, 1), ErrResponse, true},
		{"wrong value type", strings.Replace(noulResponse, `"noul":0`, `"noul":"yes"`, 1), ErrResponse, true},
		{"missing answer and usage", `{"model":"jev-1.13.0","answers":{}}`, ErrResponse, true},
		{"null token count", strings.Replace(noulResponse, `"input_tokens":100`, `"input_tokens":null`, 1), ErrResponse, false},
		{"negative usage", strings.Replace(noulResponse, `"input_tokens":100`, `"input_tokens":-1`, 1), ErrResponse, false},
		{"null output", strings.Replace(noulResponse, `"output_tokens":10`, `"output_tokens":null`, 1), ErrResponse, false},
		{"negative output", strings.Replace(noulResponse, `"output_tokens":10`, `"output_tokens":-1`, 1), ErrResponse, false},
		{"string count", strings.Replace(noulResponse, `"input_tokens":100`, `"input_tokens":"100"`, 1), ErrResponse, false},
		{"fractional count", strings.Replace(noulResponse, `"input_tokens":100`, `"input_tokens":1.5`, 1), ErrResponse, false},
		{"malformed JSON", `{`, ErrResponse, false},
		{"trailing JSON", noulResponse + `{}`, ErrResponse, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var record Record
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, tc.body) }, func(cfg *Config) {
				cfg.Recorder = func(_ context.Context, r Record) error { record = r; return nil }
			})
			out, err := c.Evaluate(context.Background(), request(), Options{})
			if KindOf(err) != tc.kind || record.UsageKnown != tc.usage || record.Attempts != 1 {
				t.Fatalf("err=%v record=%+v", err, record)
			}
			if out != nil && len(out.Answers) != 0 {
				t.Fatal("invalid answers remain available")
			}
		})
	}
}

func TestCompatibleResponseOptionalUsage(t *testing.T) {
	for _, protocol := range []string{"typesafe.decisions", OpenRouterDecisionsProtocol} {
		for _, tc := range []struct {
			name, usage   string
			input, output int
		}{
			{"complete", `,"usage":{"input_tokens":100,"output_tokens":10}`, 100, 10},
			{"input only", `,"usage":{"input_tokens":100}`, 100, 0},
			{"output only", `,"usage":{"output_tokens":10}`, 0, 10},
			{"zero input", `,"usage":{"input_tokens":0}`, 0, 0},
			{"empty usage", `,"usage":{}`, 0, 0},
			{"null usage", `,"usage":null`, 0, 0},
			{"no usage", ``, 0, 0},
		} {
			t.Run(protocol+"/"+tc.name, func(t *testing.T) {
				var record Record
				c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
					fmt.Fprint(w, `{"model":"decision-model-preview","request_id":"compatible-request-1","answers":{"scope":{"choice":"full_tools","confidence":0.87,"probabilities":{"full_tools":0.93,"search_only":0.07},"type":"choice"}}`+tc.usage+`}`)
				}, func(cfg *Config) {
					cfg.Protocol = protocol
					cfg.Recorder = func(_ context.Context, r Record) error { record = r; return nil }
				})
				result, err := c.Evaluate(t.Context(), openRouterScopeRequest("decision-model-preview"), Options{})
				if err != nil {
					t.Fatalf("compatible response rejected: %v", err)
				}
				if *result.Answers["scope"].Choice != "full_tools" || result.Usage.InputTokens != tc.input || result.Usage.OutputTokens != tc.output || result.RequestID != "compatible-request-1" {
					t.Fatalf("incorrect response: %+v", result)
				}
				if !record.UsageKnown || record.Usage.InputTokens != tc.input || record.Usage.OutputTokens != tc.output || record.RequestID != result.RequestID || record.Attempts != 1 {
					t.Fatalf("incorrect accounting record: %+v", record)
				}
				stats := c.Stats()
				if stats.Failures != 0 || stats.Attempts != 1 || stats.UnknownUsage != 0 || stats.InputTokens != uint64(tc.input) || stats.OutputTokens != uint64(tc.output) {
					t.Fatalf("incorrect usage statistics: %+v", stats)
				}
			})
		}
	}
}

func TestCompatibleResponseRequestID(t *testing.T) {
	for _, tc := range []struct {
		name, header, requestID, id, want string
	}{
		{"header takes precedence", "header-id", "body-request-id", "body-id", "header-id"},
		{"body request ID", "", "body-request-id", "body-id", "body-request-id"},
		{"body ID fallback", "", "", "body-id", "body-id"},
		{"invalid request ID", "", "unsafe request ID", "body-id", "body-id"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var record Record
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Request-ID", tc.header)
				fmt.Fprintf(w, `{"model":"jev-1.13.0","request_id":%q,"id":%q,"answers":{}}`, tc.requestID, tc.id)
			}, func(cfg *Config) {
				cfg.Recorder = func(_ context.Context, r Record) error { record = r; return nil }
			})
			result, err := c.Evaluate(t.Context(), request(), Options{})
			var apiErr *Error
			if !errors.As(err, &apiErr) || apiErr.Kind != ErrResponse || apiErr.RequestID != tc.want || record.RequestID != tc.want || result == nil || result.RequestID != tc.want {
				t.Fatalf("request ID lost: result=%+v record=%+v error=%v", result, record, err)
			}
		})
	}
}

func TestCompatibleResponseMinimalAnswers(t *testing.T) {
	for _, protocol := range []string{"typesafe.decisions", OpenRouterDecisionsProtocol} {
		for _, tc := range []struct {
			name, answer string
			q            Question
			confidence   float64
		}{
			{"probabilities only", `{"choice":"a","probabilities":{"a":0.9,"b":0.1}}`, NewChoice("q", map[string]any{"a": nil, "b": nil}), 0.8},
			{"confidence only", `{"type":"choice","choice":"a","confidence":0.9}`, NewChoice("q", map[string]any{"a": nil, "b": nil}), 0.9},
			{"partial probabilities", `{"choice":"a","confidence":0.9,"probabilities":{"a":0.7}}`, NewChoice("q", map[string]any{"a": nil, "b": nil}), 0.9},
			{"invalid distribution", `{"choice":"a","confidence":0.9,"probabilities":{"a":0.7,"b":0.8}}`, NewChoice("q", map[string]any{"a": nil, "b": nil}), 0.9},
			{"invalid confidence with probabilities", `{"choice":"a","confidence":-1,"probabilities":{"a":0.9,"b":0.1}}`, NewChoice("q", map[string]any{"a": nil, "b": nil}), 0.8},
			{"malformed optional metadata", `{"choice":"a","confidence":0.9,"probabilities":"unavailable","legend":[]}`, NewChoice("q", map[string]any{"a": nil, "b": nil}), 0.9},
			{"score with confidence", `{"score":0.3,"confidence":0.9}`, NewScore("q", []any{"low", "high"}), 0.9},
			{"score with probabilities", `{"score":0.3,"probabilities":{"0":0.7,"1":0.3}}`, NewScore("q", []any{"low", "high"}), 0.4},
			{"noul only", `{"noul":0}`, NewNoul("q", nil), 0},
			{"noul metadata", `{"noul":0,"confidence":0.9}`, NewNoul("q", nil), 0},
		} {
			t.Run(protocol+"/"+tc.name, func(t *testing.T) {
				var record Record
				c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
					fmt.Fprintf(w, `{"answers":{"check":%s,"extra":"ignored"}}`, tc.answer)
				}, func(cfg *Config) {
					cfg.Protocol = protocol
					cfg.Recorder = func(_ context.Context, r Record) error { record = r; return nil }
				})
				result, err := c.Evaluate(t.Context(), Request{State: "text", Questions: map[string]Question{"check": tc.q}}, Options{})
				if err != nil || result == nil {
					t.Fatalf("usable answer rejected: result=%+v err=%v", result, err)
				}
				a := result.Answers["check"]
				if len(result.Answers) != 1 || a.Type != tc.q.Type || result.Model != DefaultModel || !record.UsageKnown || record.Usage.InputTokens != 0 || record.Usage.OutputTokens != 0 {
					t.Fatalf("incorrect normalized answer/accounting: result=%+v record=%+v", result, record)
				}
				if tc.q.Type == Noul {
					if a.Confidence != nil || a.Noul == nil || *a.Noul != 0 {
						t.Fatalf("incorrect noul answer: %+v", a)
					}
				} else if a.Confidence == nil || math.Abs(*a.Confidence-tc.confidence) > 1e-9 {
					t.Fatalf("incorrect confidence fallback: %+v", a)
				}
				if tc.q.Type == Score && (a.Score == nil || *a.Score != 0.3 || len(a.Legend) != 2) {
					t.Fatalf("score/legend missing: %+v", a)
				}
			})
		}
	}
}

func TestCompatibleResponseDifferentServedModel(t *testing.T) {
	var record Record
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, strings.Replace(noulResponse, DefaultModel, "decision-model-preview", 1))
	}, func(cfg *Config) {
		cfg.Recorder = func(_ context.Context, r Record) error { record = r; return nil }
	})
	result, err := c.Evaluate(t.Context(), request(), Options{})
	if err != nil || result == nil || result.Model != "decision-model-preview" || record.ServedModel != result.Model || record.RequestedModel != DefaultModel {
		t.Fatalf("compatible model metadata rejected/lost: result=%+v record=%+v err=%v", result, record, err)
	}
}

func TestRetriesAndPermanentErrors(t *testing.T) {
	for _, status := range []int{429, 529, 502, 503, 504, 401, 403, 422, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int32
			var record Record
			var logs bytes.Buffer
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					w.WriteHeader(status)
					fmt.Fprint(w, `{"error":"private user text secret-key"}`)
					return
				}
				fmt.Fprint(w, noulResponse)
			}, func(cfg *Config) {
				cfg.MaxRetries = 1
				cfg.Logger = log.New(&logs, "", 0)
				cfg.Recorder = func(_ context.Context, r Record) error { record = r; return nil }
			})
			_, err := c.Evaluate(context.Background(), request(), Options{})
			want := int32(1)
			if retryable(status) {
				want = 2
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("expected HTTP error")
			}
			if calls.Load() != want || record.Attempts != int(want) {
				t.Fatalf("calls=%d record=%+v", calls.Load(), record)
			}
			if strings.Contains(logs.String()+fmt.Sprint(err), "private user text") || strings.Contains(logs.String()+fmt.Sprint(err), "secret-key") {
				t.Fatal("upstream error body leaked")
			}
		})
	}
}

func TestDeadlineBoundsBackoffAndBody(t *testing.T) {
	for _, slowBody := range []bool{false, true} {
		t.Run(fmt.Sprint(slowBody), func(t *testing.T) {
			var calls atomic.Int32
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if !slowBody {
					w.Header().Set("Retry-After", "120")
					w.WriteHeader(429)
					return
				}
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}, func(cfg *Config) { cfg.MaxRetries = 2 })
			started := time.Now()
			_, err := c.Evaluate(context.Background(), request(), Options{Timeout: 40 * time.Millisecond})
			if KindOf(err) != ErrTimeout || !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 1 || time.Since(started) > time.Second {
				t.Fatalf("deadline failure: %v calls=%d", err, calls.Load())
			}
		})
	}
}

func TestCancellationRecordingErrorAndResponseLimit(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, noulResponse) }, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Evaluate(ctx, request(), Options{}); !errors.Is(err, context.Canceled) || c.Stats().Attempts != 0 {
		t.Fatalf("pre-canceled request: %v", err)
	}
	recorderErr := errors.New("database unavailable")
	c = testClient(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, noulResponse) }, func(cfg *Config) {
		cfg.Recorder = func(ctx context.Context, r Record) error { return recorderErr }
	})
	out, err := c.Evaluate(context.Background(), request(), Options{})
	if out == nil || KindOf(err) != ErrRecording || !errors.Is(err, recorderErr) || c.Stats().InputTokens != 100 || c.Stats().Attempts != 1 {
		t.Fatalf("recording failure lost result or caused retry: %v", err)
	}
	c = testClient(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, noulResponse) }, func(cfg *Config) { cfg.MaxResponseBytes = 10 })
	if _, err := c.Evaluate(context.Background(), request(), Options{}); KindOf(err) != ErrResponse {
		t.Fatalf("expected response limit error: %v", err)
	}
}

func TestRedirectNotFollowed(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1) }))
	defer target.Close()
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }, nil)
	if _, err := c.Evaluate(context.Background(), request(), Options{}); KindOf(err) != ErrHTTP || forwarded.Load() != 0 {
		t.Fatalf("redirect followed or not reported: %v", err)
	}
}

func TestConcurrentUsageStats(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, noulResponse) }, nil)
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if _, err := c.Evaluate(context.Background(), request(), Options{}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	s := c.Stats()
	if s.Calls != 20 || s.Attempts != 20 || s.Failures != 0 || s.InputTokens != 2000 || s.OutputTokens != 200 {
		t.Fatalf("incorrect concurrent stats: %+v", s)
	}
}

func TestRetryAfterFormats(t *testing.T) {
	if retryDelay("2", 0, time.Millisecond) < 2*time.Second {
		t.Fatal("ignored seconds")
	}
	if retryDelay(time.Now().Add(time.Minute).UTC().Format(http.TimeFormat), 0, time.Millisecond) < 58*time.Second {
		t.Fatal("ignored HTTP date")
	}
	if retryDelay("9223372036854775807", 0, time.Millisecond) < time.Hour {
		t.Fatal("overflowed large delay")
	}
}

func TestChoiceAndScoreRejectMalformedAnswers(t *testing.T) {
	choice := `{"type":"choice","choice":"a","confidence":0.5,"probabilities":{"a":0.7,"b":0.3}}`
	score := `{"type":"score","score":0.3,"confidence":0.5,"probabilities":{"0":0.7,"1":0.3},"legend":{"0":"low","1":"high"}}`
	for _, tc := range []struct {
		name   string
		q      Question
		answer string
	}{
		{"unknown choice", NewChoice("q", map[string]any{"a": nil, "b": nil}), strings.Replace(choice, `"choice":"a"`, `"choice":"c"`, 1)},
		{"missing decision confidence", NewChoice("q", map[string]any{"a": nil, "b": nil}), `{"choice":"a"}`},
		{"invalid decision metadata", NewChoice("q", map[string]any{"a": nil, "b": nil}), `{"choice":"a","confidence":-1,"probabilities":{"a":null,"b":2}}`},
		{"missing score confidence", NewScore("q", []any{"low", "high"}), `{"score":0.3}`},
		{"missing choice", NewChoice("q", map[string]any{"a": nil, "b": nil}), strings.Replace(choice, `"choice":"a",`, ``, 1)},
		{"invalid choice type", NewChoice("q", map[string]any{"a": nil, "b": nil}), strings.Replace(choice, `"choice":"a"`, `"choice":1`, 1)},
		{"score out of range", NewScore("q", []any{"low", "high"}), strings.Replace(score, `"score":0.3`, `"score":2`, 1)},
		{"missing score", NewScore("q", []any{"low", "high"}), strings.Replace(score, `"score":0.3,`, ``, 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintf(w, `{"model":"jev-1.13.0","answers":{"check":%s},"usage":{"input_tokens":10,"output_tokens":1}}`, tc.answer)
			}, nil)
			out, err := c.Evaluate(context.Background(), Request{State: "text", Questions: map[string]Question{"check": tc.q}}, Options{})
			if KindOf(err) != ErrResponse || out == nil || len(out.Answers) != 0 || out.Usage.InputTokens != 10 {
				t.Fatalf("out=%+v err=%v", out, err)
			}
		})
	}
}

func TestAliyunSystemOneCompatibleEndpoint(t *testing.T) {
	for _, base := range []string{"https://maas.qianwenaiapi.com/compatible-mode", "https://maas.qianwenaiapi.com/compatible-mode/v1", "https://maas.qianwenaiapi.com/compatible-mode/v1/systemone"} {
		c, err := New(Config{APIKey: "key", BaseURL: base, Model: "decision-model-preview"})
		if err != nil || c.endpoint != "https://maas.qianwenaiapi.com/compatible-mode/v1/systemone" {
			t.Fatalf("invalid Aliyun endpoint: client=%+v err=%v", c, err)
		}
	}
}

func TestAliyunSystemOneDocumentedResponse(t *testing.T) {
	var record Record
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/compatible-mode/v1/systemone" {
			t.Errorf("wrong Aliyun compatibility path: %s", r.URL.Path)
		}
		var sent Request
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Fatal(err)
		}
		if _, ok := sent.Questions["escalate"].Instructions.(string); !ok {
			t.Error("Aliyun received non-string instructions")
		}
		fmt.Fprint(w, `{"model":"decision-model-preview","request_id":"7b986c65-b223-9341-b5f0-b988e27ecaac","answers":{"department":{"type":"choice","choice":"billing","confidence":0.88,"probabilities":{"billing":0.94,"technical":0.06}},"escalate":{"type":"noul","noul":0.99},"severity":{"type":"score","score":2.25,"confidence":0.91,"legend":{"0":"minor","1":"partial","2":"unavailable","3":"serious"},"probabilities":{"0":0,"1":0.01,"2":0.73,"3":0.26}}},"usage":{"input_tokens":125},"latency_ms":52.9}`)
	}))
	defer srv.Close()
	c, err := New(Config{APIKey: "key", BaseURL: srv.URL + "/compatible-mode", Model: "decision-model-preview", Recorder: func(_ context.Context, r Record) error { record = r; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	req := Request{State: "ticket", Questions: map[string]Question{
		"department": NewChoice("Team?", map[string]any{"billing": "Payments", "technical": "Bugs"}),
		"escalate":   NewNoul(map[string]any{"question": "Escalate?", "category": "Urgent"}, nil),
		"severity":   NewScore("Severity?", []any{"minor", "partial", "unavailable", "serious"}),
	}}
	result, err := c.Evaluate(t.Context(), req, Options{})
	if err != nil || result == nil {
		t.Fatalf("Aliyun response rejected: %v", err)
	}
	if len(result.Answers) != 3 || *result.Answers["department"].Confidence != 0.88 || *result.Answers["severity"].Score != 2.25 || *result.Answers["escalate"].Noul != 0.99 || record.Usage.InputTokens != 125 || record.Usage.OutputTokens != 0 || result.RequestID != "7b986c65-b223-9341-b5f0-b988e27ecaac" {
		t.Fatalf("Aliyun response lost fields: result=%+v record=%+v", result, record)
	}
	if _, ok := req.Questions["escalate"].Instructions.(map[string]any); !ok {
		t.Fatal("caller request mutated")
	}
}

func TestStateShapesAndExplicitVersionPolicy(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, noulResponse) }, nil)
	for _, state := range []any{"text", []string{"one", "two"}, map[string]string{"message": "text"}, struct {
		Message string `json:"message"`
	}{"text"}, json.RawMessage(`{"message":"text"}`)} {
		req := request()
		req.State = state
		if _, err := c.Evaluate(context.Background(), req, Options{}); err != nil {
			t.Fatal(err)
		}
	}
	req := request()
	req.Model = "jev-latest"
	if _, err := c.Evaluate(context.Background(), req, Options{ExpectedModel: "jev-1.14.0"}); KindOf(err) != ErrModelVersion {
		t.Fatalf("alias guard: %v", err)
	}
	if _, err := c.Evaluate(context.Background(), request(), Options{ExpectedModel: "jev-1.14.0"}); KindOf(err) != ErrModelVersion {
		t.Fatalf("explicit version guard: %v", err)
	}
}

func TestClientConfiguration(t *testing.T) {
	for _, cfg := range []Config{
		{},
		{APIKey: "key", BaseURL: "file:///tmp/api"},
		{APIKey: "key", BaseURL: "https://user:pass@example.test"},
		{APIKey: "key", BaseURL: "https://example.test?secret=key"},
		{APIKey: "key", MaxRetries: 6},
		{APIKey: "key", Timeout: -time.Second},
		{APIKey: "key", MaxResponseBytes: -1},
	} {
		if _, err := New(cfg); err == nil {
			t.Fatal("accepted invalid config")
		}
	}
	for _, base := range []string{"https://example.test", "https://example.test/v1/"} {
		c, err := New(Config{APIKey: "key", BaseURL: base})
		if err != nil || c.endpoint != "https://example.test/v1/systemone" {
			t.Fatalf("endpoint config: %v %v", c, err)
		}
	}
}

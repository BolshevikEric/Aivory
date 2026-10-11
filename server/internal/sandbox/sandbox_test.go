package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPSandboxPreservesSidecarStatusForBoundedRecovery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"detail":"session is busy"}`))
	}))
	defer server.Close()

	svc := New(server.URL, "")
	_, err := svc.Exec(context.Background(), "session-123", "print(1)")
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("Exec error=%T %v, want *HTTPError", err, err)
	}
	if httpErr.StatusCode != http.StatusTooManyRequests || httpErr.Body != `{"detail":"session is busy"}` {
		t.Fatalf("HTTPError=%+v", httpErr)
	}
}

func TestHTTPSandboxResetInputsUsesFixedEndpoint(t *testing.T) {
	var gotSession string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/files/reset-inputs" {
			t.Errorf("path = %s, want /files/reset-inputs", r.URL.Path)
		}
		var body struct {
			SessionID string `json:"session_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		gotSession = body.SessionID
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	svc := New(server.URL, "")
	if err := svc.ResetInputs(context.Background(), "session-123"); err != nil {
		t.Fatalf("ResetInputs: %v", err)
	}
	if gotSession != "session-123" {
		t.Fatalf("session_id = %q, want session-123", gotSession)
	}
}

func TestHTTPSandboxResetInputsConvertsStructuredGoneResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":false,"session_gone":true}`))
	}))
	defer server.Close()

	svc := New(server.URL, "")
	if err := svc.ResetInputs(context.Background(), "reaped-session"); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("ResetInputs error=%v, want ErrSessionGone", err)
	}
}

func TestHTTPSandboxDiscardUsesStableArchiveAndReportsFailures(t *testing.T) {
	for _, sessionID := range []string{"active-session", ""} {
		t.Run(sessionID, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				want := "/sessions/" + sessionID
				if sessionID == "" {
					want = "/archives/conv_123"
				}
				if r.Method != "DELETE" || r.URL.Path != want {
					t.Errorf("discard=%s %s", r.Method, r.URL.Path)
				}
				var body struct {
					Discard    bool   `json:"discard"`
					ArchiveKey string `json:"archive_key"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !body.Discard || body.ArchiveKey != "conv_123" {
					t.Errorf("discard body=%+v err=%v", body, err)
				}
				w.WriteHeader(500)
				_, _ = w.Write([]byte(`{"detail":"archive purge failed"}`))
			}))
			defer server.Close()
			err := New(server.URL, "").ReleaseDiscard(context.Background(), sessionID, "conv_123")
			var httpErr *HTTPError
			if !errors.As(err, &httpErr) || httpErr.StatusCode != 500 {
				t.Fatalf("purge failure=%v", err)
			}
		})
	}
}

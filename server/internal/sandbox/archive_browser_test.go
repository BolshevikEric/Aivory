package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsSessionGoneRequiresAnExplicitSessionExpiry(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		gone bool
	}{
		{"sentinel", ErrSessionGone, true},
		{"old sidecar", &HTTPError{404, `{"detail":"session not found or not running"}`}, true},
		{"missing file", &HTTPError{404, `{"detail":"file not found"}`}, false},
		{"missing route", &HTTPError{404, `{"detail":"Not Found"}`}, false},
		{"daemon unavailable", &HTTPError{503, `{"detail":"session not found"}`}, false},
		{"untyped error", errors.New("sandbox 404: not found"), false},
		{"success", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsSessionGone(tc.err); got != tc.gone {
				t.Fatalf("IsSessionGone=%v, want %v", got, tc.gone)
			}
		})
	}
}

func TestHTTPArchiveBrowserPayloadAndStatuses(t *testing.T) {
	for _, tc := range []struct {
		name, response string
		status         int
		want           error
	}{
		{"ready", `{"archive_status":"ready","files":[{"path":"outputs/report.txt","size":6}],"data_base64":"cmVwb3J0"}`, 200, nil},
		{"missing", `{"archive_status":"missing"}`, 200, ErrArchiveMissing},
		{"not configured", `{"archive_status":"not_configured"}`, 200, ErrArchiveNotConfigured},
		{"file missing", `{"archive_status":"file_missing"}`, 200, ErrArchiveFileMissing},
		{"old endpoint", `{"detail":"Not Found"}`, 404, ErrArchiveUnsupported},
		{"unknown status", `{}`, 200, ErrArchiveUnsupported},
		{"broken storage", `{"detail":"storage unavailable"}`, 502, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || (r.URL.Path != "/archives/files/list" && r.URL.Path != "/archives/files/get") {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer secret" {
					t.Error("missing auth")
				}
				var body struct {
					ArchiveKey string        `json:"archive_key"`
					SessionID  string        `json:"session_id"`
					Path       string        `json:"path"`
					Storage    StorageConfig `json:"storage"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body.ArchiveKey != "conv" || body.SessionID != "old-session" || body.Storage.Provider != "local" {
					t.Errorf("payload=%+v", body)
				}
				if r.URL.Path == "/archives/files/get" && body.Path != "outputs/report.txt" {
					t.Errorf("path=%q", body.Path)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.response))
			}))
			defer server.Close()
			browser := NewWithOptions(Options{BaseURL: server.URL, APIKey: "secret", Storage: &StorageConfig{Provider: "local"}}).(ArchiveBrowser)
			files, err := browser.ListArchivedFiles(context.Background(), "conv", "old-session")
			data, fileErr := browser.GetArchivedFile(context.Background(), "conv", "old-session", "outputs/report.txt")
			for _, got := range []error{err, fileErr} {
				if tc.status == 502 {
					var httpErr *HTTPError
					if !errors.As(got, &httpErr) || httpErr.StatusCode != 502 {
						t.Fatalf("storage error lost: %v", got)
					}
				} else if !errors.Is(got, tc.want) {
					t.Fatalf("error=%v, want %v", got, tc.want)
				}
			}
			if tc.name == "ready" && (len(files) != 1 || string(data) != "report") {
				t.Fatalf("files=%v data=%q", files, data)
			}
		})
	}
}

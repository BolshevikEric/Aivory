package api

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"aivory/server/internal/config"
	"aivory/server/internal/store"
	"aivory/server/internal/tools"
)

func TestSandboxBrowserFallsBackToArchiveWithoutCreatingSessions(t *testing.T) {
	for _, admin := range []bool{false, true} {
		t.Run(map[bool]string{false: "user", true: "admin"}[admin], func(t *testing.T) {
			ctx := context.Background()
			db := openMigrated(t, filepath.Join(t.TempDir(), "browser.db"))
			defer db.Close()
			mustExec(t, db, `INSERT INTO users(id,email,password_hash,role,status) VALUES ('owner','owner@example.test','h','user','active')`)
			_, err := store.CreateConversation(ctx, db, store.Conversation{ID: "conv", UserID: "owner", Title: "Sandbox", ProviderState: json.RawMessage(`{"sandbox_id":"old-session"}`)})
			if err != nil {
				t.Fatal(err)
			}
			var calls []string
			sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls = append(calls, r.URL.Path)
				var body struct {
					ArchiveKey string `json:"archive_key"`
					SessionID  string `json:"session_id"`
					Path       string `json:"path"`
					Storage    struct {
						Provider string `json:"provider"`
					} `json:"storage"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body.SessionID != "old-session" {
					t.Errorf("session=%q", body.SessionID)
				}
				if strings.HasPrefix(r.URL.Path, "/archives/") && (body.ArchiveKey != "conv" || body.Storage.Provider != "local") {
					t.Errorf("archive payload=%+v", body)
				}
				switch r.URL.Path {
				case "/files/list", "/files/get":
					w.WriteHeader(404)
					_, _ = io.WriteString(w, `{"detail":"session not found or not running"}`)
				case "/archives/files/list":
					_, _ = io.WriteString(w, `{"archive_status":"ready","files":[{"path":"uploads/source.csv","size":6}]}`)
				case "/archives/files/get":
					if body.Path != "uploads/source.csv" {
						t.Errorf("path=%q", body.Path)
					}
					_, _ = io.WriteString(w, `{"archive_status":"ready","data_base64":"cmVwb3J0"}`)
				default:
					t.Errorf("browser must not mutate sandbox: %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer sidecar.Close()
			for key, value := range map[string]string{"sandbox_base_url": sidecar.URL, "storage_provider": "local"} {
				if err := store.SetSetting(db, key, value); err != nil {
					t.Fatal(err)
				}
			}
			d := Deps{DB: db, Tools: tools.NewRegistry(db, config.Config{}, log.New(io.Discard, "", 0))}
			request := func(path string, file bool) *httptest.ResponseRecorder {
				req := httptest.NewRequest("GET", path, nil)
				req = req.WithContext(context.WithValue(req.Context(), pathCtxKey{}, map[string]string{"id": "conv"}))
				rec := httptest.NewRecorder()
				if file {
					serveSandboxBrowserFile(d, rec, req, "owner", admin)
				} else {
					serveSandboxBrowserList(d, rec, req, "owner", admin)
				}
				return rec
			}
			list := request("/sandbox", false)
			if list.Code != 200 || !strings.Contains(list.Body.String(), `"archived":true`) || !strings.Contains(list.Body.String(), "uploads/source.csv") {
				t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
			}
			file := request("/sandbox/file?path=uploads/source.csv", true)
			if file.Code != 200 || file.Body.String() != "report" {
				t.Fatalf("file status=%d body=%s", file.Code, file.Body.String())
			}
			for _, rec := range []*httptest.ResponseRecorder{list, file} {
				if rec.Header().Get("Cache-Control") != "private, no-store" {
					t.Fatal("private files must not be cached")
				}
			}
			if !strings.Contains(file.Header().Get("Content-Security-Policy"), "sandbox") {
				t.Fatal("archive preview lost CSP")
			}
			sid, err := store.GetConvProviderStateKey(ctx, db, "conv", "sandbox_id")
			if err != nil || sid != "old-session" || len(calls) != 4 {
				t.Fatalf("browser changed session: sid=%q err=%v calls=%v", sid, err, calls)
			}
		})
	}
}

func TestSandboxBrowserDistinguishesUnavailableReasons(t *testing.T) {
	for _, tc := range []struct {
		name, liveBody, archiveBody, reason                 string
		liveStatus, archiveStatus, fileStatus, archiveCalls int
	}{
		{"no archive", `{"detail":"session not found"}`, `{"archive_status":"missing"}`, "archive_missing", 404, 200, 404, 2},
		{"no storage", `{"detail":"session not found"}`, `{"archive_status":"not_configured"}`, "archive_not_configured", 404, 200, 502, 2},
		{"storage failure", `{"detail":"session not found"}`, `{"detail":"secret storage error"}`, "archive_read_failed", 404, 502, 502, 2},
		{"old archive service", `{"detail":"session not found"}`, `{"detail":"Not Found"}`, "unsupported", 404, 404, 502, 2},
		{"missing live route", `{"detail":"Not Found"}`, "", "unsupported", 404, 200, 404, 0},
		{"daemon failure", `{"detail":"Cannot connect to Docker daemon"}`, "", "service_unavailable", 503, 200, 502, 0},
		{"missing live file", `{"detail":"file not found"}`, "", "unsupported", 404, 200, 404, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := openMigrated(t, filepath.Join(t.TempDir(), "browser.db"))
			defer db.Close()
			mustExec(t, db, `INSERT INTO users(id,email,password_hash,role,status) VALUES ('owner','owner@example.test','h','user','active')`)
			_, err := store.CreateConversation(context.Background(), db, store.Conversation{ID: "conv", UserID: "owner", ProviderState: json.RawMessage(`{"sandbox_id":"sid"}`)})
			if err != nil {
				t.Fatal(err)
			}
			archiveCalls := 0
			sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/archives/") {
					archiveCalls++
					w.WriteHeader(tc.archiveStatus)
					_, _ = io.WriteString(w, tc.archiveBody)
				} else {
					w.WriteHeader(tc.liveStatus)
					_, _ = io.WriteString(w, tc.liveBody)
				}
			}))
			defer sidecar.Close()
			if err := store.SetSetting(db, "sandbox_base_url", sidecar.URL); err != nil {
				t.Fatal(err)
			}
			d := Deps{DB: db, Tools: tools.NewRegistry(db, config.Config{}, log.New(io.Discard, "", 0))}
			for _, file := range []bool{false, true} {
				req := httptest.NewRequest("GET", "/sandbox?path=outputs/report.txt", nil)
				req = req.WithContext(context.WithValue(req.Context(), pathCtxKey{}, map[string]string{"id": "conv"}))
				rec := httptest.NewRecorder()
				if file {
					serveSandboxBrowserFile(d, rec, req, "owner", false)
					if rec.Code != tc.fileStatus {
						t.Fatalf("file status=%d body=%s", rec.Code, rec.Body.String())
					}
				} else {
					serveSandboxBrowserList(d, rec, req, "owner", false)
					if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"unavailable_reason":"`+tc.reason+`"`) {
						t.Fatalf("list status=%d body=%s", rec.Code, rec.Body.String())
					}
				}
				if strings.Contains(rec.Body.String(), "secret storage error") {
					t.Fatal("raw storage error exposed")
				}
			}
			if archiveCalls != tc.archiveCalls {
				t.Fatalf("archive calls=%d, want %d", archiveCalls, tc.archiveCalls)
			}
		})
	}
}

func TestSandboxBrowserEmptySessionAndAccessRevocation(t *testing.T) {
	db := openMigrated(t, filepath.Join(t.TempDir(), "browser.db"))
	defer db.Close()
	mustExec(t, db, `INSERT INTO users(id,email,password_hash,role,status) VALUES ('owner','owner@example.test','h','user','active')`)
	_, err := store.CreateConversation(context.Background(), db, store.Conversation{ID: "conv", UserID: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if _, err := db.Exec(`DELETE FROM conversations WHERE id='conv'`); err != nil {
			t.Error(err)
		}
		_, _ = io.WriteString(w, `{"files":[{"path":"secret.txt","size":1}],"data_base64":"c2VjcmV0"}`)
	}))
	defer sidecar.Close()
	if err := store.SetSetting(db, "sandbox_base_url", sidecar.URL); err != nil {
		t.Fatal(err)
	}
	d := Deps{DB: db, Tools: tools.NewRegistry(db, config.Config{}, log.New(io.Discard, "", 0))}
	request := func(file, admin bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/sandbox?path=secret.txt", nil)
		req = req.WithContext(context.WithValue(req.Context(), pathCtxKey{}, map[string]string{"id": "conv"}))
		rec := httptest.NewRecorder()
		if file {
			serveSandboxBrowserFile(d, rec, req, "owner", admin)
		} else {
			serveSandboxBrowserList(d, rec, req, "owner", admin)
		}
		return rec
	}
	if rec := request(false, false); rec.Code != 200 || calls != 0 {
		t.Fatalf("empty session must not read/provision: status=%d calls=%d", rec.Code, calls)
	}
	if rec := request(true, false); rec.Code != 404 || calls != 0 {
		t.Fatalf("empty session file: status=%d calls=%d", rec.Code, calls)
	}
	for _, admin := range []bool{false, true} {
		for _, file := range []bool{false, true} {
			_, err := db.Exec(`INSERT OR REPLACE INTO conversations(id,user_id,title,provider_state) VALUES ('conv','owner','Sandbox','{"sandbox_id":"sid"}')`)
			if err != nil {
				t.Fatal(err)
			}
			rec := request(file, admin)
			if rec.Code != 404 || strings.Contains(rec.Body.String(), "secret") {
				t.Fatalf("revoked read leaked: admin=%v file=%v status=%d body=%s", admin, file, rec.Code, rec.Body.String())
			}
		}
	}
}

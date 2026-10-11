package api

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"aivory/server/internal/config"
	"aivory/server/internal/store"
	"aivory/server/internal/tools"
)

func TestConversationDeletionDurablyRetriesSandboxAndStorageAfterRestart(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "cleanup.db")
	db := openMigrated(t, dbPath)
	defer func() { _ = db.Close() }()
	uploadDir := t.TempDir()
	shared := filepath.Join(uploadDir, "shared.txt")
	orphan := filepath.Join(uploadDir, "orphan.txt")
	blocked := filepath.Join(uploadDir, "blocked-dir")
	if err := os.WriteFile(shared, []byte("shared"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orphan, []byte("orphan"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocked, "child"), []byte("block removal"), 0600); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	mustExec(t, db, `INSERT INTO conversations(id,user_id,title,provider_state) VALUES
		('root','u','Delete','{"sandbox_id":"active"}'),
		('inline','u','Inline','{"sandbox_id":"reaped"}'),
		('fork','u','Keep','{}')`)
	mustExec(t, db, `UPDATE conversations SET inline_source_conv='root' WHERE id='inline'`)
	mustExec(t, db, `INSERT INTO files(id,user_id,conversation_id,filename,storage_path) VALUES
		('shared','u','root','shared.txt',?),('fork-copy','u','fork','shared.txt',?),
		('orphan','u','root','orphan.txt',?),('blocked','u','inline','blocked',?),
		('remote','u','root','remote.txt','storage://uploads/remote.txt')`, shared, shared, orphan, blocked)
	mustExec(t, db, `INSERT INTO channels(id,name,type) VALUES('ch','Embedding','openai')`)
	mustExec(t, db, `INSERT INTO models(id,channel_id,kind,request_id,label,dim) VALUES('emb','ch','embedding','embedding','Embedding',3)`)
	mustExec(t, db, `INSERT INTO knowledge_bases(id,user_id,name,embedding_model_id,embedding_dim) VALUES('kb','u','Keep','emb',3)`)
	mustExec(t, db, `INSERT INTO documents(id,kb_id,filename,mime_type,size_bytes,status,storage_path) VALUES('kb-copy','kb','shared.txt','text/plain',6,'ready',?)`, shared)
	mustExec(t, db, `INSERT INTO settings(key,value) VALUES('storage_provider','"local"')`)
	var outage atomic.Bool
	outage.Store(true)
	var sandboxDeletes, storageDeletes atomic.Int32
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Discard    bool           `json:"discard"`
			ArchiveKey string         `json:"archive_key"`
			Storage    map[string]any `json:"storage"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("sidecar body: %v", err)
		}
		if strings.HasPrefix(r.URL.Path, "/sessions/") {
			sandboxDeletes.Add(1)
			if r.Method != "DELETE" || !body.Discard || (body.ArchiveKey != "root" && body.ArchiveKey != "inline") || body.Storage["provider"] != "local" {
				t.Errorf("wrong sandbox purge: %s %s %+v", r.Method, r.URL.Path, body)
			}
		} else if r.URL.Path == "/storage/delete" {
			storageDeletes.Add(1)
		} else {
			t.Errorf("unexpected sidecar call: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		if outage.Load() {
			w.WriteHeader(503)
			_, _ = io.WriteString(w, `{"detail":"injected storage/sidecar outage"}`)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer sidecar.Close()
	cfg := config.Config{UploadDir: uploadDir, ArtifactDir: uploadDir, SandboxBaseURL: sidecar.URL}
	logger := log.New(io.Discard, "", 0)
	deps := Deps{DB: db, Config: cfg, Tools: tools.NewRegistry(db, cfg, logger), Logger: logger}
	req := httptest.NewRequest("DELETE", "/api/conversations/root", nil)
	req = req.WithContext(context.WithValue(req.Context(), pathCtxKey{}, map[string]string{"id": "root"}))
	req = req.WithContext(context.WithValue(req.Context(), userCtxKey{}, &store.User{ID: "u", Role: "user", Status: "active"}))
	res := httptest.NewRecorder()
	deleteConversationHandler(deps, res, req)
	if res.Code != 200 {
		t.Fatalf("delete status=%d body=%s", res.Code, res.Body.String())
	}
	if _, err := store.GetConversationByID(ctx, db, "root"); err != store.ErrNotFound {
		t.Fatalf("root not deleted: %v", err)
	}
	var pending int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pending_sandbox_cleanup WHERE attempts=1 AND last_error<>''`).Scan(&pending); err != nil || pending != 2 {
		t.Fatalf("sandbox retries=%d err=%v", pending, err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM pending_storage_cleanup WHERE attempts=1 AND last_error<>''`).Scan(&pending); err != nil || pending != 2 {
		t.Fatalf("storage retries=%d err=%v", pending, err)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("unshared file still exists: %v", err)
	}
	if _, err := os.Stat(shared); err != nil {
		t.Fatalf("shared bytes deleted: %v", err)
	}
	// A real reopen proves retry does not rely on in-process state or source rows.
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openMigrated(t, dbPath)
	deps.DB = db
	deps.Tools = tools.NewRegistry(db, cfg, logger)
	outage.Store(false)
	if err := os.Remove(filepath.Join(blocked, "child")); err != nil {
		t.Fatal(err)
	}
	// Repair the invalid local storage entry. Cleanup must keep the containment
	// and regular-file guard, then retry successfully once the path is a file.
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blocked, []byte("recovered file"), 0600); err != nil {
		t.Fatal(err)
	}
	resumeUserDeletions(deps)
	for _, table := range []string{"pending_storage_cleanup", "pending_sandbox_cleanup"} {
		if err := db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&pending); err != nil || pending != 0 {
			t.Fatalf("restart left %s rows=%d err=%v", table, pending, err)
		}
	}
	if sandboxDeletes.Load() != 4 || storageDeletes.Load() != 2 {
		t.Fatalf("retry calls sandbox=%d storage=%d", sandboxDeletes.Load(), storageDeletes.Load())
	}
	if _, err := os.Stat(blocked); !os.IsNotExist(err) {
		t.Fatalf("local failure not retried: %v", err)
	}
	if _, err := os.Stat(shared); err != nil {
		t.Fatalf("retry removed shared bytes: %v", err)
	}
	if _, err := store.GetConversationByID(ctx, db, "fork"); err != nil {
		t.Fatalf("fork lost: %v", err)
	}
}

func TestConversationCleanupSurvivesCanceledRequestAndPurgesArchiveWithoutSession(t *testing.T) {
	db := openMigrated(t, filepath.Join(t.TempDir(), "archive-only.db"))
	defer db.Close()
	mustExec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	mustExec(t, db, `INSERT INTO conversations(id,user_id,title,provider_state) VALUES('c','u','Archive only','{"sandbox_id":""}')`)
	mustExec(t, db, `INSERT INTO settings(key,value) VALUES('storage_provider','"local"')`)
	var called atomic.Int32
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" || r.URL.Path != "/archives/c" {
			t.Errorf("archive-only purge=%s %s", r.Method, r.URL.Path)
		}
		called.Add(1)
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer sidecar.Close()
	cfg := config.Config{SandboxBaseURL: sidecar.URL}
	deps := Deps{DB: db, Config: cfg, Tools: tools.NewRegistry(db, cfg, log.New(io.Discard, "", 0))}
	state, err := store.DeleteConversationWithState(context.Background(), db, "c", "u")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cleanupDeletedConversationResources(ctx, deps, state)
	if called.Load() != 1 {
		t.Fatal("request cancellation skipped archive cleanup")
	}
	items, err := store.ListPendingSandboxCleanup(context.Background(), db)
	if err != nil || len(items) != 0 {
		t.Fatalf("archive retry not removed: %+v %v", items, err)
	}
}

func TestObjectStorageDisabledKeepsCleanupRecordUntilConfigured(t *testing.T) {
	db := openMigrated(t, filepath.Join(t.TempDir(), "disabled-storage.db"))
	defer db.Close()
	mustExec(t, db, `INSERT INTO pending_storage_cleanup(path,user_id) VALUES('storage://uploads/pending','gone')`)
	sweepPendingStorageCleanup(Deps{DB: db})
	var attempts int
	var lastError string
	if err := db.QueryRow(`SELECT attempts,last_error FROM pending_storage_cleanup`).Scan(&attempts, &lastError); err != nil || attempts != 1 || !strings.Contains(lastError, "unavailable") {
		t.Fatalf("disabled storage forgotten: attempts=%d error=%q err=%v", attempts, lastError, err)
	}
}

func TestSandboxProvisionedDuringDeletionIsDiscardedAndRetried(t *testing.T) {
	db := openMigrated(t, filepath.Join(t.TempDir(), "late-session.db"))
	defer db.Close()
	mustExec(t, db, `INSERT INTO users(id,email,password_hash) VALUES('u','u@test','h')`)
	mustExec(t, db, `INSERT INTO conversations(id,user_id,title) VALUES('c','u','Delete during provision')`)
	var outage atomic.Bool
	outage.Store(true)
	var discarded atomic.Int32
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/sessions" {
			// Provisioning began before deletion; its ID was not yet recorded.
			if _, err := store.DeleteConversationWithState(context.Background(), db, "c", "u"); err != nil {
				t.Errorf("concurrent delete: %v", err)
			}
			_, _ = io.WriteString(w, `{"session_id":"late-session"}`)
			return
		}
		if r.Method == "DELETE" && r.URL.Path == "/archives/c" {
			_, _ = io.WriteString(w, `{"ok":true}`)
			return
		}
		var body struct {
			Discard    bool   `json:"discard"`
			ArchiveKey string `json:"archive_key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !body.Discard || body.ArchiveKey != "c" {
			t.Errorf("late session must not be archived: %+v err=%v", body, err)
		}
		if r.Method != "DELETE" || r.URL.Path != "/sessions/late-session" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		discarded.Add(1)
		if outage.Load() {
			w.WriteHeader(503)
			_, _ = io.WriteString(w, `{"detail":"outage"}`)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer sidecar.Close()
	cfg := config.Config{SandboxBaseURL: sidecar.URL}
	deps := Deps{DB: db, Config: cfg, Tools: tools.NewRegistry(db, cfg, log.New(io.Discard, "", 0))}
	if _, err := deps.Tools.EnsureConversationSandbox(context.Background(), "c", "u"); err == nil {
		t.Fatal("deleted conversation accepted a new sandbox")
	}
	var pending int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pending_sandbox_cleanup WHERE session_id='late-session' AND attempts=1`).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("late session leaked: pending=%d err=%v", pending, err)
	}
	outage.Store(false)
	sweepPendingSandboxCleanup(deps)
	if discarded.Load() != 2 {
		t.Fatalf("late session discard calls=%d", discarded.Load())
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM pending_sandbox_cleanup`).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("late session retry remains: %d %v", pending, err)
	}
}

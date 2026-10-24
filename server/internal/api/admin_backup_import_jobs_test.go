package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aivory/server/internal/config"
	"aivory/server/internal/fileguard"
	"aivory/server/internal/store"
	"github.com/google/uuid"
)

func backupJobRequest(method, target string, body *bytes.Buffer, id string) *http.Request {
	if body == nil {
		body = &bytes.Buffer{}
	}
	r := httptest.NewRequest(method, target, body)
	ctx := context.WithValue(r.Context(), userCtxKey{}, &store.User{ID: "adm", Role: "admin", Status: "active"})
	ctx = context.WithValue(ctx, pathCtxKey{}, map[string]string{"id": id})
	return r.WithContext(ctx)
}

func createBackupJobForTest(t *testing.T, d Deps, size int64) (*backupImportJob, string) {
	t.Helper()
	id := uuid.NewString()
	body := bytes.NewBufferString(fmt.Sprintf(`{"id":%q,"size_bytes":%d,"confirm":"REPLACE"}`, id, size))
	rec := httptest.NewRecorder()
	createBackupImportJobAdmin(d, rec, backupJobRequest(http.MethodPost, "/", body, id))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body)
	}
	j := adminBackupImports.lookup(id)
	t.Cleanup(func() {
		adminBackupImports.mu.Lock()
		delete(adminBackupImports.jobs, id)
		adminBackupImports.mu.Unlock()
		_ = os.Remove(j.path)
	})
	return j, j.token
}

func uploadBackupChunkForTest(t *testing.T, d Deps, id string, offset int64, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := multipartArchive(t, data)
	req := backupJobRequest(http.MethodPost, fmt.Sprintf("/chunks?offset=%d", offset), body, id)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	uploadBackupImportChunkAdmin(d, rec, req)
	return rec
}

func TestBackupImportChunksAreBoundedOrderedAndIdempotent(t *testing.T) {
	d := Deps{Config: config.Config{UploadDir: filepath.Join(t.TempDir(), "uploads")}}
	j, token := createBackupJobForTest(t, d, backupImportChunkBytes+5)
	first := bytes.Repeat([]byte("a"), int(backupImportChunkBytes))
	for _, attempt := range []struct {
		offset int64
		data   []byte
		status int
	}{
		{0, append(append([]byte(nil), first...), 'a'), 413},
		{1, []byte("wrong offset"), 409},
		{0, first, 200},
		{0, first, 200}, // response lost after success
		{0, bytes.Repeat([]byte("b"), int(backupImportChunkBytes)), 409},
		{backupImportChunkBytes, []byte("123456"), 409},
		{backupImportChunkBytes, []byte("12345"), 200},
	} {
		rec := uploadBackupChunkForTest(t, d, j.ID, attempt.offset, attempt.data)
		if rec.Code != attempt.status {
			t.Fatalf("offset=%d size=%d status=%d body=%s", attempt.offset, len(attempt.data), rec.Code, rec.Body)
		}
	}
	data, err := os.ReadFile(j.path)
	if err != nil || !bytes.Equal(data, append(first, []byte("12345")...)) {
		t.Fatalf("assembled bytes differ: size=%d err=%v", len(data), err)
	}
	for _, secret := range []string{"", "wrong", token} {
		req := backupJobRequest(http.MethodGet, "/", nil, j.ID)
		req.Header.Set("Authorization", "BackupImport "+secret)
		rec := httptest.NewRecorder()
		backupImportJobStatus(d, rec, req)
		want := http.StatusNotFound
		if secret == token {
			want = http.StatusOK
		}
		if rec.Code != want {
			t.Fatalf("capability response=%d want=%d", rec.Code, want)
		}
		if strings.Contains(rec.Body.String(), token) || strings.Contains(rec.Body.String(), j.path) {
			t.Fatal("status leaked credentials or storage path")
		}
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(d.Config.UploadDir), ".aivory-backup-upload-*"))
	if len(leftovers) != 1 || leftovers[0] != j.path {
		t.Fatalf("chunk temp files leaked: %v", leftovers)
	}
}

func TestBackupImportJobStartsOnceAndSurvivesRequestCancellation(t *testing.T) {
	d := newBackupAdminFixture(t, true)
	archive := manifestOnlyArchiveForTest(t, backupManifest{Format: "aivory-backup", Version: 1, Dialect: "sqlite", Counts: map[string]int64{}})
	j, token := createBackupJobForTest(t, d, int64(len(archive)))
	if rec := uploadBackupChunkForTest(t, d, j.ID, 0, archive); rec.Code != 200 {
		t.Fatalf("upload failed: %s", rec.Body)
	}
	// Hold the real cross-process storage lock so the restore cannot complete
	// until both start requests have returned and their contexts are cancelled.
	unlock, err := fileguard.LockStorage(context.Background(), true, d.Config.UploadDir, d.Config.ArtifactDir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	for range 2 {
		req := backupJobRequest(http.MethodPost, "/start", nil, j.ID)
		ctx, cancel := context.WithCancel(req.Context())
		rec := httptest.NewRecorder()
		startBackupImportJobAdmin(d, rec, req.WithContext(ctx))
		cancel()
		if rec.Code != 202 || !strings.Contains(rec.Body.String(), `"restoring"`) {
			t.Fatalf("start status=%d body=%s", rec.Code, rec.Body)
		}
	}
	rec := httptest.NewRecorder()
	cancelBackupImportUploadAdmin(d, rec, backupJobRequest(http.MethodDelete, "/", nil, j.ID))
	if rec.Code != 409 {
		t.Fatalf("active restore was cancellable: %d", rec.Code)
	}
	unlock()
	deadline := time.Now().Add(5 * time.Second)
	for {
		j.mu.Lock()
		state, failure := j.Status, j.Error
		j.mu.Unlock()
		if state != "restoring" {
			if state != "completed" {
				t.Fatalf("restore status=%s error=%s", state, failure)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background restore did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
	assertOneRestoredAdmin(t, d.DB, "admin@example.test", "adm", "current-admin-hash")
	var refreshCount int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM refresh_tokens`).Scan(&refreshCount); err != nil || refreshCount != 0 {
		t.Fatalf("restore did not invalidate sessions: count=%d err=%v", refreshCount, err)
	}
	// Even a restored closed-site policy must not block the scoped status token.
	mustExec(t, d.DB, `INSERT INTO settings(key,value) VALUES('site_access','{"closed":true,"message":"maintenance"}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
	mux := newMux()
	mux.handle("GET", "/api/public/backup-import-jobs/:id", wrap(d, backupImportJobStatus))
	req := httptest.NewRequest(http.MethodGet, "/api/public/backup-import-jobs/"+j.ID, nil)
	req.Header.Set("Authorization", "BackupImport "+token)
	rec = httptest.NewRecorder()
	siteAccessMiddleware(d, mux).ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("post-restore poll status=%d body=%s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(j.path); !os.IsNotExist(err) {
		t.Fatalf("upload ZIP not cleaned: %v", err)
	}
}

func TestBackupImportJobRechecksAdministratorAndPreservesData(t *testing.T) {
	d := newBackupAdminFixture(t, false)
	archive := manifestOnlyArchiveForTest(t, backupManifest{Format: "aivory-backup", Version: 1, Dialect: "sqlite", Counts: map[string]int64{}})
	j, _ := createBackupJobForTest(t, d, int64(len(archive)))
	if rec := uploadBackupChunkForTest(t, d, j.ID, 0, archive); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	mustExec(t, d.DB, `INSERT INTO settings(key,value) VALUES('site_title','"keep me"')`)
	mustExec(t, d.DB, `UPDATE users SET role='user' WHERE id='adm'`)
	// Drive the same worker synchronously so assertions observe its final state.
	j.Status = "restoring"
	runBackupImportJob(d, j, store.User{ID: "adm", Role: "admin"}, nil)
	if j.Status != "failed" || j.HTTPStatus != http.StatusForbidden {
		t.Fatalf("status=%s http=%d error=%s", j.Status, j.HTTPStatus, j.Error)
	}
	var title string
	if err := d.DB.QueryRow(`SELECT value FROM settings WHERE key='site_title'`).Scan(&title); err != nil || title != `"keep me"` {
		t.Fatalf("data changed after revoked admin: title=%s err=%v", title, err)
	}
}

func TestBackupImportJobRejectsIncompleteUploadAndOtherOwners(t *testing.T) {
	d := Deps{Config: config.Config{UploadDir: filepath.Join(t.TempDir(), "uploads"), MaxBackupBytes: 1024}}
	j, _ := createBackupJobForTest(t, d, 128)
	rec := httptest.NewRecorder()
	startBackupImportJobAdmin(d, rec, backupJobRequest(http.MethodPost, "/start", nil, j.ID))
	if rec.Code != 409 || j.Status != "uploading" {
		t.Fatalf("incomplete restore started: %d", rec.Code)
	}
	req := backupJobRequest(http.MethodPost, "/start", nil, j.ID)
	req = req.WithContext(context.WithValue(req.Context(), userCtxKey{}, &store.User{ID: "another-admin", Role: "admin"}))
	rec = httptest.NewRecorder()
	startBackupImportJobAdmin(d, rec, req)
	if rec.Code != 404 {
		t.Fatalf("another actor could start job: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	cancelBackupImportUploadAdmin(d, rec, backupJobRequest(http.MethodDelete, "/", nil, j.ID))
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if _, err := os.Stat(j.path); !os.IsNotExist(err) {
		t.Fatalf("cancel left partial upload: %v", err)
	}
	state := buildBackupExportState(d)
	encoded, _ := json.Marshal(state)
	if state.MaxImportBytes != 1024 || !bytes.Contains(encoded, []byte(`"max_import_bytes":1024`)) {
		t.Fatal("server upload limit was not exposed")
	}
}

func TestBackupImportJobRoutesRequireAdministrator(t *testing.T) {
	d := newBackupAdminFixture(t, false)
	router := NewRouter(d)
	for _, route := range []struct{ method, path string }{
		{"POST", "/api/admin/backup/import-jobs"},
		{"POST", "/api/admin/backup/import-jobs/test/chunks"},
		{"POST", "/api/admin/backup/import-jobs/test/start"},
		{"DELETE", "/api/admin/backup/import-jobs/test"},
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(route.method, route.path, nil))
		if rec.Code != 401 {
			t.Fatalf("%s %s returned %d", route.method, route.path, rec.Code)
		}
	}
}

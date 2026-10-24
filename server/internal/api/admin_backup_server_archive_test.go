package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"aivory/server/internal/config"
	"aivory/server/internal/store"
	"github.com/google/uuid"
)

func createServerBackupJobForTest(t *testing.T, d Deps, name string, data []byte) *backupImportJob {
	t.Helper()
	if err := os.WriteFile(filepath.Join(d.Config.BackupDir, name), data, 0o600); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	body, _ := json.Marshal(map[string]any{"id": id, "size_bytes": len(data), "archive_name": name, "confirm": "REPLACE"})
	rec := httptest.NewRecorder()
	createBackupImportJobAdmin(d, rec, backupJobRequest(http.MethodPost, "/", bytes.NewBuffer(body), id))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body)
	}
	j := adminBackupImports.lookup(id)
	t.Cleanup(func() {
		adminBackupImports.mu.Lock()
		delete(adminBackupImports.jobs, id)
		adminBackupImports.mu.Unlock()
		j.mu.Lock()
		j.cleanupInput()
		j.mu.Unlock()
	})
	return j
}

func TestBackupServerArchiveCatalogIncludesCopiedZIPsOnly(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"旧服务器备份.zip", "manual.ZIP", "upload.zip.part", ".hidden.zip", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("archive"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "directory.zip"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "manual.ZIP"), filepath.Join(dir, "link.zip")); err != nil {
		t.Fatal(err)
	}
	d := Deps{Config: config.Config{BackupDir: dir}}
	state := buildBackupExportState(d)
	if len(state.ServerArchives) != 2 || state.BackupDirectory != dir || len(state.Archives) != 0 {
		t.Fatalf("unexpected archive catalog: %+v", state)
	}
}

func TestBackupServerArchiveRejectsUnsafeNamesAndSymlinks(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.zip")
	if err := os.WriteFile(outside, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.zip")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../outside.zip", outside, `..\outside.zip`, ".hidden.zip", "upload.zip.part", "bad\nname.zip", "link.zip"} {
		file, _, status, err := openServerBackupArchive(dir, name)
		if file != nil || err == nil || status < 400 {
			t.Fatalf("unsafe archive accepted: %q status=%d err=%v", name, status, err)
		}
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "keep" {
		t.Fatal("outside archive changed")
	}
}

func TestBackupServerArchiveRestorePinsInputAndKeepsOriginal(t *testing.T) {
	d := newBackupAdminFixture(t, true)
	d.Config.BackupDir = t.TempDir()
	archive := manifestOnlyArchiveForTest(t, backupManifest{Format: "aivory-backup", Version: 1, Dialect: "sqlite", Counts: map[string]int64{}})
	j := createServerBackupJobForTest(t, d, "migration.zip", archive)
	if j.UploadedBytes != int64(len(archive)) || j.path != "" {
		t.Fatal("server import requires an upload or a copied temporary archive")
	}
	// A directory entry replaced after selection must not switch the archive
	// that the administrator already confirmed, or delete the replacement.
	original := filepath.Join(d.Config.BackupDir, "original.zip")
	if err := os.Rename(filepath.Join(d.Config.BackupDir, "migration.zip"), original); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(d.Config.BackupDir, "migration.zip")
	if err := os.WriteFile(replacement, []byte("different invalid archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	j.Status = "restoring"
	runBackupImportJob(d, j, store.User{ID: "adm", Role: "admin"}, nil)
	if j.Status != "completed" {
		t.Fatalf("restore failed: %s", j.Error)
	}
	assertOneRestoredAdmin(t, d.DB, "admin@example.test", "adm", "current-admin-hash")
	data, err := os.ReadFile(original)
	if err != nil || !bytes.Equal(data, archive) {
		t.Fatal("original server archive was removed or changed")
	}
	data, err = os.ReadFile(replacement)
	if err != nil || string(data) != "different invalid archive" {
		t.Fatal("replacement directory entry was removed or changed")
	}
	if j.archiveFile != nil {
		t.Fatal("server archive descriptor leaked after restore")
	}
}

func TestBackupServerArchiveCancellationAndExpiryKeepOriginal(t *testing.T) {
	for _, cancel := range []bool{true, false} {
		d := Deps{Config: config.Config{BackupDir: t.TempDir()}}
		j := createServerBackupJobForTest(t, d, "manual.zip", []byte("keep"))
		file := j.archiveFile
		if cancel {
			rec := httptest.NewRecorder()
			cancelBackupImportUploadAdmin(d, rec, backupJobRequest(http.MethodDelete, "/", nil, j.ID))
			if rec.Code != http.StatusOK {
				t.Fatal(rec.Body.String())
			}
		} else {
			j.lastActivity = time.Now().Add(-2 * backupImportJobTTL)
			adminBackupImports.expire(j.ID)
			if adminBackupImports.lookup(j.ID) != nil {
				t.Fatal("expired source retained")
			}
		}
		if _, err := file.Stat(); err == nil {
			t.Fatal("source file descriptor was not closed")
		}
		data, err := os.ReadFile(filepath.Join(d.Config.BackupDir, "manual.zip"))
		if err != nil || string(data) != "keep" {
			t.Fatal("cancellation/expiry deleted source archive")
		}
	}
}

func TestBackupServerArchiveFailurePreservesDataAndSource(t *testing.T) {
	for _, mutate := range []bool{false, true} {
		d := newBackupAdminFixture(t, false)
		d.Config.BackupDir = t.TempDir()
		mustExec(t, d.DB, `INSERT INTO settings(key,value) VALUES('site_title','"keep me"')`)
		j := createServerBackupJobForTest(t, d, "manual.zip", []byte("invalid ZIP"))
		if mutate {
			if err := os.WriteFile(filepath.Join(d.Config.BackupDir, "manual.zip"), []byte("still being copied"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		j.Status = "restoring"
		runBackupImportJob(d, j, store.User{ID: "adm", Role: "admin"}, nil)
		want := http.StatusBadRequest
		if mutate {
			want = http.StatusConflict
		}
		if j.Status != "failed" || j.HTTPStatus != want {
			t.Fatalf("bad source status=%s http=%d error=%s", j.Status, j.HTTPStatus, j.Error)
		}
		var title string
		if err := d.DB.QueryRow(`SELECT value FROM settings WHERE key='site_title'`).Scan(&title); err != nil || title != `"keep me"` {
			t.Fatal("failed restore changed existing data")
		}
		if _, err := os.Stat(filepath.Join(d.Config.BackupDir, "manual.zip")); err != nil {
			t.Fatal("failed restore removed source archive")
		}
	}
}

func TestBackupServerArchiveCreationIsIdempotentAndBindsSource(t *testing.T) {
	d := Deps{Config: config.Config{BackupDir: t.TempDir()}}
	j := createServerBackupJobForTest(t, d, "manual.zip", []byte("archive"))
	for _, name := range []string{"manual.zip", "other.zip", ""} {
		body, _ := json.Marshal(map[string]any{"id": j.ID, "size_bytes": 7, "archive_name": name, "confirm": "REPLACE"})
		rec := httptest.NewRecorder()
		createBackupImportJobAdmin(d, rec, backupJobRequest(http.MethodPost, "/", bytes.NewBuffer(body), j.ID))
		want := http.StatusConflict
		if name == "manual.zip" {
			want = http.StatusOK
		}
		if rec.Code != want {
			t.Fatalf("name=%q status=%d body=%s", name, rec.Code, rec.Body)
		}
	}
}

func TestBackupServerArchiveRejectsSourceInsideRestoredFiles(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "backups")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manual.zip"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	d := Deps{Config: config.Config{BackupDir: dir, UploadDir: root}}
	body, _ := json.Marshal(map[string]any{"id": uuid.NewString(), "size_bytes": 4, "archive_name": "manual.zip", "confirm": "REPLACE"})
	rec := httptest.NewRecorder()
	createBackupImportJobAdmin(d, rec, backupJobRequest(http.MethodPost, "/", bytes.NewBuffer(body), ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("archive inside replaced storage accepted: status=%d body=%s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(dir, "manual.zip")); err != nil {
		t.Fatal("rejected source was removed")
	}
}

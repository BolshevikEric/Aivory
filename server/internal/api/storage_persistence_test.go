package api

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"aivory/server/internal/cache"
	"aivory/server/internal/config"
	"aivory/server/internal/fileguard"
	"aivory/server/internal/store"
	"github.com/mattn/go-sqlite3"
)

// Commit the real SQLite transaction, then lose its acknowledgement, as can
// happen when a PostgreSQL connection drops after the server commits.
type lostStorageCommitDriver struct {
	armed, committed  *atomic.Bool
	readFailure       bool
	crashBeforeCommit bool
}
type lostStorageCommitConn struct {
	driver.Conn
	fault *lostStorageCommitDriver
}
type lostStorageCommitTx struct {
	driver.Tx
	fault *lostStorageCommitDriver
}

func (d *lostStorageCommitDriver) Open(name string) (driver.Conn, error) {
	c, err := (&sqlite3.SQLiteDriver{}).Open(name)
	if err != nil {
		return nil, err
	}
	return &lostStorageCommitConn{Conn: c, fault: d}, nil
}
func (c *lostStorageCommitConn) Prepare(query string) (driver.Stmt, error) {
	if c.fault.readFailure && c.fault.committed.Load() {
		return nil, io.ErrUnexpectedEOF
	}
	return c.Conn.Prepare(query)
}
func (c *lostStorageCommitConn) Begin() (driver.Tx, error) {
	tx, err := c.Conn.Begin()
	if err != nil {
		return nil, err
	}
	return &lostStorageCommitTx{Tx: tx, fault: c.fault}, nil
}
func (tx *lostStorageCommitTx) Commit() error {
	if tx.fault.crashBeforeCommit && tx.fault.armed.Load() {
		os.Exit(0) // subprocess only: terminate after publish, before DB commit
	}
	if err := tx.Tx.Commit(); err != nil {
		return err
	}
	if tx.fault.armed.Swap(false) {
		tx.fault.committed.Store(true)
		return io.ErrUnexpectedEOF
	}
	return nil
}

func faultingStorageDB(t *testing.T, original *sql.DB, readFailure bool) (*sql.DB, *lostStorageCommitDriver) {
	t.Helper()
	var seq int
	var name, path string
	if err := original.QueryRow(`PRAGMA database_list`).Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	fault := &lostStorageCommitDriver{armed: &atomic.Bool{}, committed: &atomic.Bool{}, readFailure: readFailure}
	driverName := "lost-storage-commit-" + store.GenID("test")
	sql.Register(driverName, fault)
	db, err := sql.Open(driverName, path+"?_foreign_keys=on&_busy_timeout=5000")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db, fault
}

func persistedUploadRequest(t *testing.T, kind string) *http.Request {
	t.Helper()
	var req *http.Request
	if kind == "json document" {
		req = httptest.NewRequest(http.MethodPost, "/api/conversations/c_persist/documents", strings.NewReader(`{"filename":"report.txt","content":"durable report","mime_type":"text/plain"}`))
		req.Header.Set("Content-Type", "application/json")
	} else {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("file", "report.txt")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(part, "durable report")
		_ = writer.Close()
		req = httptest.NewRequest(http.MethodPost, "/api/files", &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
	}
	return req.WithContext(context.WithValue(req.Context(), userCtxKey{}, &store.User{ID: "adm", Role: "admin", Status: "active"}))
}

func TestUploadLostCommitAcknowledgementRetainsBytes(t *testing.T) {
	for _, kind := range []string{"file", "json document", "multipart document"} {
		for _, readFailure := range []bool{false, true} {
			name := kind + " reconciled"
			if readFailure {
				name = kind + " verification unavailable"
			}
			t.Run(name, func(t *testing.T) {
				d := storageBackupFixture(t)
				d.Cache = cache.NewMemory()
				d.Config.MaxUploadBytes = 1024 * 1024
				mustExec(t, d.DB, `INSERT INTO conversations(id,user_id,title) VALUES('c_persist','adm','Persistence')`)
				original := d.DB
				var fault *lostStorageCommitDriver
				d.DB, fault = faultingStorageDB(t, original, readFailure)
				fault.armed.Store(true)
				req := persistedUploadRequest(t, kind)
				if kind == "file" {
					rec := httptest.NewRecorder()
					uploadFileHandler(d, rec, req)
					want := http.StatusCreated
					if readFailure {
						want = http.StatusInternalServerError
					}
					if rec.Code != want {
						t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
					}
				} else {
					doc, err := receiveDocument(d, req, "", "c_persist")
					if readFailure {
						if !errors.Is(err, store.ErrStoragePersistenceUncertain) {
							t.Fatalf("doc=%v err=%v", doc, err)
						}
					} else if err != nil || doc == nil {
						t.Fatalf("doc=%v err=%v", doc, err)
					}
				}
				table := "documents"
				if kind == "file" {
					table = "files"
				}
				var path string
				if err := original.QueryRow("SELECT storage_path FROM " + table + " WHERE filename='report.txt'").Scan(&path); err != nil {
					t.Fatal(err)
				}
				data, err := os.ReadFile(path)
				if err != nil || string(data) != "durable report" {
					t.Fatalf("committed upload lost: bytes=%q err=%v", data, err)
				}
			})
		}
	}
}

func TestCleanupWaitsForWriterAndRechecksReferences(t *testing.T) {
	d := storageBackupFixture(t)
	path := filepath.Join(d.Config.UploadDir, "shared.txt")
	writeFile(t, path, []byte("keep shared bytes"))
	mustExec(t, d.DB, `INSERT INTO conversations(id,user_id,title) VALUES('c_binding','adm','Binding')`)
	unlock, err := fileguard.LockStorage(t.Context(), false, d.Config.UploadDir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithTimeout(t.Context(), 75*time.Millisecond)
	defer cancel()
	if _, err := cleanupOneStoragePath(ctx, d, nil, path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cleanup did not wait for writer: %v", err)
	}
	if _, err := store.CreateDocumentForUser(t.Context(), d.DB, store.Document{ConversationID: "c_binding", Filename: "shared.txt", StoragePath: path}, "adm"); err != nil {
		t.Fatal(err)
	}
	unlock()
	referenced, err := cleanupOneStoragePath(t.Context(), d, nil, path)
	if err != nil || !referenced {
		t.Fatalf("cleanup missed committed reference: %t %v", referenced, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "keep shared bytes" {
		t.Fatalf("shared file deleted: %q %v", data, err)
	}
}

func TestBackupRestoreLostCommitAcknowledgement(t *testing.T) {
	for _, readFailure := range []bool{false, true} {
		name := "reconciled"
		if readFailure {
			name = "verification unavailable"
		}
		t.Run(name, func(t *testing.T) {
			src := storageBackupFixture(t)
			writeFile(t, filepath.Join(src.Config.UploadDir, "restored.txt"), []byte("new backup bytes"))
			mustExec(t, src.DB, `INSERT INTO files(id,user_id,filename,storage_path) VALUES('f_restore','adm','restored.txt',?)`, filepath.Join(src.Config.UploadDir, "restored.txt"))
			rec := httptest.NewRecorder()
			exportBackupAdmin(src, rec, httptest.NewRequest(http.MethodGet, "/api/admin/backup/export?files=1", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
			}
			d := storageBackupFixture(t)
			writeFile(t, filepath.Join(d.Config.UploadDir, "original.txt"), []byte("original bytes"))
			original := d.DB
			var fault *lostStorageCommitDriver
			d.DB, fault = faultingStorageDB(t, original, readFailure)
			fault.armed.Store(true)
			imported := importBackupForCompatibilityTest(t, d, rec.Body.Bytes())
			if readFailure {
				if imported.Code != http.StatusInternalServerError || !strings.Contains(imported.Body.String(), "retained") {
					t.Fatalf("import: %d %s", imported.Code, imported.Body.String())
				}
			} else if imported.Code != http.StatusOK {
				t.Fatalf("import: %d %s", imported.Code, imported.Body.String())
			}
			var path string
			if err := original.QueryRow(`SELECT storage_path FROM files WHERE id='f_restore'`).Scan(&path); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != "new backup bytes" {
				t.Fatalf("restored DB references lost file: %q %v", data, err)
			}
			unlock, lockErr := fileguard.LockStorage(t.Context(), false, d.Config.UploadDir, d.Config.ArtifactDir)
			if readFailure {
				if !errors.Is(lockErr, fileguard.ErrStorageRecoveryRequired) {
					if unlock != nil {
						unlock()
					}
					t.Fatalf("uncertain restore allowed mutation: %v", lockErr)
				}
				dirs, err := filepath.Glob(filepath.Join(filepath.Dir(d.Config.UploadDir), ".aivory-restore-previous-*"))
				if err != nil {
					t.Fatal(err)
				}
				retained := false
				for _, dir := range dirs {
					if b, e := os.ReadFile(filepath.Join(dir, "original.txt")); e == nil && string(b) == "original bytes" {
						retained = true
					}
				}
				if !retained {
					t.Fatal("original rollback bytes were discarded on uncertain commit")
				}
			} else {
				if lockErr != nil {
					t.Fatal(lockErr)
				}
				unlock()
			}
		})
	}
}

func TestBackupRestoreStopsArchivedGenerations(t *testing.T) {
	d := storageBackupFixture(t)
	mustExec(t, d.DB, `INSERT INTO conversations(id,user_id,title,active_leaf_id) VALUES('c_stream','adm','Keep conversation','m_stream')`)
	blocks := `[{"kind":"text","text":"Retain partial answer"}]`
	mustExec(t, d.DB, `INSERT INTO messages(id,conversation_id,role,author_id,status,blocks) VALUES('m_stream','c_stream','assistant','adm','streaming',?)`, blocks)
	mustExec(t, d.DB, `INSERT INTO conversation_generation_leases(conversation_id,branch_key,principal_id,owner_token,expires_at) VALUES('c_stream','root:','adm','old-worker',9999999999)`)
	mustExec(t, d.DB, `INSERT INTO conversation_compaction_leases(conversation_id,owner_token,expires_at) VALUES('c_stream','old-compactor',9999999999)`)
	rec := httptest.NewRecorder()
	exportBackupAdmin(d, rec, httptest.NewRequest(http.MethodGet, "/api/admin/backup/export?files=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	target := storageBackupFixture(t)
	imported := importBackupForCompatibilityTest(t, target, rec.Body.Bytes())
	if imported.Code != http.StatusOK {
		t.Fatalf("import: %d %s", imported.Code, imported.Body.String())
	}
	var status, restoredBlocks, leaf string
	if err := target.DB.QueryRow(`SELECT status,blocks FROM messages WHERE id='m_stream'`).Scan(&status, &restoredBlocks); err != nil {
		t.Fatal(err)
	}
	_ = target.DB.QueryRow(`SELECT active_leaf_id FROM conversations WHERE id='c_stream'`).Scan(&leaf)
	if status != "error" || restoredBlocks != blocks || leaf != "m_stream" {
		t.Fatalf("restored message damaged: %s %s %s", status, restoredBlocks, leaf)
	}
	for _, table := range []string{"conversation_generation_leases", "conversation_compaction_leases"} {
		var n int
		if err := target.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("stale leases in %s: %d %v", table, n, err)
		}
	}
	_, err := store.CreateArtifactForUser(t.Context(), target.DB, store.Artifact{MessageID: "m_stream", Filename: "stale.txt", StoragePath: filepath.Join(target.Config.ArtifactDir, "stale.txt")}, "c_stream", "adm")
	if !errors.Is(err, store.ErrConversationAccessRevoked) {
		t.Fatalf("old artifact writer survived restore: %v", err)
	}
	err = store.FinishMessageForUser(t.Context(), target.DB, "m_stream", "c_stream", "adm", store.MessageFinishPatch{Blocks: []byte(`[{"kind":"text","text":"stale final answer"}]`), Status: "complete"})
	if !errors.Is(err, store.ErrConversationAccessRevoked) {
		t.Fatalf("old finalizer survived restore: %v", err)
	}
	// A new request can claim this branch immediately, despite a long archived TTL.
	lease, _, ok, err := store.TryAcquireConversationGenerationLease(t.Context(), target.DB, "c_stream", "m_stream", "adm", "new-worker", time.Minute)
	if err != nil || !ok || lease == nil {
		t.Fatalf("restored conversation stuck: %v %t %v", lease, ok, err)
	}
}

func TestBackupRestoreCrashKeepsRecoveryJournal(t *testing.T) {
	const childRoot = "AIVORY_TEST_RESTORE_CRASH_ROOT"
	if root := os.Getenv(childRoot); root != "" {
		db, err := sql.Open("sqlite3", filepath.Join(root, "restore.db")+"?_foreign_keys=on&_busy_timeout=5000")
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		faultDB, fault := faultingStorageDB(t, db, false)
		fault.crashBeforeCommit = true
		fault.armed.Store(true)
		d := Deps{DB: faultDB, Config: config.Config{UploadDir: filepath.Join(root, "uploads"), ArtifactDir: filepath.Join(root, "artifacts")}, Logger: log.New(io.Discard, "", 0)}
		archive, err := os.ReadFile(filepath.Join(root, "source.zip"))
		if err != nil {
			t.Fatal(err)
		}
		rec := importBackupForCompatibilityTest(t, d, archive)
		t.Fatalf("restore never reached the crash point: %d %s", rec.Code, rec.Body.String())
	}
	src := storageBackupFixture(t)
	writeFile(t, filepath.Join(src.Config.UploadDir, "new.txt"), []byte("new version"))
	mustExec(t, src.DB, `INSERT INTO files(id,user_id,filename,storage_path) VALUES('f_new','adm','new.txt',?)`, filepath.Join(src.Config.UploadDir, "new.txt"))
	rec := httptest.NewRecorder()
	exportBackupAdmin(src, rec, httptest.NewRequest(http.MethodGet, "/api/admin/backup/export?files=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	d := storageBackupFixture(t)
	root := filepath.Dir(d.Config.UploadDir)
	oldPath := filepath.Join(d.Config.UploadDir, "old.txt")
	writeFile(t, oldPath, []byte("old version"))
	mustExec(t, d.DB, `INSERT INTO files(id,user_id,filename,storage_path) VALUES('f_old','adm','old.txt',?)`, oldPath)
	writeFile(t, filepath.Join(root, "source.zip"), rec.Body.Bytes())
	cmd := exec.Command(os.Args[0], "-test.run=^TestBackupRestoreCrashKeepsRecoveryJournal$")
	cmd.Env = append(os.Environ(), childRoot+"="+root)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("crash child: %v %s", err, output)
	}
	var n int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM files WHERE id='f_old'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("crash did not roll back DB: %d %v", n, err)
	}
	if data, err := os.ReadFile(filepath.Join(d.Config.UploadDir, "new.txt")); err != nil || string(data) != "new version" {
		t.Fatalf("restore did not publish before crash: %q %v", data, err)
	}
	dirs, err := filepath.Glob(filepath.Join(root, ".aivory-restore-previous-*"))
	if err != nil {
		t.Fatal(err)
	}
	retained := false
	for _, dir := range dirs {
		if data, err := os.ReadFile(filepath.Join(dir, "old.txt")); err == nil && string(data) == "old version" {
			retained = true
		}
	}
	if !retained {
		t.Fatal("crash discarded original bytes")
	}
	if snapshot, err := prepareBackupExport(t.Context(), d, true); !errors.Is(err, fileguard.ErrStorageRecoveryRequired) {
		if snapshot != nil {
			snapshot.release()
		}
		t.Fatalf("post-crash export could prune old metadata: %v", err)
	}
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM files WHERE id='f_old'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("post-crash auto repair deleted live record: %d %v", n, err)
	}
}

func TestBackupTreeRollbackCanRetryFailedRename(t *testing.T) {
	target := filepath.Join(t.TempDir(), "uploads")
	writeFile(t, filepath.Join(target, "old.txt"), []byte("old"))
	tree, err := newStagedBackupTree(target)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(tree.stage, "new.txt"), []byte("new"))
	if err := tree.apply(); err != nil {
		t.Fatal(err)
	}
	// Rename is temporarily impossible after removing the published tree.
	if err := os.RemoveAll(target); err != nil {
		t.Fatal(err)
	}
	obstructed := filepath.Join(t.TempDir(), "absent-parent", "uploads")
	tree.target = obstructed
	if err := tree.rollback(); err == nil {
		t.Fatal("expected rollback rename error")
	}
	if data, err := os.ReadFile(filepath.Join(tree.previous, "old.txt")); err != nil || string(data) != "old" {
		t.Fatalf("rollback error lost original: %q %v", data, err)
	}
	tree.target = target
	if err := tree.rollback(); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(target, "old.txt")); err != nil || string(data) != "old" {
		t.Fatalf("rollback could not retry: %q %v", data, err)
	}
}

func TestSkillSaveRejectsMissingAssetWithoutDamagingExistingSkill(t *testing.T) {
	d := storageBackupFixture(t)
	assetPath := filepath.Join(d.Config.UploadDir, skillAssetsSubdir, "template.txt")
	payload := map[string]any{"name": "Templates", "description": "Keep description", "instructions": "Keep instructions", "assets": []map[string]any{{"filename": "template.txt", "storage_path": assetPath, "mime_type": "text/plain", "size_bytes": 4}}}
	body, _ := json.Marshal(payload)
	rec := httptest.NewRecorder()
	createSkillAdmin(d, rec, httptest.NewRequest(http.MethodPost, "/api/admin/skills", bytes.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("accepted missing source: %d %s", rec.Code, rec.Body.String())
	}
	writeFile(t, assetPath, []byte("keep"))
	rec = httptest.NewRecorder()
	createSkillAdmin(d, rec, httptest.NewRequest(http.MethodPost, "/api/admin/skills", bytes.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("valid asset: %d %s", rec.Code, rec.Body.String())
	}
	var skill store.Skill
	if err := json.Unmarshal(rec.Body.Bytes(), &skill); err != nil {
		t.Fatal(err)
	}
	missingPath := filepath.Join(d.Config.UploadDir, skillAssetsSubdir, "missing.txt")
	body, _ = json.Marshal(map[string]any{"assets": []map[string]any{{"filename": "missing.txt", "storage_path": missingPath}}})
	req := httptest.NewRequest(http.MethodPut, "/api/admin/skills/"+skill.ID, bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), pathCtxKey{}, map[string]string{"id": skill.ID}))
	rec = httptest.NewRecorder()
	updateSkillAdmin(d, rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("accepted missing replacement: %d %s", rec.Code, rec.Body.String())
	}
	saved, err := store.GetSkill(t.Context(), d.DB, skill.ID)
	if err != nil || saved.Instructions != "Keep instructions" || !strings.Contains(string(saved.Assets), assetPath) || strings.Contains(string(saved.Assets), "missing.txt") {
		t.Fatalf("damaged existing skill: %v %v", saved, err)
	}
}

func TestBackupRestoreUncertainCommitRetainsQdrantCompensation(t *testing.T) {
	src := storageBackupFixture(t)
	rec := httptest.NewRecorder()
	exportBackupAdmin(src, rec, httptest.NewRequest(http.MethodGet, "/api/admin/backup/export?files=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	d := storageBackupFixture(t)
	qdrant := newFakeQdrant(t)
	qdrant.setPoints("aivory_c2", []qdrantDumpPoint{{ID: json.RawMessage(`"old-point"`), Vector: json.RawMessage(`[1,0]`), Payload: json.RawMessage(`{"document_id":"old-doc"}`)}})
	d.Config.QdrantURL = qdrant.url
	var fault *lostStorageCommitDriver
	d.DB, fault = faultingStorageDB(t, d.DB, true)
	fault.armed.Store(true)
	imported := importBackupForCompatibilityTest(t, d, rec.Body.Bytes())
	if imported.Code != http.StatusInternalServerError || !strings.Contains(imported.Body.String(), "backup_restore_recovery_required") {
		t.Fatalf("import: %d %s", imported.Code, imported.Body.String())
	}
	if len(qdrant.pointsFor("aivory_c2")) != 0 {
		t.Fatal("uncertain commit incorrectly rolled Qdrant back against restored rows")
	}
	archives, err := filepath.Glob(filepath.Join(filepath.Dir(d.Config.UploadDir), ".aivory-qdrant-rollback-*.zip"))
	if err != nil || len(archives) != 1 {
		t.Fatalf("persistent compensation archive missing: %v %v", archives, err)
	}
	retained, err := zip.OpenReader(archives[0])
	if err != nil {
		t.Fatal(err)
	}
	defer retained.Close()
	entry := findZipFile(&retained.Reader, "qdrant/collections/aivory_c2.jsonl")
	if entry == nil {
		t.Fatal("original Qdrant collection missing from compensation archive")
	}
	reader, err := entry.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil || !bytes.Contains(data, []byte("old-point")) {
		t.Fatalf("original vector lost: %s %v", data, err)
	}
}

func TestLateGenerationCannotRestoreRepairedFileReferences(t *testing.T) {
	d := storageBackupFixture(t)
	mustExec(t, d.DB, `INSERT INTO conversations(id,user_id,title) VALUES('c_late','adm','Keep conversation')`)
	blocks := `[{"kind":"text","text":"Keep final answer and [report](/api/artifacts/art_gone). API documentation example: /api/files/example_id"},{"kind":"artifact","file_ref":"art_gone","title":"missing.txt","url":"/api/artifacts/art_gone"},{"kind":"artifact","file_ref":"art_kept","title":"kept.txt","url":"/api/artifacts/art_kept"}]`
	mustExec(t, d.DB, `INSERT INTO messages(id,conversation_id,role,author_id,status,blocks) VALUES('m_late','c_late','assistant','adm','streaming',?)`, blocks)
	writeFile(t, filepath.Join(d.Config.ArtifactDir, "kept.txt"), []byte("kept"))
	mustExec(t, d.DB, `INSERT INTO artifacts(id,message_id,filename,storage_path) VALUES('art_gone','m_late','missing.txt',?),('art_kept','m_late','kept.txt',?)`, filepath.Join(d.Config.ArtifactDir, "missing.txt"), filepath.Join(d.Config.ArtifactDir, "kept.txt"))
	snapshot, err := prepareBackupExport(t.Context(), d, true)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.release()
	// The provider still has the original blocks and native response in memory.
	err = store.FinishMessageForUser(t.Context(), d.DB, "m_late", "c_late", "adm", store.MessageFinishPatch{Blocks: json.RawMessage(blocks), Raw: json.RawMessage(`{"stale":"art_gone"}`), Citations: json.RawMessage(`[]`), Status: "complete"})
	if err != nil {
		t.Fatal(err)
	}
	var finalBlocks, status string
	var raw sql.NullString
	if err := d.DB.QueryRow(`SELECT blocks,raw,status FROM messages WHERE id='m_late'`).Scan(&finalBlocks, &raw, &status); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(finalBlocks, "art_gone") || !strings.Contains(finalBlocks, "art_kept") || !strings.Contains(finalBlocks, "Keep final answer") || !strings.Contains(finalBlocks, "/api/files/example_id") || status != "complete" || raw.String != "" {
		t.Fatalf("late output undid repair: %s %s %v", finalBlocks, status, raw)
	}
}

func TestBackupRestoreFailedQdrantRollbackKeepsRecoveryArchive(t *testing.T) {
	src := storageBackupFixture(t)
	sourceQdrant := newFakeQdrant(t)
	sourceQdrant.setPoints("aivory_c2", []qdrantDumpPoint{{ID: json.RawMessage(`"new-point"`), Vector: json.RawMessage(`[0,1]`), Payload: json.RawMessage(`{}`)}})
	src.Config.QdrantURL = sourceQdrant.url
	rec := httptest.NewRecorder()
	exportBackupAdmin(src, rec, httptest.NewRequest(http.MethodGet, "/api/admin/backup/export?files=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	d := storageBackupFixture(t)
	oldPath := filepath.Join(d.Config.UploadDir, "old.txt")
	writeFile(t, oldPath, []byte("keep old file"))
	mustExec(t, d.DB, `INSERT INTO files(id,user_id,filename,storage_path) VALUES('f_old','adm','old.txt',?)`, oldPath)
	oldQdrant := newFakeQdrant(t)
	oldQdrant.setPoints("aivory_c2", []qdrantDumpPoint{{ID: json.RawMessage(`"original-point"`), Vector: json.RawMessage(`[1,0]`), Payload: json.RawMessage(`{}`)}})
	unavailable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/points") {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "persistent point write failure"})
			return
		}
		oldQdrant.serveHTTP(w, r)
	}))
	defer unavailable.Close()
	d.Config.QdrantURL = unavailable.URL
	imported := importBackupForCompatibilityTest(t, d, rec.Body.Bytes())
	if imported.Code != http.StatusInternalServerError {
		t.Fatalf("import: %d %s", imported.Code, imported.Body.String())
	}
	if data, err := os.ReadFile(oldPath); err != nil || string(data) != "keep old file" {
		t.Fatalf("file compensation damaged original: %q %v", data, err)
	}
	var n int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM files WHERE id='f_old'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("DB was not rolled back: %d %v", n, err)
	}
	archives, err := filepath.Glob(filepath.Join(filepath.Dir(d.Config.UploadDir), ".aivory-qdrant-rollback-*.zip"))
	if err != nil || len(archives) != 1 {
		t.Fatalf("deferred cleanup destroyed recovery archive: %v %v", archives, err)
	}
	if unlock, err := fileguard.LockStorage(t.Context(), false, d.Config.UploadDir); !errors.Is(err, fileguard.ErrStorageRecoveryRequired) {
		if unlock != nil {
			unlock()
		}
		t.Fatalf("failed compensation did not preserve recovery state: %v", err)
	}
}

package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aivory/server/internal/fileguard"
	"aivory/server/internal/store"
)

func storageBackupFixture(t *testing.T) Deps {
	t.Helper()
	d := newBackupAdminFixture(t, false)
	for _, dir := range []string{d.Config.UploadDir, d.Config.ArtifactDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return d
}

func validStorageBackup(t *testing.T, data []byte) *zip.Reader {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	f := findZipFile(zr, "manifest.json")
	if f == nil {
		t.Fatal("export did not finish its manifest")
	}
	r, err := f.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	var man backupManifest
	if err := json.NewDecoder(r).Decode(&man); err != nil {
		t.Fatal(err)
	}
	if err := validateBackupArchive(zr, man); err != nil {
		t.Fatalf("exported an incomplete backup: %v", err)
	}
	return zr
}

func TestBackupExportRepairsMissingFilesAndPreservesConversation(t *testing.T) {
	d := storageBackupFixture(t)
	validPath := filepath.Join(d.Config.ArtifactDir, "valid.txt")
	writeFile(t, validPath, []byte("valid artifact"))
	missingArtifact := filepath.Join(d.Config.ArtifactDir, "missing.txt")
	missingUpload := filepath.Join(d.Config.UploadDir, "missing.pdf")
	mustExec(t, d.DB, `INSERT INTO conversations(id,user_id,title) VALUES('c_repair','adm','Keep this conversation')`)
	mustExec(t, d.DB, `INSERT INTO messages(id,conversation_id,role,blocks,attachments) VALUES('m_user','c_repair','user','[{"kind":"text","text":"Please read my file"}]','[{"id":"f_missing","document_id":"d_missing","filename":"missing.pdf","url":"/api/files/f_missing","kind":"pdf"}]')`)
	blocks := `[
		{"kind":"thinking","text":"Retain reasoning","thinking_ms":42},
		{"kind":"tool_call","tool_id":"call_1","tool_name":"python_execute","input":{"code":"print(1)"}},
		{"kind":"tool_output","tool_id":"call_1","text":"1"},
		{"kind":"text","text":"Here is [the report](/api/artifacts/art_missing). Keep this answer."},
		{"kind":"artifact","file_ref":"art_missing","title":"missing.txt","url":"/api/artifacts/art_missing","artifacts":[{"id":"art_missing","filename":"missing.txt","url":"/api/artifacts/art_missing"}]},
		{"kind":"artifact","file_ref":"art_valid","title":"valid.txt","url":"/api/artifacts/art_valid"}
	]`
	mustExec(t, d.DB, `INSERT INTO messages(id,conversation_id,parent_id,role,blocks,raw,citations,status) VALUES('m_reply','c_repair','m_user','assistant',?,'old provider cache','[{"index":1,"title":"Quoted text","url":"doc://d_missing","snippet":"Keep this quotation"}]','complete')`, blocks)
	mustExec(t, d.DB, `UPDATE conversations SET active_leaf_id='m_reply',summary_blocks='[{"level":1,"text":"Keep summary","tokens":3,"anchor_message_id":"m_reply","media":[{"kind":"artifact","id":"art_missing"},{"kind":"attachment","id":"f_missing"},{"kind":"artifact","id":"art_valid"}]}]' WHERE id='c_repair'`)
	mustExec(t, d.DB, `INSERT INTO artifacts(id,message_id,filename,storage_path) VALUES('art_missing','m_reply','missing.txt',?),('art_valid','m_reply','valid.txt',?)`, missingArtifact, validPath)
	mustExec(t, d.DB, `INSERT INTO files(id,user_id,conversation_id,filename,storage_path) VALUES('f_missing','adm','c_repair','missing.pdf',?)`, missingUpload)
	mustExec(t, d.DB, `INSERT INTO documents(id,conversation_id,filename,mime_type,size_bytes,storage_path) VALUES('d_missing','c_repair','missing.pdf','application/pdf',10,?)`, missingUpload)
	mustExec(t, d.DB, `INSERT INTO chunks(id,document_id,seq,content) VALUES('chunk_missing','d_missing',0,'old extracted text')`)
	snapshot, _ := json.Marshal([]map[string]any{{"role": "assistant", "blocks": json.RawMessage(blocks)}})
	mustExec(t, d.DB, `INSERT INTO conversation_shares(id,conversation_id,user_id,snapshot) VALUES('share_repair','c_repair','adm',?)`, string(snapshot))
	assets, _ := json.Marshal([]map[string]string{{"filename": "missing.csv", "storage_path": filepath.Join(d.Config.UploadDir, "skill-assets", "missing.csv")}})
	mustExec(t, d.DB, `INSERT INTO skills(id,name,description,instructions,assets) VALUES('skill_repair','Skill','Keep description','Keep instructions',?)`, string(assets))

	rec := httptest.NewRecorder()
	exportBackupAdmin(d, rec, httptest.NewRequest(http.MethodGet, "/api/admin/backup/export?files=1&qdrant=false", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	validStorageBackup(t, rec.Body.Bytes())
	for _, query := range []string{
		`SELECT COUNT(*) FROM artifacts WHERE id='art_missing'`, `SELECT COUNT(*) FROM files WHERE id='f_missing'`,
		`SELECT COUNT(*) FROM documents WHERE id='d_missing'`, `SELECT COUNT(*) FROM chunks WHERE id='chunk_missing'`,
	} {
		var count int
		if err := d.DB.QueryRow(query).Scan(&count); err != nil || count != 0 {
			t.Fatalf("query=%s count=%d err=%v", query, count, err)
		}
	}
	var pending int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM pending_vector_cleanup WHERE document_id='d_missing'`).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("vector cleanup was not queued: count=%d err=%v", pending, err)
	}
	var repaired, parent, status, raw, attachments, summary, shared, citations, leaf, skillAssets string
	if err := d.DB.QueryRow(`SELECT blocks,parent_id,status,raw,citations FROM messages WHERE id='m_reply'`).Scan(&repaired, &parent, &status, &raw, &citations); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(repaired, "art_missing") || !strings.Contains(repaired, "art_valid") || !strings.Contains(repaired, "Keep this answer") || !strings.Contains(repaired, "Retain reasoning") || !strings.Contains(repaired, "call_1") || !strings.Contains(repaired, "Here is the report.") || parent != "m_user" || status != "complete" || raw != "" {
		t.Fatalf("conversation damaged: parent=%s status=%s raw=%s blocks=%s", parent, status, raw, repaired)
	}
	if strings.Contains(citations, "doc://d_missing") || !strings.Contains(citations, "Keep this quotation") {
		t.Fatalf("citation repair lost text or retained a dead URL: %s", citations)
	}
	_ = d.DB.QueryRow(`SELECT attachments FROM messages WHERE id='m_user'`).Scan(&attachments)
	if !strings.Contains(attachments, `"deleted":true`) || strings.Contains(attachments, "document_id") || strings.Contains(attachments, "/api/files/") || !strings.Contains(attachments, "missing.pdf") {
		t.Fatalf("invalid attachment tombstone: %s", attachments)
	}
	_ = d.DB.QueryRow(`SELECT summary_blocks,active_leaf_id FROM conversations WHERE id='c_repair'`).Scan(&summary, &leaf)
	_ = d.DB.QueryRow(`SELECT snapshot FROM conversation_shares WHERE id='share_repair'`).Scan(&shared)
	_ = d.DB.QueryRow(`SELECT assets FROM skills WHERE id='skill_repair'`).Scan(&skillAssets)
	if strings.Contains(summary, "art_missing") || strings.Contains(summary, "f_missing") || !strings.Contains(summary, "Keep summary") || !strings.Contains(summary, "art_valid") || strings.Contains(shared, "art_missing") || leaf != "m_reply" || skillAssets != "[]" {
		t.Fatalf("summary=%s share=%s leaf=%s assets=%s", summary, shared, leaf, skillAssets)
	}
	// Exercise the actual importer, including path remapping and FK checks.
	target := storageBackupFixture(t)
	imported := importBackupForCompatibilityTest(t, target, rec.Body.Bytes())
	if imported.Code != http.StatusOK {
		t.Fatalf("round trip: %d %s", imported.Code, imported.Body.String())
	}
	var path, restoredBlocks string
	if err := target.DB.QueryRow(`SELECT storage_path FROM artifacts WHERE id='art_valid'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "valid artifact" {
		t.Fatalf("healthy artifact lost in round trip: %q %v", data, err)
	}
	if err := target.DB.QueryRow(`SELECT blocks FROM messages WHERE id='m_reply' AND parent_id='m_user'`).Scan(&restoredBlocks); err != nil || restoredBlocks != repaired {
		t.Fatalf("restored conversation differs: %s %v", restoredBlocks, err)
	}
}

func TestBackupSnapshotSurvivesPhysicalDeletion(t *testing.T) {
	d := storageBackupFixture(t)
	mustExec(t, d.DB, `PRAGMA journal_mode=WAL`)
	d.DB.SetMaxOpenConns(2)
	mustExec(t, d.DB, `INSERT INTO conversations(id,user_id,title) VALUES('c_backup','adm','Backup')`)
	mustExec(t, d.DB, `INSERT INTO messages(id,conversation_id,role) VALUES('m_backup','c_backup','assistant')`)
	path := filepath.Join(d.Config.ArtifactDir, "snapshot.txt")
	writeFile(t, path, []byte("required by snapshot"))
	mustExec(t, d.DB, `INSERT INTO artifacts(id,message_id,filename,storage_path) VALUES('art_backup','m_backup','snapshot.txt',?)`, path)
	snapshot, err := prepareBackupExport(t.Context(), d, true)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.release()
	var snapshotCount int
	if err := snapshot.tx.QueryRow(`SELECT COUNT(*) FROM artifacts`).Scan(&snapshotCount); err != nil || snapshotCount != 1 {
		t.Fatal(snapshotCount, err)
	}
	mustExec(t, d.DB, `DELETE FROM artifacts WHERE id='art_backup'`)
	if referenced, err := cleanupOneStoragePath(t.Context(), d, nil, path); err != nil || referenced {
		t.Fatalf("normal cleanup was blocked by backup: referenced=%v err=%v", referenced, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("physical deletion did not resume: %v", err)
	}
	var archive bytes.Buffer
	if _, err := writeBackupArchive(t.Context(), d, snapshot.tx, &archive, backupArchiveOptions{
		IncludeFiles: true, UploadDir: snapshot.uploadDir, ArtifactDir: snapshot.artifactDir,
	}); err != nil {
		t.Fatal(err)
	}
	zr := validStorageBackup(t, archive.Bytes())
	if findZipFile(zr, backupZipArtifacts+"snapshot.txt") == nil {
		t.Fatal("snapshot lost its referenced file")
	}
}

func TestBackupImportWaitsForFileWriter(t *testing.T) {
	d := storageBackupFixture(t)
	rec := httptest.NewRecorder()
	exportBackupAdmin(d, rec, httptest.NewRequest(http.MethodGet, "/api/admin/backup/export?files=1&qdrant=false", nil))
	validStorageBackup(t, rec.Body.Bytes())
	unlock, err := fileguard.LockStorage(t.Context(), false, d.Config.ArtifactDir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	path := filepath.Join(d.Config.ArtifactDir, "in-flight.txt")
	writeFile(t, path, []byte("writer has not persisted metadata yet"))
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	// Reuse the multipart importer helper's request format with a deadline.
	body, contentType := multipartArchive(t, rec.Body.Bytes())
	request := httptest.NewRequest(http.MethodPost, "/api/admin/backup/import", body)
	request.Header.Set("Content-Type", contentType)
	request = request.WithContext(context.WithValue(ctx, userCtxKey{}, &store.User{ID: "adm", Role: "admin", Status: "active"}))
	blocked := httptest.NewRecorder()
	importBackupAdmin(d, blocked, request)
	if blocked.Code == http.StatusOK {
		t.Fatal("import replaced a directory while a writer owned it")
	}
	if data, err := os.ReadFile(path); err != nil || !strings.Contains(string(data), "not persisted") {
		t.Fatalf("in-flight bytes removed: %q %v", data, err)
	}
	unlock()
	if imported := importBackupForCompatibilityTest(t, d, rec.Body.Bytes()); imported.Code != http.StatusOK {
		t.Fatalf("import did not resume: %d %s", imported.Code, imported.Body.String())
	}
}

func TestAsyncBackupRepairsMissingArtifact(t *testing.T) {
	d := storageBackupFixture(t)
	d.Config.BackupDir = t.TempDir()
	mustExec(t, d.DB, `INSERT INTO conversations(id,user_id,title) VALUES('c_async','adm','Async')`)
	mustExec(t, d.DB, `INSERT INTO messages(id,conversation_id,role,blocks) VALUES('m_async','c_async','assistant','[{"kind":"text","text":"Keep answer"},{"kind":"artifact","file_ref":"art_async"}]')`)
	mustExec(t, d.DB, `INSERT INTO artifacts(id,message_id,filename,storage_path) VALUES('art_async','m_async','missing.txt',?)`, filepath.Join(d.Config.ArtifactDir, "missing.txt"))
	manager := adminBackupExports
	adminBackupExports = &backupExportManager{jobs: map[string]*backupExportJob{}}
	t.Cleanup(func() { adminBackupExports = manager })
	job, ok := adminBackupExports.start(true, false)
	if !ok {
		t.Fatal("could not start backup")
	}
	runBackupExportJob(d, job)
	final := adminBackupExports.recentJobs()[0]
	if final.Status != "completed" || final.Error != "" {
		t.Fatalf("async export failed: %+v", final)
	}
	data, err := os.ReadFile(filepath.Join(d.Config.BackupDir, final.Filename))
	if err != nil {
		t.Fatal(err)
	}
	validStorageBackup(t, data)
	var blocks string
	if err := d.DB.QueryRow(`SELECT blocks FROM messages WHERE id='m_async'`).Scan(&blocks); err != nil || strings.Contains(blocks, "art_async") || !strings.Contains(blocks, "Keep answer") {
		t.Fatalf("async repair: %s %v", blocks, err)
	}
}

func TestBackupRepairPreservesRecordsOnStorageErrorsAndDatabaseOnlyExport(t *testing.T) {
	for _, mode := range []string{"database only", "missing root", "unsafe path", "dangling symlink"} {
		t.Run(mode, func(t *testing.T) {
			d := storageBackupFixture(t)
			missing := filepath.Join(d.Config.UploadDir, "missing.txt")
			mustExec(t, d.DB, `INSERT INTO files(id,user_id,filename,storage_path) VALUES('f_keep','adm','missing.txt',?)`, missing)
			query := "/api/admin/backup/export?files=1&qdrant=false"
			switch mode {
			case "database only":
				query = "/api/admin/backup/export?qdrant=false"
			case "missing root":
				if err := os.Remove(d.Config.ArtifactDir); err != nil {
					t.Fatal(err)
				}
			case "unsafe path":
				mustExec(t, d.DB, `INSERT INTO files(id,user_id,filename,storage_path) VALUES('f_unsafe','adm','outside.txt',?)`, filepath.Join(t.TempDir(), "outside.txt"))
			case "dangling symlink":
				link := filepath.Join(d.Config.UploadDir, "unsafe-link")
				if err := os.Symlink(filepath.Join(t.TempDir(), "absent"), link); err != nil {
					t.Fatal(err)
				}
				mustExec(t, d.DB, `INSERT INTO files(id,user_id,filename,storage_path) VALUES('f_unsafe','adm','outside.txt',?)`, filepath.Join(link, "outside.txt"))
			}
			rec := httptest.NewRecorder()
			exportBackupAdmin(d, rec, httptest.NewRequest(http.MethodGet, query, nil))
			if mode == "database only" {
				if rec.Code != http.StatusOK {
					t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
				}
				validStorageBackup(t, rec.Body.Bytes())
			} else if rec.Code != http.StatusInternalServerError {
				t.Fatalf("storage error accepted: %d", rec.Code)
			}
			var count int
			if err := d.DB.QueryRow(`SELECT COUNT(*) FROM files WHERE id='f_keep'`).Scan(&count); err != nil || count != 1 {
				t.Fatalf("unproven deletion: count=%d err=%v", count, err)
			}
		})
	}
}

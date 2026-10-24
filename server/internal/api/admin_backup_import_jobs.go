package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"aivory/server/internal/store"
	"github.com/google/uuid"
)

const backupImportChunkBytes int64 = 4 << 20
const backupImportJobTTL = 24 * time.Hour

type backupImportJob struct {
	ID            string          `json:"id"`
	Status        string          `json:"status"` // uploading | restoring | completed | failed
	TotalBytes    int64           `json:"total_bytes"`
	UploadedBytes int64           `json:"uploaded_bytes"`
	ChunkBytes    int64           `json:"chunk_bytes"`
	Result        json.RawMessage `json:"result,omitempty"`
	Error         string          `json:"error,omitempty"`
	ErrorCode     string          `json:"error_code,omitempty"`
	HTTPStatus    int             `json:"http_status,omitempty"`

	mu           sync.Mutex
	owner        string
	token        string
	path         string
	archiveName  string
	archiveFile  *os.File
	archiveMtime time.Time
	lastActivity time.Time
	lastOffset   int64
	lastSize     int64
	lastHash     [sha256.Size]byte
}

type backupImportManager struct {
	mu   sync.Mutex
	jobs map[string]*backupImportJob
}

var adminBackupImports = &backupImportManager{jobs: make(map[string]*backupImportJob)}

func (m *backupImportManager) lookup(id string) *backupImportJob {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jobs[id]
}

func (j *backupImportJob) view() map[string]any {
	// Call with j.mu held. Never expose owner, filesystem paths or the token in
	// poll responses; only the authenticated creation response returns a token.
	return map[string]any{
		"id": j.ID, "status": j.Status, "total_bytes": j.TotalBytes,
		"uploaded_bytes": j.UploadedBytes, "chunk_bytes": j.ChunkBytes,
		"result": j.Result, "error": j.Error, "error_code": j.ErrorCode, "http_status": j.HTTPStatus,
	}
}

// Bound retained uploads/results. Restores are never expired/cancelled by a
// browser disconnect or a timer. Interrupted process uploads remain on the data
// disk for an operator to inspect; they are never mistaken for completed jobs.
func (m *backupImportManager) expire(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.jobs[id]
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	remaining := backupImportJobTTL - time.Since(j.lastActivity)
	if j.Status == "restoring" || remaining > 0 {
		if remaining <= 0 {
			remaining = time.Hour
		}
		time.AfterFunc(remaining, func() { m.expire(id) })
		return
	}
	j.cleanupInput()
	delete(m.jobs, id)
}

// Call with j.mu held. A server archive is borrowed, never removed.
func (j *backupImportJob) cleanupInput() {
	if j.archiveFile != nil {
		_ = j.archiveFile.Close()
		j.archiveFile = nil
	}
	if j.path != "" {
		_ = os.Remove(j.path)
	}
}

func createBackupImportJobAdmin(d Deps, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		ID          string `json:"id"`
		SizeBytes   int64  `json:"size_bytes"`
		Confirm     string `json:"confirm"`
		ArchiveName string `json:"archive_name"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if _, err := uuid.Parse(req.ID); err != nil || req.Confirm != "REPLACE" || req.SizeBytes <= 0 {
		writeError(w, http.StatusBadRequest, errors.New("invalid backup upload or confirmation"))
		return
	}
	if req.SizeBytes > maxBackupImportBytes(d) {
		writeBackupUploadError(w, backupUploadFailure(&http.MaxBytesError{}, maxBackupImportBytes(d)))
		return
	}
	owner := authUser(r)
	if owner == nil {
		writeError(w, http.StatusForbidden, errBackupImportAdminUnauthorized)
		return
	}
	adminBackupImports.mu.Lock()
	defer adminBackupImports.mu.Unlock()
	if existing := adminBackupImports.jobs[req.ID]; existing != nil {
		existing.mu.Lock()
		defer existing.mu.Unlock()
		if existing.owner != owner.ID || existing.TotalBytes != req.SizeBytes || existing.archiveName != req.ArchiveName {
			writeError(w, http.StatusConflict, errors.New("backup upload ID already in use"))
			return
		}
		view := existing.view()
		view["token"] = existing.token
		writeJSON(w, http.StatusOK, view)
		return
	}
	activeUploads := 0
	for _, existing := range adminBackupImports.jobs {
		existing.mu.Lock()
		active := existing.Status == "uploading" || existing.Status == "restoring"
		existing.mu.Unlock()
		if active {
			activeUploads++
		}
	}
	if activeUploads > 0 {
		writeError(w, http.StatusConflict, errors.New("backup upload or import already running"))
		return
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	j := &backupImportJob{
		ID: req.ID, Status: "uploading", TotalBytes: req.SizeBytes, ChunkBytes: backupImportChunkBytes,
		owner: owner.ID, token: hex.EncodeToString(secret[:]), lastActivity: time.Now(), lastOffset: -1,
	}
	if req.ArchiveName != "" {
		file, info, status, err := openServerBackupArchive(d.Config.BackupDir, req.ArchiveName)
		if err != nil {
			writeError(w, status, err)
			return
		}
		if err := validateServerBackupDirectory(d); err != nil {
			_ = file.Close()
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if info.Size() != req.SizeBytes {
			_ = file.Close()
			writeError(w, http.StatusConflict, errors.New("server backup archive size changed; refresh the list and try again"))
			return
		}
		j.archiveName, j.archiveFile, j.archiveMtime = req.ArchiveName, file, info.ModTime()
		j.UploadedBytes = j.TotalBytes
	} else {
		dir, err := backupUploadTempDir(d)
		if err != nil {
			writeBackupUploadError(w, err)
			return
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			writeBackupUploadError(w, backupUploadFailure(err, maxBackupImportBytes(d)))
			return
		}
		file, err := os.CreateTemp(dir, ".aivory-backup-upload-*.zip")
		if err != nil {
			writeBackupUploadError(w, backupUploadFailure(err, maxBackupImportBytes(d)))
			return
		}
		_ = file.Close()
		j.path = file.Name()
	}
	adminBackupImports.jobs[j.ID] = j
	time.AfterFunc(backupImportJobTTL, func() { adminBackupImports.expire(j.ID) })
	view := j.view()
	view["token"] = j.token
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, view)
}

func ownedBackupImportJob(w http.ResponseWriter, r *http.Request) *backupImportJob {
	j := adminBackupImports.lookup(pathParam(r, "id"))
	if j == nil {
		writeError(w, http.StatusNotFound, errors.New("backup import job not found"))
		return nil
	}
	user := authUser(r)
	if user == nil || j.owner != user.ID {
		writeError(w, http.StatusNotFound, errors.New("backup import job not found"))
		return nil
	}
	return j
}

func uploadBackupImportChunkAdmin(d Deps, w http.ResponseWriter, r *http.Request) {
	j := ownedBackupImportJob(w, r)
	if j == nil {
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil || offset < 0 {
		writeError(w, http.StatusBadRequest, errors.New("invalid backup chunk offset"))
		return
	}
	if err := prepareBackupImportResponse(w); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// Each small request is independently bounded and streamed to the data disk.
	chunkDeps := d
	chunkDeps.Config.MaxBackupBytes = backupImportChunkBytes
	chunk, size, err := receiveBackupUpload(chunkDeps, w, r)
	if err != nil {
		writeBackupUploadError(w, err)
		return
	}
	defer func() { _ = chunk.Close(); _ = os.Remove(chunk.Name()) }()
	hash := sha256.New()
	if _, err := io.Copy(hash, io.NewSectionReader(chunk, 0, size)); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.Status != "uploading" {
		writeError(w, http.StatusConflict, errors.New("backup upload is no longer accepting chunks"))
		return
	}
	if j.archiveName != "" {
		writeError(w, http.StatusConflict, errors.New("server backup archives do not accept uploaded chunks"))
		return
	}
	// An acknowledged chunk may be retried after the response is lost. Accept
	// only exactly the same bytes, never append a duplicate or a different file.
	if offset == j.lastOffset && size == j.lastSize && digest == j.lastHash {
		j.lastActivity = time.Now()
		writeJSON(w, http.StatusOK, j.view())
		return
	}
	if offset != j.UploadedBytes || size <= 0 || size > j.TotalBytes-j.UploadedBytes {
		writeError(w, http.StatusConflict, errors.New("backup chunk does not match the expected offset or size"))
		return
	}
	file, err := os.OpenFile(j.path, os.O_WRONLY, 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer file.Close()
	_, err = file.Seek(offset, io.SeekStart)
	if err == nil {
		_, err = io.Copy(file, io.NewSectionReader(chunk, 0, size))
	}
	if err == nil {
		err = file.Sync()
	}
	if err != nil {
		_ = file.Truncate(offset)
		writeBackupUploadError(w, backupUploadFailure(err, maxBackupImportBytes(d)))
		return
	}
	j.lastOffset, j.lastSize, j.lastHash = offset, size, digest
	j.UploadedBytes += size
	j.lastActivity = time.Now()
	writeJSON(w, http.StatusOK, j.view())
}

func startBackupImportJobAdmin(d Deps, w http.ResponseWriter, r *http.Request) {
	j := ownedBackupImportJob(w, r)
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.Status != "uploading" {
		// Starting is idempotent; a retry cannot execute the destructive restore twice.
		writeJSON(w, http.StatusAccepted, j.view())
		return
	}
	if j.UploadedBytes != j.TotalBytes {
		writeError(w, http.StatusConflict, errors.New("backup upload is incomplete"))
		return
	}
	j.Status = "restoring"
	j.lastActivity = time.Now()
	// Retain only the actor identity, never the mutable HTTP audit/request state.
	user := *authUser(r)
	origin := auditJobOrigin(r)
	writeJSON(w, http.StatusAccepted, j.view())
	go runBackupImportJob(d, j, user, origin)
}

func cancelBackupImportUploadAdmin(_ Deps, w http.ResponseWriter, r *http.Request) {
	j := ownedBackupImportJob(w, r)
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.Status != "uploading" {
		writeError(w, http.StatusConflict, errors.New("a started restore cannot be cancelled"))
		return
	}
	j.cleanupInput()
	j.Status, j.Error = "failed", "upload cancelled"
	j.lastActivity = time.Now()
	writeJSON(w, http.StatusOK, j.view())
}

// Restore replaces login sessions. A narrowly scoped 256-bit capability lets
// the initiating browser read only its job's outcome after its session expires.
// It grants no upload, start, cancellation or data access privileges.
func backupImportJobStatus(_ Deps, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	j := adminBackupImports.lookup(pathParam(r, "id"))
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "BackupImport ")
	if j == nil || subtle.ConstantTimeCompare([]byte(token), []byte(j.token)) != 1 {
		writeError(w, http.StatusNotFound, errors.New("backup import job not found or server restarted; verify restore state before retrying"))
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	writeJSON(w, http.StatusOK, j.view())
}

type backupImportResponse struct {
	header http.Header
	status int
	bytes.Buffer
}

func (w *backupImportResponse) Header() http.Header    { return w.header }
func (w *backupImportResponse) WriteHeader(status int) { w.status = status }

func runBackupImportJob(d Deps, j *backupImportJob, user store.User, origin *store.AuditContext) {
	started := time.Now()
	response := &backupImportResponse{header: make(http.Header), status: http.StatusOK}
	defer func() {
		if recovered := recover(); recovered != nil {
			if d.Logger != nil {
				d.Logger.Printf("backup import job %s panicked: %v", j.ID, recovered)
			}
			response.status = http.StatusInternalServerError
			response.Buffer.Reset()
			_, _ = response.WriteString(`{"error":"restore interrupted; verify recovery journals before retrying","code":"backup_restore_recovery_required"}`)
		}
		j.mu.Lock()
		j.cleanupInput()
		j.lastActivity = time.Now()
		if response.status >= 200 && response.status < 300 {
			j.Status, j.Result = "completed", append(json.RawMessage(nil), response.Bytes()...)
		} else {
			var failure struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			_ = json.Unmarshal(response.Bytes(), &failure)
			j.Status, j.Error, j.ErrorCode, j.HTTPStatus = "failed", failure.Error, failure.Code, response.status
			if j.Error == "" {
				j.Error = "backup restore failed"
			}
		}
		result := j.Status
		j.mu.Unlock()
		if origin != nil {
			auditResult, reason := "success", ""
			if result != "completed" {
				auditResult, reason = "failure", "job_failed"
			}
			recordAuditJobResult(d, origin, "admin.system.backup_import_completed", j.ID, auditResult, reason, started, nil)
		}
	}()
	file := j.archiveFile
	if file != nil {
		info, err := file.Stat()
		if err != nil || info.Size() != j.TotalBytes || !info.ModTime().Equal(j.archiveMtime) {
			writeError(response, http.StatusConflict, errors.New("server backup archive changed before restore; copy a completed ZIP and try again"))
			return
		}
	} else {
		var err error
		file, err = os.Open(j.path)
		if err != nil {
			writeError(response, http.StatusInternalServerError, fmt.Errorf("open uploaded backup: %w", err))
			return
		}
		defer file.Close()
	}
	ctx := context.WithValue(context.Background(), userCtxKey{}, &user)
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/api/admin/backup/import", nil)
	restoreUploadedBackupAdmin(d, response, request, file, j.TotalBytes)
}

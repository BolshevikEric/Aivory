package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

var backupRestoreMu sync.Mutex

const backupUploadEnvelopeBytes int64 = 1 << 20

func maxBackupImportBytes(d Deps) int64 {
	if d.Config.MaxBackupBytes > 0 {
		return d.Config.MaxBackupBytes
	}
	return 20 * 1024 * 1024 * 1024
}

// A slow upload must not consume the server's absolute response deadline before
// validation/restore even starts. Only this authenticated maintenance endpoint
// opts out; reverse proxies still need their own request limits/timeouts.
func prepareBackupImportResponse(w http.ResponseWriter) error {
	err := http.NewResponseController(w).SetWriteDeadline(time.Time{})
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}

// Keep the uploaded ZIP on the data disk, outside both trees that a restore
// replaces. In production UploadDir's parent is the persistent DATA_DIR mount.
func backupUploadTempDir(d Deps) (string, error) {
	dir := strings.TrimSpace(d.Config.BackupDir)
	for _, root := range []string{d.Config.ArtifactDir, d.Config.UploadDir} {
		if strings.TrimSpace(root) != "" {
			dir = filepath.Dir(filepath.Clean(root))
		}
	}
	if dir == "" {
		dir = os.TempDir()
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	for _, root := range []string{d.Config.UploadDir, d.Config.ArtifactDir} {
		if strings.TrimSpace(root) == "" {
			continue
		}
		absRoot, err := filepath.Abs(root)
		if err != nil {
			return "", err
		}
		for {
			rel, err := filepath.Rel(absRoot, dir)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				return "", errors.New("no temporary upload directory outside restore storage")
			}
			dir = parent
		}
	}
	return dir, nil
}

type backupUploadError struct {
	status int
	err    error
}

func (e *backupUploadError) Error() string { return e.err.Error() }
func (e *backupUploadError) Unwrap() error { return e.err }

func backupUploadFailure(err error, maxBytes int64) error {
	var limitErr *http.MaxBytesError
	if errors.As(err, &limitErr) {
		return &backupUploadError{http.StatusRequestEntityTooLarge, fmt.Errorf("backup file too large (max %s)", humanBackupBytes(maxBytes))}
	}
	if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
		return &backupUploadError{http.StatusInsufficientStorage, errors.New("insufficient storage to receive backup archive")}
	}
	if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, context.Canceled) {
		return &backupUploadError{http.StatusBadRequest, errors.New("backup upload was interrupted or incomplete")}
	}
	return err
}

type backupUploadReader struct {
	ctx context.Context
	r   io.Reader
}

func (r backupUploadReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

// Receive multipart parts sequentially, without ParseMultipartForm's system-temp
// spool or an in-memory copy of the archive. The limit applies to ZIP bytes;
// a separately bounded allowance covers the multipart headers and confirmation.
// The caller owns closing/removing a successfully received file.
func receiveBackupUpload(d Deps, w http.ResponseWriter, r *http.Request) (file *os.File, size int64, err error) {
	maxBytes := maxBackupImportBytes(d)
	bodyLimit := int64(math.MaxInt64)
	if maxBytes <= math.MaxInt64-backupUploadEnvelopeBytes {
		bodyLimit = maxBytes + backupUploadEnvelopeBytes
	}
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	defer func() { err = backupUploadFailure(err, maxBytes) }()
	if r.ContentLength > bodyLimit {
		return nil, 0, &http.MaxBytesError{Limit: bodyLimit}
	}
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, 0, &backupUploadError{http.StatusBadRequest, errors.New("invalid multipart form")}
	}
	var temp *os.File
	defer func() {
		if temp != nil && err != nil {
			_ = temp.Close()
			_ = os.Remove(temp.Name())
		}
	}()
	confirmed := false
	for {
		part, nextErr := mr.NextPart()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			return nil, 0, &backupUploadError{http.StatusBadRequest, fmt.Errorf("invalid multipart form: %w", nextErr)}
		}
		switch part.FormName() {
		case "confirm":
			value, readErr := io.ReadAll(io.LimitReader(part, 64))
			if readErr != nil {
				return nil, 0, &backupUploadError{http.StatusBadRequest, readErr}
			}
			if confirmed || part.FileName() != "" || string(value) != "REPLACE" {
				return nil, 0, &backupUploadError{http.StatusBadRequest, errors.New("import requires one confirm=REPLACE field")}
			}
			confirmed = true
		case "file":
			if temp != nil || part.FileName() == "" {
				return nil, 0, &backupUploadError{http.StatusBadRequest, errors.New("import requires one archive file")}
			}
			dir, dirErr := backupUploadTempDir(d)
			if dirErr != nil {
				return nil, 0, dirErr
			}
			if mkdirErr := os.MkdirAll(dir, 0o700); mkdirErr != nil {
				return nil, 0, mkdirErr
			}
			temp, err = os.CreateTemp(dir, ".aivory-backup-upload-*.zip")
			if err != nil {
				return nil, 0, err
			}
			reader := backupUploadReader{r.Context(), part}
			size, err = io.Copy(temp, io.LimitReader(reader, maxBytes))
			if err != nil {
				return nil, 0, err
			}
			var extra [1]byte
			n, readErr := reader.Read(extra[:])
			if n > 0 {
				return nil, 0, &http.MaxBytesError{Limit: maxBytes}
			}
			if readErr != nil && readErr != io.EOF {
				return nil, 0, &backupUploadError{http.StatusBadRequest, readErr}
			}
		default:
			return nil, 0, &backupUploadError{http.StatusBadRequest, errors.New("unexpected backup upload field")}
		}
		_ = part.Close()
	}
	if !confirmed {
		return nil, 0, &backupUploadError{http.StatusBadRequest, errors.New("import requires confirm=REPLACE")}
	}
	if temp == nil {
		return nil, 0, &backupUploadError{http.StatusBadRequest, errors.New("missing archive file")}
	}
	// Surface deferred disk errors before any destructive restore work begins.
	if err = temp.Sync(); err != nil {
		return nil, 0, err
	}
	return temp, size, nil
}

func writeBackupUploadError(w http.ResponseWriter, err error) {
	var uploadErr *backupUploadError
	if errors.As(err, &uploadErr) {
		// These are deliberately user-facing storage/size/form errors.
		writeJSON(w, uploadErr.status, map[string]string{"error": uploadErr.Error()})
		return
	}
	writeError(w, http.StatusInternalServerError, err)
}

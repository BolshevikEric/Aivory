package api

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"aivory/server/internal/storage"
	"aivory/server/internal/store"
)

var (
	errAvatarBadExt  = errors.New("avatar: extension must be one of png/jpg/jpeg")
	errAvatarStorage = errors.New("avatar storage is not configured; choose local, S3, or Aliyun OSS in admin storage settings")
)

const (
	avatarObjectPrefix   = "avatars/"
	avatarStorageTimeout = 30 * time.Second
)

// uploadAvatar stores profile images directly from the API process in the
// administrator-selected object backend. The returned application URL stays
// stable while S3/OSS buckets remain private and local storage stays internal.
func uploadAvatar(d Deps, w http.ResponseWriter, r *http.Request) {
	data, ext, mimeType, status, err := readValidatedImageUpload(r, false, errAvatarBadExt)
	if err != nil {
		writeError(w, status, err)
		return
	}

	obj := privateObjectStorage(d)
	if obj == nil || !obj.Enabled() {
		writeError(w, http.StatusServiceUnavailable, errAvatarStorage)
		return
	}
	id, err := randomHex(12)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	filename := id + "." + ext

	ctx, cancel := context.WithTimeout(r.Context(), avatarStorageTimeout)
	defer cancel()
	if err := store.RegisterAvatarUpload(ctx, d.DB, authUser(r).ID, filename, time.Now().Add(avatarStorageTimeout+time.Minute).Unix()); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if _, err := obj.Put(ctx, avatarObjectPrefix+filename, data, mimeType); err != nil {
		finishCtx, finishCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer finishCancel()
		_ = store.FinishAvatarUpload(finishCtx, d.DB, filename, false)
		writeError(w, http.StatusBadGateway, err)
		return
	}
	finishCtx, finishCancel := context.WithTimeout(context.Background(), avatarStorageTimeout)
	defer finishCancel()
	if err := store.FinishAvatarUpload(finishCtx, d.DB, filename, true); err != nil {
		sweepAvatarCleanup(finishCtx, d)
		writeError(w, http.StatusBadRequest, err)
		return
	}
	sweepAvatarCleanup(finishCtx, d)

	writeJSON(w, http.StatusOK, map[string]any{
		"url":      "/api/avatars/" + filename,
		"filename": filename,
	})
}

// serveAvatar proxies a tightly bounded private object through a stable public
// URL. Filenames are random and content was validated on write; public access
// is required for shared-conversation author identities and unauthenticated
// <img> requests that cannot refresh an expired access token.
func serveAvatar(d Deps, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	filename := pathParam(r, "filename")
	if !isSafeAvatarFilename(filename) {
		writeError(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	visible, err := store.AvatarVisible(r.Context(), d.DB, filename)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !visible {
		writeError(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	obj := privateObjectStorage(d)
	if obj == nil || !obj.Enabled() {
		writeError(w, http.StatusServiceUnavailable, errAvatarStorage)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), avatarStorageTimeout)
	defer cancel()
	data, err := obj.Get(ctx, avatarObjectPrefix+filename, maxIconBytes)
	if errors.Is(err, storage.ErrObjectNotFound) {
		writeError(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}

	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(filename), "."))
	w.Header().Set("Content-Type", allowedIconExt[ext])
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// Pending uploads expire after one hour. Deleted/replaced objects are claimed
// immediately, but never while a bounded upload might still write them back.
// The ownership ledger doubles as the durable physical-deletion retry queue.
func sweepAvatarCleanup(ctx context.Context, d Deps) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	filenames, err := store.AvatarCleanupBatch(ctx, d.DB)
	if err != nil {
		logStorageCleanup(d, "avatar cleanup scan: %v", err)
		return
	}
	obj := privateObjectStorage(d)
	for _, filename := range filenames {
		if ctx.Err() != nil {
			return
		}
		claimed, err := store.ClaimAvatarCleanup(ctx, d.DB, filename)
		if err != nil || !claimed {
			continue
		}
		if !isSafeAvatarFilename(filename) {
			err = errors.New("unsafe avatar filename")
		} else if obj == nil || !obj.Enabled() {
			err = errAvatarStorage
		} else {
			err = obj.Delete(ctx, avatarObjectPrefix+filename)
		}
		if recordErr := store.CompleteAvatarCleanup(context.WithoutCancel(ctx), d.DB, filename, err); recordErr != nil {
			logStorageCleanup(d, "avatar cleanup record %s: %v", filename, recordErr)
		}
		if err != nil {
			logStorageCleanup(d, "avatar cleanup %s: %v", filename, err)
		}
	}
}

func isSafeAvatarFilename(name string) bool {
	if !isSafeIconFilename(name) {
		return false
	}
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	return ext == "png" || ext == "jpeg"
}

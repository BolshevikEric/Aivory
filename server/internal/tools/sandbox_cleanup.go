package tools

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"aivory/server/internal/sandbox"
	"aivory/server/internal/store"
)

// Called while holding the provisioning lock. A deleted conversation must not
// be archived again by a request that was already creating its session.
func releaseUntrackedSandbox(ctx context.Context, sb sandbox.Service, db *sql.DB, convID, sessionID string) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	_, err := store.GetConversationByID(cleanupCtx, db, convID)
	if !errors.Is(err, store.ErrNotFound) {
		_ = sb.Release(cleanupCtx, sessionID)
		return
	}
	item := store.ConversationSandboxDiscard{ConversationID: convID, SessionID: sessionID}
	if err := store.QueueSandboxCleanup(cleanupCtx, db, item); err != nil {
		// Even if persistence is temporarily unavailable, try destruction now.
		_ = sb.ReleaseDiscard(cleanupCtx, sessionID, convID)
		return
	}
	if err := sb.ReleaseDiscard(cleanupCtx, sessionID, convID); err != nil {
		_ = store.RecordSandboxCleanupFailure(cleanupCtx, db, item, err)
		return
	}
	_ = store.DeletePendingSandboxCleanup(cleanupCtx, db, item)
}

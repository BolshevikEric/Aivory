package api

import (
	"context"
	"errors"
	"time"

	"aivory/server/internal/store"
)

// Database deletion has committed. Navigation must not cancel physical work;
// failures stay in the transaction's ledgers for the retry worker/restart.
func cleanupDeletedConversationResources(ctx context.Context, d Deps, state *store.ConversationDeletionState) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	for _, item := range state.SandboxDiscards {
		cleanupDeletedSandbox(cleanupCtx, d, item)
	}
	obj := objectStorageClient(d)
	for _, path := range state.StoragePaths {
		if _, err := cleanupOneStoragePath(cleanupCtx, d, obj, path); err != nil {
			logStorageCleanup(d, "deleted conversation storage %q: %v", path, err)
			recordStorageCleanupAttempt(cleanupCtx, d, path, err)
			continue
		}
		if err := store.DeletePendingStorageCleanup(cleanupCtx, d.DB, path); err != nil {
			logStorageCleanup(d, "deleted conversation storage %q: forget path: %v", path, err)
		}
	}
}

func cleanupDeletedSandbox(ctx context.Context, d Deps, item store.ConversationSandboxDiscard) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	// Empty session IDs still require an archive purge if archive storage is
	// configured. Conversations that never used a sandbox need no sidecar call.
	var err error
	if item.SessionID == "" && objectStorageConfig(d) == nil {
		err = nil
	} else if d.Tools == nil || d.Tools.Sandbox() == nil || !d.Tools.Sandbox().Enabled() {
		err = errors.New("sandbox unavailable; deletion retained for retry")
	} else {
		err = d.Tools.DiscardConversationSandbox(ctx, item.ConversationID, item.SessionID)
	}
	if err != nil {
		logStorageCleanup(d, "deleted conversation sandbox %s/%s: %v", item.ConversationID, item.SessionID, err)
		recordCtx, recordCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer recordCancel()
		if recordErr := store.RecordSandboxCleanupFailure(recordCtx, d.DB, item, err); recordErr != nil {
			logStorageCleanup(d, "record sandbox cleanup failure: %v", recordErr)
		}
		return
	}
	if err := store.DeletePendingSandboxCleanup(ctx, d.DB, item); err != nil {
		logStorageCleanup(d, "forget sandbox cleanup %s/%s: %v", item.ConversationID, item.SessionID, err)
	}
}

func sweepPendingSandboxCleanup(d Deps) {
	sweepPendingSandboxCleanupContext(context.Background(), d)
}

func sweepPendingSandboxCleanupContext(ctx context.Context, d Deps) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	items, err := store.ListPendingSandboxCleanup(ctx, d.DB)
	if err != nil {
		logStorageCleanup(d, "sandbox cleanup sweep: %v", err)
		return
	}
	for _, item := range items {
		if ctx.Err() != nil {
			return
		}
		cleanupDeletedSandbox(ctx, d, item)
	}
}

// RunPendingResourceCleanup retries durable failures without scanning live
// conversations or expiring drafts. Empty ledgers cost only two small queries.
// Called once by the server, under its shutdown context; sweeps never overlap.
func RunPendingResourceCleanup(ctx context.Context, d Deps) {
	sweepAvatarCleanup(ctx, d)
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweepAvatarCleanup(ctx, d)
			sweepPendingSandboxCleanupContext(ctx, d)
			sweepPendingStorageCleanupContext(ctx, d)
		}
	}
}

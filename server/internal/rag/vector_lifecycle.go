package rag

import (
	"context"
	"errors"
	"time"

	"aivory/server/internal/store"
	"aivory/server/internal/vector"
)

const vectorWriteTimeout = 2 * time.Minute

// Every writer, including admin repairs, registers before external I/O. Delete
// triggers persist tombstones; cleanup never acknowledges one while a writer
// could still recreate its points. Leases let recovery finish after a crash.
func (s *Service) upsertDocumentVectors(ctx context.Context, dim int, points []vector.Point) error {
	if len(points) == 0 {
		return nil
	}
	writeCtx, cancel := context.WithTimeout(ctx, vectorWriteTimeout)
	defer cancel()
	writes := map[string]string{}
	for _, point := range points {
		docID := point.Payload.DocumentID
		if _, registered := writes[docID]; registered {
			continue
		}
		writeID := store.NewChunkID()
		if err := store.BeginDocumentVectorWrite(writeCtx, s.db, docID, writeID, time.Now().Add(vectorWriteTimeout+time.Minute).Unix()); err != nil {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cleanupCancel()
			for _, id := range writes {
				_ = store.FinishDocumentVectorWrite(cleanupCtx, s.db, id)
			}
			return err
		}
		writes[docID] = writeID
	}
	upsertErr := s.vec.Upsert(writeCtx, dim, points)
	err := upsertErr
	// Finish with an independent context, even if the pipeline was cancelled.
	// A failed external request has an unknown outcome: retain its short lease
	// so recovery's final delete happens after any late remote completion.
	finishCtx, finishCancel := context.WithTimeout(context.Background(), time.Minute)
	defer finishCancel()
	for docID, writeID := range writes {
		if upsertErr == nil {
			if finishErr := store.FinishDocumentVectorWrite(finishCtx, s.db, writeID); finishErr != nil {
				return finishErr
			}
		}
		if _, lookupErr := store.GetDocument(finishCtx, s.db, docID); errors.Is(lookupErr, store.ErrNotFound) {
			if cleanupErr := s.cleanupDeletedDocumentVectors(finishCtx, docID); cleanupErr != nil && s.logger != nil {
				s.logger.Printf("rag: cleanup late vectors for deleted document %s: %v", docID, cleanupErr)
			}
			if err == nil {
				err = store.ErrNotFound
			}
		} else if lookupErr != nil && err == nil {
			err = lookupErr
		}
	}
	return err
}

func (s *Service) cleanupDeletedDocumentVectors(ctx context.Context, docID string) error {
	ready, err := store.VectorCleanupReady(ctx, s.db, docID)
	if err != nil || !ready {
		return err
	}
	err = s.vec.DeleteByDocument(ctx, docID)
	if recordErr := store.CompleteVectorCleanup(context.WithoutCancel(ctx), s.db, docID, err); recordErr != nil {
		return recordErr
	}
	return err
}

func (s *Service) SweepDeletedDocumentVectors(ctx context.Context) {
	if !s.vec.Enabled() {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	ids, err := store.PendingVectorCleanup(ctx, s.db, time.Now().Unix())
	if err != nil {
		if s.logger != nil {
			s.logger.Printf("rag: pending vector cleanup: %v", err)
		}
		return
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		if err := s.cleanupDeletedDocumentVectors(ctx, id); err != nil && s.logger != nil {
			s.logger.Printf("rag: pending vector cleanup %s: %v", id, err)
		}
	}
}

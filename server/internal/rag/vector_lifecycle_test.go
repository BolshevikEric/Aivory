package rag

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"aivory/server/internal/store"
	"aivory/server/internal/vector"
)

type pausedVectorStore struct {
	vector.Disabled
	mu       sync.Mutex
	started  chan struct{}
	resume   chan struct{}
	points   []vector.Point
	failDrop bool
}

func (*pausedVectorStore) Enabled() bool { return true }
func (v *pausedVectorStore) Upsert(ctx context.Context, _ int, points []vector.Point) error {
	close(v.started)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-v.resume:
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.points = append(v.points, points...)
	return nil
}
func (v *pausedVectorStore) DeleteByDocument(_ context.Context, docID string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.failDrop {
		return errors.New("Qdrant unavailable")
	}
	var keep []vector.Point
	for _, point := range v.points {
		if point.Payload.DocumentID != docID {
			keep = append(keep, point)
		}
	}
	v.points = keep
	return nil
}

func TestDocumentDeletionDuringVectorWritePurgesLatePoints(t *testing.T) {
	for _, scope := range []string{"document", "attachment", "draft", "conversation", "kb", "account"} {
		t.Run(scope, func(t *testing.T) {
			ctx := context.Background()
			db := openIngestRecoveryDB(t)
			defer db.Close()
			doc := createRecoveryDocument(t, ctx, db, "racing", "embedding")
			if scope == "kb" {
				for _, query := range []string{
					`INSERT INTO channels(id,name,type) VALUES('ch','CH','openai')`,
					`INSERT INTO models(id,channel_id,kind,request_id,label) VALUES('emb','ch','embedding','emb','Emb')`,
					`INSERT INTO knowledge_bases(id,user_id,name,embedding_model_id,embedding_dim) VALUES('kb','u1','KB','emb',3)`,
					`UPDATE documents SET conversation_id=NULL,kb_id='kb' WHERE id='racing'`,
				} {
					if _, err := db.Exec(query); err != nil {
						t.Fatal(err)
					}
				}
			}
			if scope == "attachment" {
				if _, err := db.Exec(`INSERT INTO files(id,user_id,conversation_id,filename,storage_path) VALUES('f','u1','c1','f.txt','/tmp/race.txt')`); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Exec(`UPDATE documents SET storage_path='/tmp/race.txt' WHERE id='racing'`); err != nil {
					t.Fatal(err)
				}
			}
			if scope == "draft" {
				if _, err := db.Exec(`UPDATE conversations SET draft_scope='chat' WHERE id='c1'`); err != nil {
					t.Fatal(err)
				}
			}
			if err := store.CreateChunksBatch(ctx, db, []store.ChunkInsert{{ID: "chunk", DocumentID: doc.ID, Content: "private content"}}); err != nil {
				t.Fatal(err)
			}
			vec := &pausedVectorStore{started: make(chan struct{}), resume: make(chan struct{})}
			svc := &Service{db: db, vec: vec}
			done := make(chan error, 1)
			go func() {
				done <- svc.upsertDocumentVectors(ctx, 3, []vector.Point{{ChunkID: "chunk", Vector: []float32{1, 2, 3}, Payload: vector.Payload{DocumentID: doc.ID, Content: "private content"}}})
			}()
			select {
			case <-vec.started:
			case <-time.After(5 * time.Second):
				t.Fatal("writer did not start")
			}
			var err error
			switch scope {
			case "document":
				err = store.DeleteDocument(ctx, db, doc.ID)
			case "attachment":
				err = store.DeleteConversationFileAndDocuments(ctx, db, "f", "c1", "u1", []string{doc.ID})
			case "conversation", "draft":
				_, err = store.DeleteConversationWithState(ctx, db, "c1", "u1")
			case "kb":
				err = store.DeleteKB(ctx, db, "kb", "u1")
			case "account":
				err = store.DeleteUser(ctx, db, "u1")
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := svc.OnDocumentDeleted(ctx, doc.ID); err != nil {
				t.Fatal(err)
			}
			svc.SweepDeletedDocumentVectors(ctx)
			var pending int
			if err := db.QueryRow(`SELECT COUNT(*) FROM pending_vector_cleanup WHERE document_id=?`, doc.ID).Scan(&pending); err != nil || pending != 1 {
				t.Fatalf("live write lost its tombstone: count=%d err=%v", pending, err)
			}
			close(vec.resume)
			if err := <-done; !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("late write err=%v", err)
			}
			if len(vec.points) != 0 {
				t.Fatal("deleted content survived in vector backend")
			}
			if err := store.UpdateDocumentStatus(ctx, db, doc.ID, "ready", "", 1); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("missing document marked ready: %v", err)
			}
			if err := db.QueryRow(`SELECT COUNT(*) FROM pending_vector_cleanup`).Scan(&pending); err != nil || pending != 0 {
				t.Fatalf("cleanup not acknowledged: count=%d err=%v", pending, err)
			}
		})
	}
}

func TestDeletedVectorCleanupRetriesAfterFailureAndAbandonedWriter(t *testing.T) {
	ctx := context.Background()
	db := openIngestRecoveryDB(t)
	defer db.Close()
	doc := createRecoveryDocument(t, ctx, db, "retry", "embedding")
	// Emulate another process which registered a write, then crashed.
	if err := store.BeginDocumentVectorWrite(ctx, db, doc.ID, "abandoned", time.Now().Add(time.Minute).Unix()); err != nil {
		t.Fatal(err)
	}
	vec := &pausedVectorStore{points: []vector.Point{{Payload: vector.Payload{DocumentID: doc.ID}}}, failDrop: true}
	if err := store.DeleteDocument(ctx, db, doc.ID); err != nil {
		t.Fatal(err)
	}
	svc := &Service{db: db, vec: vec}
	svc.SweepDeletedDocumentVectors(ctx)
	if len(vec.points) != 1 {
		t.Fatal("cleanup ran before writer's lease elapsed")
	}
	if _, err := db.Exec(`UPDATE document_vector_writes SET expires_at=0`); err != nil {
		t.Fatal(err)
	}
	svc.SweepDeletedDocumentVectors(ctx)
	var attempts int
	var lastError string
	if err := db.QueryRow(`SELECT attempts,last_error FROM pending_vector_cleanup WHERE document_id=?`, doc.ID).Scan(&attempts, &lastError); err != nil || attempts != 1 || lastError == "" {
		t.Fatalf("failure not durable: %d %q %v", attempts, lastError, err)
	}
	// Fresh service: no in-process task or deletion state is needed to retry.
	vec.failDrop = false
	restarted := &Service{db: db, vec: vec}
	restarted.SweepDeletedDocumentVectors(ctx)
	if len(vec.points) != 0 {
		t.Fatal("recovery left deleted vectors")
	}
	if err := store.BeginDocumentVectorWrite(ctx, db, doc.ID, "too-late", time.Now().Add(time.Minute).Unix()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("new write allowed after deletion: %v", err)
	}
}

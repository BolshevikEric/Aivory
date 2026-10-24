package tools

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"aivory/server/internal/llm"
	"aivory/server/internal/store"
	"github.com/mattn/go-sqlite3"
)

// Commit the real SQLite transaction, then lose its acknowledgement, as can
// happen when a PostgreSQL connection drops after the server commits.
type lostArtifactCommitDriver struct {
	armed, committed *atomic.Bool
	readFailure      bool
}
type lostArtifactCommitConn struct {
	driver.Conn
	fault *lostArtifactCommitDriver
}
type lostArtifactCommitTx struct {
	driver.Tx
	fault *lostArtifactCommitDriver
}

func (d *lostArtifactCommitDriver) Open(name string) (driver.Conn, error) {
	c, err := (&sqlite3.SQLiteDriver{}).Open(name)
	if err != nil {
		return nil, err
	}
	return &lostArtifactCommitConn{Conn: c, fault: d}, nil
}
func (c *lostArtifactCommitConn) Prepare(query string) (driver.Stmt, error) {
	if c.fault.readFailure && c.fault.committed.Load() {
		return nil, io.ErrUnexpectedEOF
	}
	return c.Conn.Prepare(query)
}
func (c *lostArtifactCommitConn) Begin() (driver.Tx, error) {
	tx, err := c.Conn.Begin()
	if err != nil {
		return nil, err
	}
	return &lostArtifactCommitTx{Tx: tx, fault: c.fault}, nil
}
func (tx *lostArtifactCommitTx) Commit() error {
	if err := tx.Tx.Commit(); err != nil {
		return err
	}
	if tx.fault.armed.Swap(false) {
		tx.fault.committed.Store(true)
		return io.ErrUnexpectedEOF
	}
	return nil
}

func TestSaveArtifactLostCommitAcknowledgement(t *testing.T) {
	for _, readFailure := range []bool{false, true} {
		name := "reconciled"
		if readFailure {
			name = "verification unavailable retains bytes"
		}
		t.Run(name, func(t *testing.T) {
			tool, convID := seedImageWorkflow(t, "openai", "audit-image")
			if _, err := tool.db.Exec(`INSERT INTO messages(id,conversation_id,role,author_id,status) VALUES('m_persist','c_flow','assistant','u_flow','streaming')`); err != nil {
				t.Fatal(err)
			}
			var sequence int
			var dbName, path string
			if err := tool.db.QueryRow(`PRAGMA database_list`).Scan(&sequence, &dbName, &path); err != nil {
				t.Fatal(err)
			}
			fault := &lostArtifactCommitDriver{armed: &atomic.Bool{}, committed: &atomic.Bool{}, readFailure: readFailure}
			driverName := "lost-artifact-commit-" + strings.ReplaceAll(t.Name(), "/", "-") + store.GenID("test")
			sql.Register(driverName, fault)
			db, err := sql.Open(driverName, path+"?_foreign_keys=on&_busy_timeout=5000")
			if err != nil {
				t.Fatal(err)
			}
			db.SetMaxOpenConns(1)
			t.Cleanup(func() { _ = db.Close() })
			fault.armed.Store(true)
			events := 0
			art, err := saveArtifact(context.Background(), &llm.ToolContext{
				DB: db, UserID: "u_flow", ConvID: convID, MessageID: "m_persist",
				OnArtifact: func(llm.ArtifactRef) { events++ },
			}, tool.artifactDir, "report.txt", "text/plain", store.ArtifactSourcePythonExecute, []byte("saved report"))
			if readFailure {
				if !errors.Is(err, store.ErrArtifactPersistenceUncertain) || events != 0 {
					t.Fatalf("art=%v err=%v events=%d", art, err, events)
				}
			} else if err != nil || art == nil || events != 1 {
				t.Fatalf("art=%v err=%v events=%d", art, err, events)
			}
			var storedPath string
			if err := tool.db.QueryRow(`SELECT storage_path FROM artifacts WHERE message_id='m_persist'`).Scan(&storedPath); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(storedPath)
			if err != nil || string(data) != "saved report" {
				t.Fatalf("durable artifact lost: bytes=%q err=%v", data, err)
			}
		})
	}
}

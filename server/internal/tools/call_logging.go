package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"aivory/server/internal/llm"
	"aivory/server/internal/store"
	"aivory/server/internal/tooldiagnostics"
	"github.com/google/uuid"
)

type pendingToolLog struct {
	log        store.ToolCallLog
	collector  *tooldiagnostics.Collector
	errorsOnly bool
}

func (r *Registry) toolLogBool(key string, fallback bool) bool {
	if r.db == nil {
		return fallback
	}
	raw, err := store.GetSetting(r.db, key)
	var value bool
	if err != nil || json.Unmarshal(raw, &value) != nil {
		return fallback
	}
	return value
}

func (r *Registry) enqueueToolLog(pending pendingToolLog) {
	r.toolLogMu.Lock()
	defer r.toolLogMu.Unlock()
	if r.toolLogClosed {
		return
	}
	r.toolLogOnce.Do(func() {
		r.toolLogs = make(chan pendingToolLog, 64)
		r.toolLogDone = make(chan struct{})
		go func() {
			defer close(r.toolLogDone)
			for pending := range r.toolLogs {
				log, collector := pending.log, pending.collector
				var hasErrors bool
				log.Requests, log.Issues, hasErrors = collector.Snapshot()
				if log.Status == "success" && hasErrors {
					log.Status = "partial"
				}
				if pending.errorsOnly && log.Status == "success" {
					continue
				}
				log.ServerID, log.ServerName, log.RemoteName = collector.ServerID, collector.ServerName, collector.RemoteName
				log.Error, _ = tooldiagnostics.Limit(collector.Sanitize(log.Error), tooldiagnostics.BodyLimit)
				if log.BodiesRecorded {
					log.Summary = toolLogSummary(collector.Sanitize(log.Input))
					var inputTruncated, outputTruncated bool
					log.Input, inputTruncated = tooldiagnostics.Limit(collector.Sanitize(log.Input), tooldiagnostics.BodyLimit)
					log.Output, outputTruncated = tooldiagnostics.Limit(collector.Sanitize(log.Output), tooldiagnostics.BodyLimit)
					log.InputTruncated = log.InputTruncated || inputTruncated
					log.OutputTruncated = log.OutputTruncated || outputTruncated
				} else {
					log.Input, log.Output = "", ""
				}
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				err := store.InsertToolCallLog(ctx, r.db, log)
				cancel()
				if err != nil && r.logger != nil {
					r.logger.Printf("tool log %s (%s): %v", log.ID, log.ToolName, err)
				}
			}
		}()
	})
	select {
	case r.toolLogs <- pending:
	default:
		if r.logger != nil {
			r.logger.Printf("tool log queue full; dropped %s (%s)", pending.log.ID, pending.log.ToolName)
		}
	}
}

// LogToolFailure records failures raised by the orchestrator's execution
// tracker after the registry call has already returned. These failures include
// duplicate requests, repeated failed routes, and searches that produced no
// new evidence. They must still be visible in the same admin tool log even
// though they never reach Registry.Run's defer-based logger.
func (r *Registry) LogToolFailure(ctx context.Context, name string, input []byte, tc *llm.ToolContext, toolErr error) {
	if r == nil || r.db == nil || tc == nil || tc.UserID == "" || toolErr == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	started := time.Now()
	bodies := r.toolLogBool("log_request_bodies", true)
	errorsOnly := r.toolLogBool("log_tool_errors_only", true)
	ctx, collector := tooldiagnostics.Start(ctx, bodies)
	collector.CaptureSecrets(string(input))
	r.mu.RLock()
	binding, isMCP := r.mcpBindings[name]
	r.mu.RUnlock()
	kind := "builtin"
	if isMCP {
		kind = "mcp"
		collector.ServerID, collector.RemoteName = binding.ServerID, binding.RemoteName
	}
	callID := tooldiagnostics.CallID(ctx)
	if callID == "" {
		callID = "internal_" + uuid.NewString()
	}
	log := store.ToolCallLog{
		ID: "tl_" + uuid.NewString(), CallID: callID, ToolName: name, ToolKind: kind,
		UserID: tc.UserID, ConversationID: tc.ConvID, MessageID: tc.MessageID, WorkspaceID: tc.WorkspaceID,
		ModelID: tc.ModelID, Status: "error", DurationMS: time.Since(started).Milliseconds(), CreatedAtMS: started.UnixMilli(),
		Error: toolErr.Error(), BodiesRecorded: bodies,
	}
	if bodies {
		log.Input, log.InputTruncated = tooldiagnostics.Limit(string(input), 2*tooldiagnostics.BodyLimit)
		if llm.IsToolNoProgress(toolErr) {
			log.Output = llm.ToolNoProgressOutput()
		}
		log.Output, log.OutputTruncated = tooldiagnostics.Limit(log.Output, 2*tooldiagnostics.BodyLimit)
	}
	r.enqueueToolLog(pendingToolLog{log: log, collector: collector, errorsOnly: errorsOnly})
}

func (r *Registry) CloseToolLogs(ctx context.Context) error {
	r.toolLogMu.Lock()
	if !r.toolLogClosed {
		r.toolLogClosed = true
		if r.toolLogs != nil {
			close(r.toolLogs)
		}
	}
	done := r.toolLogDone
	r.toolLogMu.Unlock()
	if done == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func toolLogSummary(input string) string {
	var params map[string]any
	if json.Unmarshal([]byte(input), &params) != nil {
		return ""
	}
	parts := []string{}
	for _, key := range []string{"query", "queries", "url", "urls"} {
		switch value := params[key].(type) {
		case string:
			parts = append(parts, value)
		case []any:
			for _, item := range value {
				if text, ok := item.(string); ok {
					parts = append(parts, text)
				}
			}
		}
	}
	value, _ := tooldiagnostics.Limit(strings.Join(parts, " | "), 512)
	return value
}

func (r *Registry) Run(ctx context.Context, name string, input []byte, tc *llm.ToolContext) (output string, citations []llm.Citation, err error) {
	if r.db == nil || ctx == nil || tc == nil || tc.UserID == "" {
		return r.run(ctx, name, input, tc)
	}
	started := time.Now()
	bodies := r.toolLogBool("log_request_bodies", true)
	errorsOnly := r.toolLogBool("log_tool_errors_only", true)
	ctx, collector := tooldiagnostics.Start(ctx, bodies)
	collector.CaptureSecrets(string(input))
	r.mu.RLock()
	binding, isMCP := r.mcpBindings[name]
	r.mu.RUnlock()
	kind := "builtin"
	if isMCP {
		kind = "mcp"
		collector.ServerID, collector.RemoteName = binding.ServerID, binding.RemoteName
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("tool %q panicked: %v", name, recovered)
		}
		status, detail := "success", ""
		if err != nil {
			status, detail = "error", err.Error()
			if errors.Is(err, context.DeadlineExceeded) {
				status = "timeout"
			}
			if errors.Is(err, context.Canceled) {
				status = "canceled"
			}
		}
		if errorsOnly && err == nil && !collector.HasErrors() {
			return
		}
		log := store.ToolCallLog{
			ID: "tl_" + uuid.NewString(), CallID: tooldiagnostics.CallID(ctx), ToolName: name, ToolKind: kind,
			UserID: tc.UserID, ConversationID: tc.ConvID, MessageID: tc.MessageID, WorkspaceID: tc.WorkspaceID,
			ModelID: tc.ModelID, Status: status, DurationMS: time.Since(started).Milliseconds(), CreatedAtMS: started.UnixMilli(),
			Error: detail, BodiesRecorded: bodies,
		}
		if log.CallID == "" {
			log.CallID = "internal_" + uuid.NewString()
		}
		if bodies {
			log.Input, log.InputTruncated = tooldiagnostics.Limit(string(input), 2*tooldiagnostics.BodyLimit)
			log.Output, log.OutputTruncated = tooldiagnostics.Limit(output, 2*tooldiagnostics.BodyLimit)
		}
		log.Error, _ = tooldiagnostics.Limit(log.Error, 2*tooldiagnostics.BodyLimit)
		r.enqueueToolLog(pendingToolLog{log: log, collector: collector, errorsOnly: errorsOnly})
	}()
	return r.run(ctx, name, input, tc)
}

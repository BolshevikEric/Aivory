package llm

// Provider usage events are cumulative snapshots for one request. Only replace
// fields that are present: a trailing usage-only frame may omit cache details
// reported earlier. Aliases describe the same tokens and must never be summed.
func setUsageTokenCount(count *int, values ...any) {
	for _, value := range values {
		if value != nil {
			*count = maxInt(intOf(value), 0)
			return
		}
	}
}

func updateOpenAIUsage(usage *Usage, values map[string]any, responses bool) {
	inputKey, outputKey, detailsKey := "prompt_tokens", "completion_tokens", "prompt_tokens_details"
	if responses {
		inputKey, outputKey, detailsKey = "input_tokens", "output_tokens", "input_tokens_details"
	}
	setUsageTokenCount(&usage.InputTokens, values[inputKey])
	setUsageTokenCount(&usage.OutputTokens, values[outputKey])
	details, _ := values[detailsKey].(map[string]any)
	// OpenAI nests cache counts inside input/prompt details. Compatible relays
	// may instead expose Anthropic counters or DeepSeek's prompt cache hits.
	setUsageTokenCount(&usage.CacheReadTokens, details["cached_tokens"], values["cache_read_input_tokens"], values["prompt_cache_hit_tokens"], values["cache_read_tokens"])
	setUsageTokenCount(&usage.CacheWriteTokens, details["cache_write_tokens"], values["cache_creation_input_tokens"], values["cache_write_tokens"])
	// A cache miss is ordinary input, not evidence that a cache entry was written.
}

func updateGeminiUsage(usage *Usage, values map[string]any) {
	setUsageTokenCount(&usage.InputTokens, values["promptTokenCount"])
	if values["candidatesTokenCount"] != nil || values["thoughtsTokenCount"] != nil {
		usage.OutputTokens = maxInt(intOf(values["candidatesTokenCount"]), 0) + maxInt(intOf(values["thoughtsTokenCount"]), 0)
	}
	// generateContent reports cache reads as a subset of promptTokenCount. It
	// does not report cache creation usage, so leave writes at zero.
	setUsageTokenCount(&usage.CacheReadTokens, values["cachedContentTokenCount"])
}

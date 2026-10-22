package llm

import "strings"

// SearchNotConfiguredNotice is the tool output returned when no web-search
// backend is configured anywhere. It is deliberately a plain notice with no
// citation: a placeholder citation would be persisted and rendered as a
// clickable source pointing at a page that does not exist.
const SearchNotConfiguredNotice = "Search not yet configured. Reply based on training knowledge or ask the administrator to configure web search."

// IsSearchNotConfiguredNotice reports whether a web-search tool output is that
// notice, so callers never have to match on a sentinel citation.
func IsSearchNotConfiguredNotice(output string) bool {
	return strings.HasPrefix(strings.TrimSpace(output), "Search not yet configured")
}

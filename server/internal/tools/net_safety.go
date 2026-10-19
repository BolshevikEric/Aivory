package tools

import (
	"aivory/server/internal/netsafe"
	"net"
	"net/http"
	"time"
)

// Low-level HTTP-client network tunables for tool fetches — dial / TLS / idle /
// overall timeouts. Hardcoded (not operator-facing knobs).
var (
	ssrfSafeClientTimeout               = 40 * time.Second
	toolHTTPClientDialTimeout           = 10 * time.Second
	toolHTTPClientTLSHandshakeTimeout   = 10 * time.Second
	toolHTTPClientResponseHeaderTimeout = 600 * time.Second
	toolHTTPClientIdleConnTimeout       = 90 * time.Second
)

// isPublicIP rejects loopback/private/link-local/unspecified/multicast plus the
// CGNAT/NAT64/TEST-NET ranges Go doesn't classify (§F4). Delegates to the shared
// netsafe package so the tools and rag SSRF guards stay in lockstep.
func isPublicIP(ip net.IP) bool { return netsafe.IsPublicIP(ip) }

// ssrfSafeClient returns an http.Client that only connects to ports 80/443 and
// validates the resolved IP at dial time (defeats DNS-rebinding + redirects).
// Use for MODEL-controlled URLs (web_fetch).
func ssrfSafeClient() *http.Client { return netsafe.SafeClient(ssrfSafeClientTimeout) }

// These clients connect to administrator-configured endpoints, including
// internal gateways. Model-controlled URLs must use ssrfSafeClient instead.
var toolHTTPClient = newToolHTTPClient(toolHTTPClientResponseHeaderTimeout)

// Image generation may return its first header only after rendering completes.
// Its model timeout and parent context bound both headers and the response body.
var imageHTTPClient = newToolHTTPClient(0)

func newToolHTTPClient(responseHeaderTimeout time.Duration) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: toolHTTPClientDialTimeout}).DialContext,
			TLSHandshakeTimeout:   toolHTTPClientTLSHandshakeTimeout,
			ResponseHeaderTimeout: responseHeaderTimeout,
			IdleConnTimeout:       toolHTTPClientIdleConnTimeout,
		},
	}
}

package api

import "net/http"

// The browser is read-only and checks conversation access before live or
// archived workspace reads. Browsing a recycled session never creates one.
func sandboxFilesHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	serveSandboxBrowserList(d, w, r, authUser(r).ID, false)
}

func sandboxFileGetHandler(d Deps, w http.ResponseWriter, r *http.Request) {
	serveSandboxBrowserFile(d, w, r, authUser(r).ID, false)
}

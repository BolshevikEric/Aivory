// Package pdfexport prints static, self-contained conversation documents.
package pdfexport

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/cdproto/target"
	"github.com/chromedp/chromedp"
)

var ErrUnavailable = errors.New("pdf_renderer_unavailable")
var ErrBusy = errors.New("pdf_renderer_busy")

// Renderer keeps one lazily started browser, bounded to two isolated tabs.
// It never receives session cookies, credentials or access to remote assets.
type Renderer struct {
	mu      sync.Mutex
	browser context.Context
	stop    context.CancelFunc
	slots   chan struct{}
}

func New() *Renderer { return &Renderer{slots: make(chan struct{}, 2)} }

func (r *Renderer) browserContext() (context.Context, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.browser != nil {
		browser := chromedp.FromContext(r.browser).Browser
		if browser != nil {
			select {
			case <-browser.LostConnection:
				r.stop()
				r.browser = nil
			default:
				return r.browser, nil
			}
		}
	}
	options := append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...)
	options = append(options, chromedp.Flag("disable-dev-shm-usage", true))
	if os.Getuid() == 0 {
		options = append(options, chromedp.NoSandbox)
	}
	if executable := strings.TrimSpace(os.Getenv("AIVORY_PDF_CHROME_PATH")); executable != "" {
		options = append(options, chromedp.ExecPath(executable))
	}
	allocator, stopAllocator := chromedp.NewExecAllocator(context.Background(), options...)
	browser, stopBrowser := chromedp.NewContext(allocator)
	if err := chromedp.Run(browser); err != nil {
		stopBrowser()
		stopAllocator()
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	r.browser = browser
	r.stop = func() { stopBrowser(); stopAllocator() }
	return browser, nil
}

func (r *Renderer) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stop != nil {
		r.stop()
	}
	r.browser = nil
}

func (r *Renderer) Render(ctx context.Context, html string) ([]byte, error) {
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	default:
		return nil, ErrBusy
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	browser, err := r.browserContext()
	if err != nil {
		return nil, err
	}
	// Explicitly create the first window: modern Chromium rejects an explicit
	// newWindow:false for the first target in a fresh browser context.
	var contextID cdp.BrowserContextID
	var targetID target.ID
	err = chromedp.Run(browser, chromedp.ActionFunc(func(ctx context.Context) error {
		executor := cdp.WithExecutor(ctx, chromedp.FromContext(ctx).Browser)
		var err error
		contextID, err = target.CreateBrowserContext().WithDisposeOnDetach(true).Do(executor)
		if err != nil {
			return err
		}
		targetID, err = target.CreateTarget("about:blank").WithBrowserContextID(contextID).WithNewWindow(true).Do(executor)
		return err
	}))
	if contextID != "" {
		defer func() {
			cleanup, cancel := context.WithTimeout(browser, 3*time.Second)
			defer cancel()
			_ = target.DisposeBrowserContext(contextID).Do(cdp.WithExecutor(cleanup, chromedp.FromContext(browser).Browser))
		}()
	}
	if err != nil {
		return nil, err
	}
	tab, closeTab := chromedp.NewContext(browser, chromedp.WithTargetID(targetID))
	defer closeTab()
	tab, cancel := context.WithTimeout(tab, 40*time.Second)
	defer cancel()
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	// The first CSP is authoritative even if submitted HTML contains another
	// document/head/meta. Scripts and all network/file fetches are disabled too.
	policy := `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'">`
	var output []byte
	err = chromedp.Run(tab,
		network.Enable(),
		network.SetBlockedURLs([]string{"http://*", "https://*", "file://*", "ftp://*", "ws://*", "wss://*"}),
		emulation.SetScriptExecutionDisabled(true),
		chromedp.Navigate("about:blank"),
		chromedp.ActionFunc(func(ctx context.Context) error {
			tree, err := page.GetFrameTree().Do(ctx)
			if err != nil {
				return err
			}
			return page.SetDocumentContent(tree.Frame.ID, policy+html).Do(ctx)
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			_, exception, err := runtime.Evaluate(`Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode().catch(() => {}))]).then(() => true)`).WithAwaitPromise(true).Do(ctx)
			if err != nil {
				return err
			}
			if exception != nil {
				return fmt.Errorf("PDF resource preparation: %s", exception.Text)
			}
			return nil
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			var err error
			output, _, err = page.PrintToPDF().WithPrintBackground(true).WithPaperWidth(8.2677).WithPaperHeight(11.6929).
				WithMarginTop(.55).WithMarginBottom(.55).WithMarginLeft(.55).WithMarginRight(.55).
				WithDisplayHeaderFooter(true).WithHeaderTemplate("<span></span>").
				WithFooterTemplate(`<div style="font-size:9px;color:#777;width:100%;text-align:center">Aivory · <span class="pageNumber"></span> / <span class="totalPages"></span></div>`).Do(ctx)
			return err
		}),
	)
	if err != nil {
		return nil, err
	}
	if len(output) > 32*1024*1024 {
		return nil, errors.New("PDF output exceeds size limit")
	}
	return output, nil
}

package web

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"time"
)

func Serve(ctx context.Context, assets fs.FS, data []byte, browser bool, stdout, stderr io.Writer) error {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	host := listener.Addr().String()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host {
			http.Error(w, "Invalid host", http.StatusForbidden)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			w.Header().Set("Allow", "GET, HEAD")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		var b []byte
		var err error
		var mime string
		switch r.URL.Path {
		case "/snapshot.json":
			b = data
			mime = "application/json"
		case "/", "/index.html":
			b, err = fs.ReadFile(assets, "index.html")
			mime = "text/html"
		case "/main.js":
			b, err = fs.ReadFile(assets, "main.js")
			mime = "text/javascript"
		case "/style.css":
			b, err = fs.ReadFile(assets, "style.css")
			mime = "text/css"
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, "Missing viewer asset", 500)
			return
		}
		w.Header().Set("Content-Type", mime+"; charset=utf-8")
		if r.Method != "HEAD" {
			_, _ = w.Write(b)
		}
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	defer server.Close()
	url := "http://" + host + "/?source=cli"
	fmt.Fprintln(stdout, url)
	if browser {
		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "darwin":
			cmd = exec.Command("open", url)
		case "windows":
			cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
		default:
			cmd = exec.Command("xdg-open", url)
		}
		go func() {
			if cmd.Run() != nil {
				fmt.Fprintln(stderr, "Open the printed URL in your browser.")
			}
		}()
	}
	select {
	case <-ctx.Done():
		return nil
	case err := <-done:
		return err
	}
}

"""
The decision sidecar: GLiNER2.5-Decide behind a tiny local HTTP server.

Embedded in the obrew binary (src/decide/sidecar.ts imports this file as text) and written to
<data>/decide/server.py by `obrew decide install`. obrew starts it DETACHED, so it has no
console and no stdio of ours: everything it prints goes to --log-file.

Contract, mirroring llama-server's where obrew already knows how to read it:
  GET  /health     200 when the model is loaded, 503 while it loads
  POST /classify   {"texts": [...], "tasks": {...}, "threshold"?}  -> {"results": [...], "ms"}
  POST /extract    {"texts": [...], "structures": {...}, "threshold"?} -> {"results": [...], "ms"}
  POST /shutdown   exits

`tasks` and `structures` are passed to GLiNER2's batch_classify_text / batch_extract_json
unchanged, so their shapes are GLiNER2's own. Results always carry confidences.

One request at a time, on purpose: a plain HTTPServer (not Threading) serializes model access,
and a laptop has one CPU's worth of it. The process exits by itself after --idle-ms without a
request, so a host that is killed never leaves it running for long.
"""
import argparse
import json
import os
import sys
import threading
import time
import traceback
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer

warnings.filterwarnings("ignore")

state = {"model": None, "error": None, "last": time.monotonic()}
lock = threading.Lock()


def log(msg):
    print(f"[decide] {time.strftime('%H:%M:%S')} {msg}", flush=True)


def load(model_id, device):
    from gliner2 import AutoExtractor

    started = time.monotonic()
    model = AutoExtractor.from_pretrained(model_id)
    if device == "cuda":
        import torch

        if torch.cuda.is_available():
            model = model.to("cuda")
        else:
            log("cuda requested but unavailable; staying on cpu")
    model.eval()
    log(f"loaded {model_id} in {(time.monotonic() - started) * 1000:.0f}ms")
    return model


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet: obrew's log is for failures and timings
        pass

    def reply(self, status, body):
        data = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not found"})
        if state["model"] is not None:
            return self.reply(200, {"status": "ok"})
        if state["error"]:
            return self.reply(500, {"status": "error", "error": state["error"]})
        return self.reply(503, {"status": "loading"})

    def do_POST(self):
        state["last"] = time.monotonic()
        if self.path == "/shutdown":
            self.reply(200, {"status": "bye"})
            log("shutdown requested")
            os._exit(0)
        if self.path not in ("/classify", "/extract"):
            return self.reply(404, {"error": "not found"})
        model = state["model"]
        if model is None:
            return self.reply(503, {"error": "model is still loading"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
            texts = req.get("texts")
            if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
                return self.reply(400, {"error": "texts must be a non-empty list of strings"})
            key = "tasks" if self.path == "/classify" else "structures"
            spec = req.get(key)
            if not isinstance(spec, dict) or not spec:
                return self.reply(400, {"error": f"{key} must be a non-empty object"})
            threshold = float(req.get("threshold", 0.5))
            started = time.monotonic()
            with lock:
                if self.path == "/classify":
                    results = model.batch_classify_text(texts, spec, threshold=threshold, include_confidence=True)
                else:
                    results = model.batch_extract_json(texts, spec, threshold=threshold, include_confidence=True)
            ms = round((time.monotonic() - started) * 1000)
            log(f"{self.path} {len(texts)} text(s), {len(spec)} head(s): {ms}ms")
            state["last"] = time.monotonic()
            return self.reply(200, {"results": results, "ms": ms})
        except Exception as e:  # noqa: BLE001 - every failure is the caller's 500, with the trace in the log
            log(f"{self.path} failed: {type(e).__name__}: {e}\n{traceback.format_exc()}")
            return self.reply(500, {"error": f"{type(e).__name__}: {e}"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--idle-ms", type=int, default=3_600_000)
    ap.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    ap.add_argument("--log-file")
    ap.add_argument("--prefetch", action="store_true", help="download and load the model, then exit")
    args = ap.parse_args()

    if args.log_file:
        stream = open(args.log_file, "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = stream

    if args.prefetch:
        load(args.model, "cpu")
        return 0

    # Bind BEFORE loading, so /health can say "loading" instead of refusing connections.
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    log(f"listening on 127.0.0.1:{server.server_address[1]} (pid {os.getpid()})")

    def loader():
        try:
            state["model"] = load(args.model, args.device)
        except Exception as e:  # noqa: BLE001
            state["error"] = f"{type(e).__name__}: {e}"
            log(f"load failed: {state['error']}\n{traceback.format_exc()}")
            os._exit(1)

    def watchdog():
        while True:
            time.sleep(5)
            if time.monotonic() - state["last"] > args.idle_ms / 1000:
                log(f"idle for {args.idle_ms}ms; exiting")
                os._exit(0)

    threading.Thread(target=loader, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())

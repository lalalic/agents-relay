"""Disposable localhost fake Relay Dashboard for original Node/Rust CLI tests."""
import http.server
import json
import sys
import urllib.parse

log = sys.argv[1]


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def run(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode() if length else ""
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        record = {
            "method": self.command,
            "path": parsed.path,
            "query": query,
            "body": json.loads(body) if body else None,
        }
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n")
        code = 200
        result = record
        if query.get("id") == ["fail"] or (
            isinstance(record["body"], dict) and record["body"].get("action") == "fail"
        ):
            code, result = 409, "Graph rejected"
        elif query.get("id") == ["empty"] or (
            isinstance(record["body"], dict) and record["body"].get("action") == "empty"
        ):
            code, result = 422, ""
        elif parsed.path == "/api/jobs":
            repo = query.get("repo", [""])[0]
            jobs = [
                {"id": "3", "repository": "alpha", "title": "one"},
                {"id": "4", "repository": "beta", "title": "two"},
            ]
            if repo == "invalid":
                result = {"jobs": [{"id": 5, "repository": "alpha"}]}
            elif repo == "array":
                result = jobs
            elif repo == "error":
                code, result = 403, "Denied"
            else:
                result = {"jobs": jobs}
        payload = (
            result.encode("utf8")
            if isinstance(result, str)
            else json.dumps(result, ensure_ascii=False).encode("utf8")
        )
        self.send_response(code)
        self.send_header(
            "content-type",
            "text/plain" if isinstance(result, str) else "application/json",
        )
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.run()

    def do_POST(self):
        self.run()


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()

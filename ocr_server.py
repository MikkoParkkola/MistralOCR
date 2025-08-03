"""Simple HTTP server exposing Mistral OCR via /ocr endpoint."""

import base64
import tempfile
from pathlib import Path
import importlib.util
import sys
import argparse
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS

# Dynamically import the existing mistral-ocr.py as a module
MODULE_PATH = Path(__file__).resolve().parent / "mistral-ocr.py"
spec = importlib.util.spec_from_file_location("mocr", MODULE_PATH)
mocr = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mocr
assert spec.loader
spec.loader.exec_module(mocr)

parser = argparse.ArgumentParser(description="Mistral OCR server")
parser.add_argument("--debug", action="store_true", help="Enable debug logging")
args, _ = parser.parse_known_args()

app = Flask(__name__)
CORS(app)

if args.debug:
    logging.basicConfig(level=logging.DEBUG)
    app.logger.setLevel(logging.DEBUG)

@app.post("/ocr")
def ocr():
    data = request.get_json(force=True)
    image = data.get("image")
    file_data = data.get("file")
    # Accept API key via JSON or either Authorization or X-API-Key headers
    api_key = data.get("api_key") or request.headers.get("X-API-Key")
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        api_key = auth_header[7:]
    if args.debug:
        masked = (api_key[:4] + "...") if api_key else "None"
        app.logger.debug("OCR request headers: %s", dict(request.headers))
        app.logger.debug("API key provided: %s", masked)
    data_url = image or file_data
    if not data_url or not api_key:
        return jsonify({"error": "file/image and api_key required"}), 400
    header, encoded = data_url.split(",", 1) if "," in data_url else ("", data_url)
    suffix = ".bin"
    if ";base64" in header and "/" in header:
        mime = header.split(":", 1)[1].split(";", 1)[0]
        ext = mocr.mimetypes.guess_extension(mime) or ".bin"
        suffix = ext
    fd, temp_path = tempfile.mkstemp(suffix=suffix)
    Path(temp_path).write_bytes(base64.b64decode(encoded))
    text, tokens, cost = mocr.extract_text(Path(temp_path), api_key)
    Path(temp_path).unlink(missing_ok=True)
    return jsonify({"markdown": text, "tokens": tokens, "cost": cost})


@app.get("/health")
def health():
    if args.debug:
        app.logger.debug("Health check")
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=args.debug)

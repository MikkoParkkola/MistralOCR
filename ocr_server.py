"""Simple HTTP server exposing Mistral OCR via /ocr endpoint."""

import base64
import tempfile
from pathlib import Path
import importlib.util
import sys
from flask import Flask, request, jsonify
from flask_cors import CORS

# Dynamically import the existing mistral-ocr.py as a module
MODULE_PATH = Path(__file__).resolve().parent / "mistral-ocr.py"
spec = importlib.util.spec_from_file_location("mocr", MODULE_PATH)
mocr = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mocr
assert spec.loader
spec.loader.exec_module(mocr)

app = Flask(__name__)
CORS(app)

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
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)

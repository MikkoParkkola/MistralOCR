"""Simple HTTP server exposing Mistral OCR via /ocr endpoint."""

import base64
import tempfile
from pathlib import Path
import importlib.util
import sys
import argparse
import logging
import time

try:  # pragma: no cover - optional dependency
    import requests  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - fallback when requests isn't installed
    _compat_path = Path(__file__).with_name("compat_requests.py")
    _spec = importlib.util.spec_from_file_location("compat_requests", _compat_path)
    compat_requests = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = compat_requests
    assert _spec.loader
    _spec.loader.exec_module(compat_requests)  # type: ignore
    requests = compat_requests  # type: ignore

try:  # pragma: no cover - optional dependency
    from flask import Flask, request, jsonify  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - allow import without flask
    Flask = None  # type: ignore[assignment]
    request = None  # type: ignore[assignment]

    def jsonify(obj):  # type: ignore[override]
        raise ModuleNotFoundError("flask not installed")

# ``flask_cors`` is optional.  In some environments it rejects the
# ``chrome-extension://`` origin used by the browser extension which results
# in confusing 403 responses.  To keep behaviour consistent we do not depend
# on its origin checks and instead add the CORS headers manually further
# below.  Importing here is only for backward compatibility when the package
# is installed; failure to import is harmless.
try:  # pragma: no cover - optional dependency
    from flask_cors import CORS  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    CORS = None  # type: ignore[assignment]

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

app = Flask(__name__) if Flask is not None else None
if Flask is not None:
    if args.debug:
        logging.basicConfig(level=logging.DEBUG, format="mistralocr: %(message)s")
    else:
        logging.basicConfig(level=logging.INFO, format="mistralocr: %(message)s")
    app.logger.setLevel(logging.getLogger().level)

    # Add very permissive CORS headers so the browser extension can talk to
    # the server regardless of its origin.  This replaces the behaviour of
    # ``flask_cors`` which can reject unknown schemes such as
    # ``chrome-extension://``.
    @app.after_request
    def _add_cors_headers(resp):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = (
            "Authorization,Content-Type,X-API-Key"
        )
        resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        return resp

    @app.before_request
    def _handle_options():
        if request.method == "OPTIONS":
            # A minimal response is enough for browsers to continue the
            # request.  Headers are added by ``_add_cors_headers`` above.
            return "", 204

    def _get_api_key(data: dict | None = None) -> str | None:
        """Extract API key from JSON payload or headers.

        The browser extension may send the key via JSON body, the
        ``Authorization`` header or the legacy ``X-API-Key`` header.  This
        helper consolidates the logic so all endpoints behave consistently.
        """

        if data and (key := data.get("api_key")):
            return key
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            return auth_header[7:]
        return request.headers.get("X-API-Key")

    def _build_upstream_headers(api_key: str) -> dict[str, str]:
        """Return headers forwarded to the Mistral API.

        The browser extension sends additional headers such as ``Origin`` and
        ``Referer`` when talking to the upstream API directly.  Some endpoints
        expect these headers to be present, so the middleware mirrors them when
        proxying requests.
        """

        headers = {
            "Authorization": f"Bearer {api_key}",
            "X-API-Key": api_key,
            # Some upstream endpoints reject requests without these headers
            # even if the API key is valid.  When the browser extension calls
            # the middleware from a background context it may omit them, so we
            # provide sensible defaults that resemble the direct extension
            # requests.
            "Origin": request.headers.get("Origin")
            or "chrome-extension://mistral-ocr",
            "Referer": request.headers.get("Referer")
            or "chrome-extension://mistral-ocr",
            "User-Agent": request.headers.get("User-Agent")
            or "MistralOCR/1.0",
        }
        return headers

if app is not None:
    @app.post("/ocr")
    def ocr():
        data = request.get_json(force=True)
        image = data.get("image")
        file_data = data.get("file")
        model = data.get("model")
        language = data.get("language")
        output_format = data.get("format", "markdown")
        api_key = _get_api_key(data)
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
        try:
            text, tokens, cost = _extract_with_retry(
                Path(temp_path),
                api_key,
                model=model,
                language=language,
                output_format=output_format,
            )
        except mocr.OCRException as exc:
            app.logger.error("OCR failed: %s", exc)
            status = 401 if "401" in str(exc) else 403 if "403" in str(exc) else 502
            return jsonify({"error": str(exc)}), status
        except Exception as exc:  # pragma: no cover - unexpected
            app.logger.exception("Unexpected OCR failure: %s", exc)
            return jsonify({"error": "internal error"}), 500
        finally:
            Path(temp_path).unlink(missing_ok=True)
        resp = {"text": text, "tokens": tokens, "cost": cost}
        if output_format == "markdown":
            resp["markdown"] = text
        return jsonify(resp)

    @app.get("/health")
    def health():
        api_key = _get_api_key()
        masked = (api_key[:4] + "...") if api_key else "None"
        app.logger.info("Health check, api key: %s", masked)
        if not api_key:
            return jsonify({"status": "missing api key"}), 401
        headers = _build_upstream_headers(api_key)
        try:
            resp = requests.get(
                "https://api.mistral.ai/v1/models", headers=headers, timeout=5
            )
            snippet = resp.text[:200]
            app.logger.info(
                "Health upstream response: %s %s", resp.status_code, snippet
            )
            if resp.status_code == 200:
                return jsonify({"status": "ok"})
            app.logger.error(
                "Health upstream failure: %s %s", resp.status_code, snippet
            )
            return jsonify({"status": "unauthorized"}), resp.status_code
        except Exception as exc:  # pragma: no cover - network issues
            app.logger.error("Health check error: %s", exc)
            return jsonify({"status": "upstream error"}), 502

    @app.route("/v1/<path:path>", methods=["GET", "POST"])
    def proxy_v1(path: str):
        """Forward /v1/* requests to the official Mistral API.

        Propagates Authorization and X-API-Key headers from the client and logs
        the upstream response when running with --debug to aid troubleshooting.
        """
        api_key = _get_api_key()
        if not api_key:
            return jsonify({"error": "missing api key"}), 401
        headers = _build_upstream_headers(api_key)
        url = f"https://api.mistral.ai/v1/{path}"
        try:
            if request.method == "GET":
                upstream = requests.get(url, headers=headers, timeout=10)
            else:
                upstream = requests.post(
                    url, data=request.get_data(), headers=headers, timeout=10
                )
            masked = (api_key[:4] + "...") if api_key else "None"
            snippet = upstream.text[:200]
            app.logger.info(
                "Proxy %s %s key=%s status=%s body=%s",
                request.method,
                url,
                masked,
                upstream.status_code,
                snippet,
            )
            return (
                upstream.content,
                upstream.status_code,
                {k: v for k, v in upstream.headers.items()},
            )
        except Exception as exc:  # pragma: no cover - network issues
            app.logger.error("Proxy error: %s", exc)
            return jsonify({"error": "upstream error"}), 502
else:
    def ocr():  # type: ignore
        raise ModuleNotFoundError("flask not installed")
    def health():  # type: ignore
        raise ModuleNotFoundError("flask not installed")


def _extract_with_retry(
    path: Path,
    api_key: str,
    *,
    model: str | None = None,
    language: str | None = None,
    output_format: str = "markdown",
    retries: int = 2,
    backoff: float = 1.0,
):
    for attempt in range(retries + 1):
        try:
            if args.debug:
                app.logger.debug(
                    "Attempt %d: extract_text path=%s model=%s language=%s format=%s",
                    attempt + 1,
                    path,
                    model or mocr.DEFAULT_MODEL,
                    language,
                    output_format,
                )
            return mocr.extract_text(
                path,
                api_key,
                output_format=output_format,
                model=model or mocr.DEFAULT_MODEL,
                language=language,
            )
        except mocr.OCRException as exc:
            if args.debug:
                app.logger.debug("Attempt %d error: %s", attempt + 1, exc)
            if "401" in str(exc) or "403" in str(exc) or attempt == retries:
                raise
            app.logger.warning("OCR attempt %d failed: %s", attempt + 1, exc)
            time.sleep(backoff * 2 ** attempt)

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=args.debug)

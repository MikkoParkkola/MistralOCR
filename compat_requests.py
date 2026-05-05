import json as _json
from urllib import error as _error
from urllib import request as _request
from urllib.parse import urlparse


class RequestException(Exception):
    """Exception raised for network errors in compat_requests."""


class Response:
    """Minimal response object with requests-like interface."""

    def __init__(self, status, body, headers):
        self.status_code = status
        self._body = body
        self.headers = headers

    @property
    def text(self):
        return self._body.decode("utf-8")

    def json(self):
        return _json.loads(self.text)


def _do_request(
    method: str, url: str, *, headers=None, data=None, timeout=60
) -> Response:
    # Security: Only allow http and https schemes
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise RequestException(f"Unsupported URL scheme: {parsed.scheme}")

    req = _request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with _request.urlopen(req, timeout=timeout) as resp:  # nosec B310
            return Response(resp.getcode(), resp.read(), resp.headers)
    except _error.URLError as exc:  # pragma: no cover - network failure
        raise RequestException(str(exc)) from exc


def post(url: str, headers=None, json=None, timeout: float = 60) -> Response:
    hdrs = dict(headers or {})
    data = None
    if json is not None:
        data = _json.dumps(json).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    return _do_request("POST", url, headers=hdrs, data=data, timeout=timeout)


def get(url: str, headers=None, timeout: float = 60) -> Response:
    return _do_request("GET", url, headers=headers, data=None, timeout=timeout)

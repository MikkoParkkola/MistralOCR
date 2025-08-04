import pytest
import importlib.util
import sys
from pathlib import Path

# Import the server module without requiring it to be on PYTHONPATH.
MODULE_PATH = Path(__file__).resolve().parents[1] / "ocr_server.py"
spec = importlib.util.spec_from_file_location("ocr_server", MODULE_PATH)
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
assert spec.loader
spec.loader.exec_module(server)

pytestmark = pytest.mark.skipif(server.app is None, reason="Flask not installed")


def test_health_allows_extension_origin():
    client = server.app.test_client()
    resp = client.get('/health', headers={'Origin': 'chrome-extension://abc'})
    # Missing API key should yield 401 but still include permissive CORS headers
    assert resp.status_code == 401
    assert resp.headers.get('Access-Control-Allow-Origin') == '*'
    allow_headers = resp.headers.get('Access-Control-Allow-Headers', '')
    assert 'Authorization' in allow_headers
    assert 'X-API-Key' in allow_headers


def test_health_forwards_origin_header(monkeypatch):
    captured = {}

    def fake_get(url, headers, timeout, proxies):
        captured['headers'] = headers
        class Resp:
            status_code = 200
            text = 'ok'
        return Resp()

    monkeypatch.setattr(server.requests, 'get', fake_get)
    client = server.app.test_client()
    origin = 'chrome-extension://abc'
    resp = client.get(
        '/health',
        headers={
            'Authorization': 'Bearer test',
            'X-API-Key': 'test',
            'Origin': origin,
            'Referer': origin,
        },
    )
    assert resp.status_code == 200
    assert captured['headers']['Origin'] == origin
    assert captured['headers']['Referer'] == origin


def test_health_omits_unsupplied_headers(monkeypatch):
    captured = {}

    def fake_get(url, headers, timeout, proxies):
        captured['headers'] = headers
        class Resp:
            status_code = 200
            text = 'ok'
        return Resp()

    monkeypatch.setattr(server.requests, 'get', fake_get)
    client = server.app.test_client()
    resp = client.get(
        '/health',
        headers={'Authorization': 'Bearer test', 'X-API-Key': 'test'},
    )
    assert resp.status_code == 200
    assert 'Origin' not in captured['headers']
    assert 'Referer' not in captured['headers']
    assert 'User-Agent' not in captured['headers']


def test_health_disables_system_proxies(monkeypatch):
    called = {}

    def fake_get(url, headers, timeout, proxies):
        called['proxies'] = proxies
        class Resp:
            status_code = 200
            text = 'ok'
        return Resp()

    monkeypatch.setattr(server.requests, 'get', fake_get)
    client = server.app.test_client()
    resp = client.get(
        '/health',
        headers={'Authorization': 'Bearer test', 'X-API-Key': 'test'},
    )
    assert resp.status_code == 200
    assert called['proxies'] == {}


def test_options_preflight_returns_cors_headers():
    client = server.app.test_client()
    resp = client.options('/health', headers={'Origin': 'chrome-extension://abc'})
    assert resp.status_code == 204
    assert resp.headers.get('Access-Control-Allow-Origin') == '*'
    allow_headers = resp.headers.get('Access-Control-Allow-Headers', '')
    assert 'Authorization' in allow_headers
    assert 'X-API-Key' in allow_headers

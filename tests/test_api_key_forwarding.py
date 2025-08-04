import importlib.util
import sys
from pathlib import Path
import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / 'ocr_server.py'
spec = importlib.util.spec_from_file_location('ocr_server', MODULE_PATH)
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
assert spec.loader
spec.loader.exec_module(server)

pytestmark = pytest.mark.skipif(server.app is None, reason="Flask not installed")

def test_api_key_whitespace_is_trimmed(monkeypatch):
    captured = {}

    def fake_get(url, headers, timeout, proxies):
        captured['headers'] = headers
        class Resp:
            status_code = 200
            text = 'ok'
        return Resp()

    monkeypatch.setattr(server.requests, 'get', fake_get)
    client = server.app.test_client()
    resp = client.get('/health', headers={'Authorization': 'Bearer   test  '})
    assert resp.status_code == 200
    assert captured['headers']['Authorization'] == 'Bearer test'
    assert captured['headers']['X-API-Key'] == 'test'

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

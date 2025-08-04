import pytest
import importlib.util
import sys
from pathlib import Path

# Import server module
MODULE_PATH = Path(__file__).resolve().parents[1] / "ocr_server.py"
spec = importlib.util.spec_from_file_location("ocr_server", MODULE_PATH)
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
assert spec.loader
spec.loader.exec_module(server)

pytestmark = pytest.mark.skipif(server.app is None, reason="Flask not installed")


def test_proxy_missing_api_key_returns_401():
    client = server.app.test_client()
    resp = client.get('/v1/models')
    assert resp.status_code == 401
    assert resp.get_json()['error'] == 'missing api key'
    assert resp.headers.get('Access-Control-Allow-Origin') == '*'

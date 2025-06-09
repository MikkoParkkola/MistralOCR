import base64
from pathlib import Path
import importlib.util
import types
import sys

MODULE_PATH = Path(__file__).resolve().parents[1] / "mistral-ocr.py"
spec = importlib.util.spec_from_file_location("mocr", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
assert spec.loader
spec.loader.exec_module(mod)


def test_extract_text_payload(monkeypatch, tmp_path):
    file = tmp_path / "doc.pdf"
    data = b"data"
    file.write_bytes(data)
    captured = {}

    class Resp:
        status_code = 200
        def json(self):
            return {"text": "t", "usage": {"total_tokens": 1}, "cost": 0.0}

    def fake_post(url, headers=None, json=None, timeout=60):
        captured['payload'] = json
        return Resp()

    monkeypatch.setattr(mod.requests, 'post', fake_post)
    mod.extract_text(file, 'k')
    doc = captured['payload']['document']
    assert doc['file'] == base64.b64encode(data).decode()
    assert doc['mime_type'] == 'application/pdf'

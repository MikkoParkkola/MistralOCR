import base64
import json
from pathlib import Path
import importlib.util
import types
import sys
import pytest

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
    assert doc['type'] == 'document_url'
    assert doc['document_url'].startswith('data:application/pdf;base64,')
    assert doc['document_url'].endswith(base64.b64encode(data).decode())
    assert captured['payload']['model'] == mod.DEFAULT_MODEL


def test_extract_text_error_truncated(monkeypatch, tmp_path):
    file = tmp_path / "doc.pdf"
    file.write_bytes(b"data")
    encoded = base64.b64encode(b"data").decode()

    payload = {
        "error": "bad",
        "document": {
            "type": "document_url",
            "document_url": f"data:application/pdf;base64,{encoded}",
        },
    }

    class Resp:
        status_code = 400
        text = json.dumps(payload)

        def json(self):
            return payload

    monkeypatch.setattr(mod.requests, "post", lambda *a, **kw: Resp())
    with pytest.raises(mod.OCRException) as exc:
        mod.extract_text(file, "k")
    msg = str(exc.value)
    assert encoded not in msg
    assert msg.startswith("API error: 400")


def test_extract_text_error_nested(monkeypatch, tmp_path):
    file = tmp_path / "doc.pdf"
    file.write_bytes(b"data")
    encoded = base64.b64encode(b"data").decode()

    payload = {
        "detail": [
            {
                "type": "missing",
                "loc": ["body", "document"],
                "msg": "Field required",
                "input": {
                    "type": "document_url",
                    "document_url": f"data:application/pdf;base64,{encoded}",
                },
            }
        ]
    }

    class Resp:
        status_code = 422
        text = json.dumps(payload)

        def json(self):
            return payload

    monkeypatch.setattr(mod.requests, "post", lambda *a, **kw: Resp())
    with pytest.raises(mod.OCRException) as exc:
        mod.extract_text(file, "k")
    msg = str(exc.value)
    assert encoded not in msg
    assert "body.document: Field required" in msg


def test_extract_text_error_message_detail(monkeypatch, tmp_path):
    file = tmp_path / "doc.pdf"
    file.write_bytes(b"data")
    encoded = base64.b64encode(b"data").decode()

    payload = {
        "object": "error",
        "message": {
            "detail": [
                {
                    "type": "missing",
                    "loc": ["body", "document"],
                    "msg": "Field required",
                    "input": {
                        "document_url": f"data:application/pdf;base64,{encoded}"
                    },
                }
            ]
        },
    }

    class Resp:
        status_code = 422
        text = json.dumps(payload)

        def json(self):
            return payload

    monkeypatch.setattr(mod.requests, "post", lambda *a, **kw: Resp())
    with pytest.raises(mod.OCRException) as exc:
        mod.extract_text(file, "k")
    msg = str(exc.value)
    assert encoded not in msg
    assert "body.document: Field required" in msg

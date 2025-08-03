import base64
import json
from pathlib import Path
import importlib.util
import types
import sys
import pytest
import logging

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
        text = "{}"

        def json(self):
            return {
                "pages": [
                    {
                        "index": 0,
                        "markdown": "t",
                        "images": [],
                        "dimensions": None,
                    }
                ],
                "model": mod.DEFAULT_MODEL,
                "usage_info": {"pages_processed": 1},
            }

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


def test_extract_logs_full_exchange(monkeypatch, tmp_path, caplog):
    file = tmp_path / "doc.pdf"
    file.write_bytes(b"data")

    class Resp:
        status_code = 403
        text = "unauthorized"

        def json(self):
            return {"error": "unauthorized"}

        @property
        def headers(self):
            return {"x": "y"}

    def fake_post(url, headers=None, json=None, timeout=60):
        return Resp()

    monkeypatch.setattr(mod.requests, "post", fake_post)
    caplog.set_level(logging.DEBUG)
    with pytest.raises(mod.OCRException):
        mod.extract_text(file, "badkey")
    joined = "\n".join(caplog.messages)
    assert "Preparing request for" in joined
    assert "Using API key: badk" in joined
    assert "POST https://api.mistral.ai/v1/ocr" in joined
    assert "Response status: 403" in joined

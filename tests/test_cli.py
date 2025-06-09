from pathlib import Path
import importlib.util
import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "mistral-ocr.py"
spec = importlib.util.spec_from_file_location("mocr", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = mod
assert spec.loader  # for type checkers
spec.loader.exec_module(mod)
parse_args = mod.parse_args
main = mod.main
Config = mod.Config


def test_parse_args():
    ns = parse_args(["*.pdf", "--output-format", "text", "--model", "m"])
    assert ns.patterns == ["*.pdf"]
    assert ns.output_format == "text"
    assert ns.model == "m"


def test_parse_args_default(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["prog", "file.pdf"])
    ns = parse_args(None)
    assert ns.patterns == ["file.pdf"]
    assert ns.model is None


def test_main_success(tmp_path: Path, monkeypatch):
    # create dummy file
    file = tmp_path / "doc.pdf"
    file.write_bytes(b"data")

    def mock_extract(*a, **kw):
        return "content", 10, 0.02

    monkeypatch.setattr(mod, "extract_text", mock_extract)
    monkeypatch.setattr(mod, "CONFIG_PATH", tmp_path / "cfg")
    monkeypatch.setattr(mod, "ensure_config_template", lambda path: None)
    monkeypatch.setattr(mod, "load_config", lambda path: Config(api_key=""))

    rc = main(["--api-key", "k", str(file)])
    assert rc == 0
    out_file = file.with_suffix(".md")
    assert out_file.exists()
    assert out_file.read_text() == "content"

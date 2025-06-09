from pathlib import Path
import configparser
import importlib.util

MODULE_PATH = Path(__file__).resolve().parents[1] / "mistral-ocr.py"
spec = importlib.util.spec_from_file_location("mocr", MODULE_PATH)
cfg = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = cfg
assert spec.loader
spec.loader.exec_module(cfg)


def test_load_and_save_config(tmp_path: Path) -> None:
    path = tmp_path / "conf.cfg"
    c = cfg.Config(api_key="KEY", output_format="text", language="en", model="m")
    cfg.save_config(c, path)

    loaded = cfg.load_config(path)
    assert loaded.api_key == "KEY"
    assert loaded.output_format == "text"
    assert loaded.language == "en"
    assert loaded.model == "m"


def test_ensure_config_template(tmp_path: Path) -> None:
    path = tmp_path / "conf.cfg"
    cfg.ensure_config_template(path)
    assert path.exists()
    parser = configparser.ConfigParser()
    parser.read(path)
    assert parser.has_section("mistral")
    assert parser.get("mistral", "api_key") == ""
    assert "model" in parser["mistral"]

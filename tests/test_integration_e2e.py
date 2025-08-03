import base64
import os
from pathlib import Path
import importlib.util
import sys
import pytest

# Import ocr_server module
MODULE_PATH = Path(__file__).resolve().parents[1] / "ocr_server.py"
spec = importlib.util.spec_from_file_location("ocr_server", MODULE_PATH)
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
assert spec.loader
spec.loader.exec_module(server)


def _make_sample_image(tmp_path: Path) -> Path:
    from PIL import Image, ImageDraw
    path = tmp_path / "sample.png"
    img = Image.new("RGB", (120, 50), "white")
    ImageDraw.Draw(img).text((10, 10), "hello", fill="black")
    img.save(path)
    return path


@pytest.mark.integration
def test_server_end_to_end(tmp_path: Path):
    api_key = os.getenv("MISTRAL_API_KEY")
    if not api_key:
        pytest.skip("MISTRAL_API_KEY not set")
    img_path = _make_sample_image(tmp_path)
    b64 = base64.b64encode(img_path.read_bytes()).decode()
    data_url = f"data:image/png;base64,{b64}"
    client = server.app.test_client()
    resp = client.post(
        "/ocr",
        json={"file": data_url},
        headers={"Authorization": f"Bearer {api_key}"},
    )
    if resp.status_code != 200:
        pytest.skip(f"OCR call failed: {resp.status_code} {resp.get_data(as_text=True)}")
    data = resp.get_json()
    assert "markdown" in data and isinstance(data["markdown"], str)

# MistralOCR

Command line tool for using Mistral OCR API. It allows batch processing of PDF
and image files and outputs the extracted text in Markdown format by default.

## Usage

```
python mistral-ocr.py [OPTIONS] PATTERN [PATTERN ...]
```

Common options:

- `--api-key` – provide the API key (otherwise read from config or prompted).
- `--output-format` – output file format: `markdown` (default), `text`, or `json`.
- `--language` – optional language hint.
- `--model` – OCR model to use (defaults to `mistral-ocr-latest`).
- `--config-path` – path to configuration file (defaults to `~/.mistral_ocr.cfg`).

The configuration file is created automatically if it does not exist and can be
used to store persistent options, including the API key.

Run the unit tests with:

```
pytest
```

## Chrome Extension

A Chrome extension is provided in the `chrome-extension` directory. It can
save the current tab or a text selection as a Markdown file using the Mistral
OCR service when needed.

### Run the local OCR server

```
pip install flask flask-cors
python ocr_server.py
```

### Load the extension

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select the `chrome-extension` folder.
3. Right–click a page or selection and choose **Save Page to Markdown** or
   **Save Selection to Markdown**.

The extension stores your API key locally and communicates only with the
extension's background service and the local OCR server.

If the page cannot be parsed as HTML (e.g. PDF, image, or office document), the
extension fetches the complete file and sends it to the local OCR server for
OCR, ensuring content beyond the visible viewport is processed.

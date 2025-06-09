# MistralOCR

Command line tool for using Mistral OCR API. It allows batch processing of PDF
and image files and outputs the extracted text in Markdown format by default.

## Usage

```
python mistral-ocr.py [OPTIONS] PATTERN [PATTERN ...]
```

Common options:

- `--api-key` – provide the API key (otherwise read from config or prompted).
- `--output-format` – `markdown` (default), `text` or `json`.
- `--language` – optional language hint.
- `--config-path` – path to configuration file (defaults to `~/.mistral_ocr.cfg`).

The configuration file is created automatically if it does not exist and can be
used to store persistent options, including the API key.

Run the unit tests with:

```
pytest
```

"""Single-file Mistral OCR command line tool."""

from __future__ import annotations

import argparse
import configparser
from dataclasses import dataclass
from getpass import getpass
import glob
import base64
import logging
import json
from pathlib import Path
from typing import List, Optional, Tuple
import mimetypes
import requests


# ----------------------------- Configuration -----------------------------

CONFIG_PATH = Path.home() / ".mistral_ocr.cfg"

DEFAULT_MODEL = "mistral-ocr-latest"

CONFIG_TEMPLATE = {
    "api_key": "",
    "output_format": "markdown",
    "language": "",
    "log_level": "INFO",
    "model": DEFAULT_MODEL,
}


@dataclass
class Config:
    api_key: str = ""
    output_format: str = "markdown"
    language: str = ""
    log_level: str = "INFO"
    model: str = DEFAULT_MODEL

    @classmethod
    def from_parser(cls, parser: configparser.ConfigParser) -> "Config":
        defaults = CONFIG_TEMPLATE.copy()
        if parser.has_section("mistral"):
            for key, value in parser["mistral"].items():
                if value:
                    defaults[key] = value
        return cls(**defaults)

    def to_parser(self) -> configparser.ConfigParser:
        parser = configparser.ConfigParser()
        parser["mistral"] = {
            "api_key": self.api_key,
            "output_format": self.output_format,
            "language": self.language,
            "log_level": self.log_level,
            "model": self.model,
        }
        return parser


def load_config(path: Path = CONFIG_PATH) -> Config:
    """Load configuration from *path*."""
    parser = configparser.ConfigParser()
    if path.exists():
        parser.read(path)
    return Config.from_parser(parser)


def save_config(config: Config, path: Path = CONFIG_PATH) -> None:
    """Save *config* to *path*."""
    parser = config.to_parser()
    with open(path, "w", encoding="utf-8") as fh:
        parser.write(fh)


def ensure_config_template(path: Path = CONFIG_PATH) -> None:
    """Create a template configuration file if one doesn't exist."""
    if not path.exists():
        parser = configparser.ConfigParser()
        parser["mistral"] = {k: "" for k in CONFIG_TEMPLATE}
        with open(path, "w", encoding="utf-8") as fh:
            parser.write(fh)


# ----------------------------- OCR API -----------------------------------

API_URL = "https://api.mistral.ai/v1/ocr"


class OCRException(Exception):
    """Raised when the OCR API returns an error."""


def _scrub_files(data: object) -> None:
    """Recursively remove encoded file contents from *data*."""
    if isinstance(data, dict):
        for key in ["file", "document_url", "image_url"]:
            data.pop(key, None)
        for value in data.values():
            _scrub_files(value)
    elif isinstance(data, list):
        for item in data:
            _scrub_files(item)


def _summarize_error(data: object) -> str:
    """Return a short summary for an OCR error payload."""

    def from_detail(detail: list) -> str:
        parts: list[str] = []
        for item in detail:
            if not isinstance(item, dict):
                continue
            msg = item.get("msg")
            loc = item.get("loc")
            loc_str = "".join([str(x) + "." for x in loc])[:-1] if isinstance(loc, list) else ""
            if msg and loc_str:
                parts.append(f"{loc_str}: {msg}")
            elif msg:
                parts.append(str(msg))
        return "; ".join(parts)

    if isinstance(data, dict):
        if isinstance(data.get("detail"), list):
            return from_detail(data["detail"])
        message = data.get("message")
        if isinstance(message, dict) and isinstance(message.get("detail"), list):
            return from_detail(message["detail"])
    return ""


def extract_text(
    file_path: Path,
    api_key: str,
    output_format: str = "markdown",
    language: Optional[str] = None,
    model: str = DEFAULT_MODEL,
) -> Tuple[str, int, float]:
    """Extract text from *file_path* using the Mistral OCR API."""
    headers = {"Authorization": f"Bearer {api_key}"}
    with open(file_path, "rb") as fh:
        encoded = base64.b64encode(fh.read()).decode()


        mime, _ = mimetypes.guess_type(file_path)
    if mime is None:
        mime = "application/octet-stream"

    data_url = f"data:{mime};base64,{encoded}"
    if mime.startswith("image/"):
        document = {"type": "image_url", "image_url": {"url": data_url}}
    else:
        document = {"type": "document_url", "document_url": data_url}

    payload = {"document": document, "model": model}
    if language:
        payload["language"] = language

    try:
        resp = requests.post(API_URL, headers=headers, json=payload, timeout=60)
    except requests.RequestException as exc:  # pragma: no cover - network issues
        raise OCRException(f"Network error: {exc}") from exc

    if resp.status_code != 200:
        body = resp.text
        try:
            data = resp.json()
            _scrub_files(data)
            summary = _summarize_error(data)
            body = summary or json.dumps(data)
        except Exception:
            pass
        if len(body) > 1000:
            body = body[:1000] + "... [truncated]"
        raise OCRException(f"API error: {resp.status_code} {body}")

    payload = resp.json()
    pages = payload.get("pages")
    if pages and isinstance(pages, list):
        markdown = "\n\n".join(
            str(page.get("markdown", "")) for page in pages if isinstance(page, dict)
        )
    else:
        markdown = payload.get("text", "")

    if output_format == "json":
        text = json.dumps(payload, ensure_ascii=False, indent=2)
    elif output_format == "text":
        import re

        plain = markdown
        plain = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", plain)
        plain = re.sub(r"\[[^\]]*\]\([^)]*\)", "", plain)
        plain = re.sub(r"[`*_>#-]", "", plain)
        text = plain
    else:
        text = markdown

    usage = payload.get("usage", {}) or payload.get("usage_info", {}) or {}
    tokens = usage.get("total_tokens") or usage.get("pages_processed", 0)
    if tokens is None:
        tokens = 0
    cost = payload.get("cost", 0.0)
    return text, int(tokens), float(cost)


# ----------------------------- CLI ---------------------------------------

class ColorFormatter(logging.Formatter):
    COLORS = {
        logging.DEBUG: "\033[36m",
        logging.INFO: "\033[32m",
        logging.WARNING: "\033[33m",
        logging.ERROR: "\033[31m",
        logging.CRITICAL: "\033[41m",
    }

    def format(self, record: logging.LogRecord) -> str:  # type: ignore[override]
        color = self.COLORS.get(record.levelno, "")
        reset = "\033[0m" if color else ""
        message = super().format(record)
        return f"{color}{message}{reset}"


def parse_args(args: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Process documents with Mistral OCR")
    parser.add_argument("patterns", nargs="+", help="Input file patterns (e.g. *.pdf)")
    parser.add_argument("--api-key", help="Mistral API key")
    parser.add_argument("--output-format", default=None, help="Output format, default from config")
    parser.add_argument("--language", default=None, help="Language hint")
    parser.add_argument("--model", default=None, help="Model name to use")
    parser.add_argument("--config-path", default=str(CONFIG_PATH), help="Path to configuration file")
    parser.add_argument("--log-level", default=None, help="Logging level")
    return parser.parse_args(args)


def setup_logging(level: str) -> None:
    numeric = getattr(logging, level.upper(), logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(ColorFormatter("%(levelname)s: %(message)s"))
    logging.basicConfig(level=numeric, handlers=[handler])


def main(argv: List[str] | None = None) -> int:
    args = parse_args(argv)

    config_path = Path(args.config_path)
    ensure_config_template(config_path)
    config = load_config(config_path)

    if args.output_format:
        config.output_format = args.output_format
    if args.language:
        config.language = args.language
    if args.model:
        config.model = args.model
    if args.log_level:
        config.log_level = args.log_level

    setup_logging(config.log_level)

    api_key = args.api_key or config.api_key
    if not api_key:
        api_key = getpass("Enter Mistral API key: ")
        if api_key:
            save = input("Save API key to config file for future use? [y/N] ")
            if save.lower().startswith("y"):
                config.api_key = api_key
                save_config(config, config_path)

    if not api_key:
        logging.error("API key is required")
        return 1

    patterns = args.patterns
    files: List[Path] = []
    for pattern in patterns:
        files.extend(Path(p) for p in glob.glob(pattern))

    if not files:
        logging.error("No files matched the given patterns")
        return 1

    total_tokens = 0
    total_cost = 0.0
    processed = 0

    for file_path in files:
        logging.info("Processing %s", file_path)
        try:
            text, tokens, cost = extract_text(
                file_path,
                api_key,
                output_format=config.output_format,
                language=config.language,
                model=config.model,
            )
        except OCRException as exc:
            logging.error("Failed to process %s: %s", file_path, exc)
            logging.error(
                "Stopping due to the error above. Verify the file is valid and your API key is correct."
            )
            return 1
        except Exception as exc:  # pragma: no cover - unexpected errors
            logging.exception(
                "Unexpected error while processing %s: %s", file_path, exc
            )
            logging.error("Stopping due to unexpected error.")
            return 1

        out_ext = {
            "markdown": ".md",
            "text": ".txt",
            "json": ".json",
        }.get(config.output_format, ".md")
        out_path = file_path.with_suffix(out_ext)
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text)
        total_tokens += tokens
        total_cost += cost
        processed += 1
        logging.info("Written %s", out_path)

    logging.info("Processed %d files", processed)
    logging.info("Tokens used: %d", total_tokens)
    logging.info("Cost: $%.4f", total_cost)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

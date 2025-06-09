"""Single-file Mistral OCR command line tool."""

from __future__ import annotations

import argparse
import configparser
from dataclasses import dataclass
from getpass import getpass
import glob
import logging
from pathlib import Path
from typing import List, Optional, Tuple

import requests


# ----------------------------- Configuration -----------------------------

CONFIG_PATH = Path.home() / ".mistral_ocr.cfg"

CONFIG_TEMPLATE = {
    "api_key": "",
    "output_format": "markdown",
    "language": "",
    "log_level": "INFO",
}


@dataclass
class Config:
    api_key: str = ""
    output_format: str = "markdown"
    language: str = ""
    log_level: str = "INFO"

    @classmethod
    def from_parser(cls, parser: configparser.ConfigParser) -> "Config":
        defaults = {k: v for k, v in CONFIG_TEMPLATE.items()}
        if parser.has_section("mistral"):
            defaults.update(parser["mistral"])
        return cls(**defaults)

    def to_parser(self) -> configparser.ConfigParser:
        parser = configparser.ConfigParser()
        parser["mistral"] = {
            "api_key": self.api_key,
            "output_format": self.output_format,
            "language": self.language,
            "log_level": self.log_level,
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
        save_config(Config(), path)


# ----------------------------- OCR API -----------------------------------

API_URL = "https://api.mistral.ai/v1/ocr"


class OCRException(Exception):
    """Raised when the OCR API returns an error."""


def extract_text(
    file_path: Path,
    api_key: str,
    output_format: str = "markdown",
    language: Optional[str] = None,
) -> Tuple[str, int, float]:
    """Extract text from *file_path* using the Mistral OCR API."""
    headers = {"Authorization": f"Bearer {api_key}"}
    data = {"output_format": output_format}
    if language:
        data["language"] = language

    with open(file_path, "rb") as fh:
        files = {"file": fh}
        resp = requests.post(API_URL, headers=headers, data=data, files=files, timeout=60)

    if resp.status_code != 200:
        raise OCRException(f"API error: {resp.status_code} {resp.text}")

    payload = resp.json()
    text = payload.get("text", "")
    usage = payload.get("usage", {}) or {}
    tokens = usage.get("total_tokens", 0)
    cost = payload.get("cost", 0.0)
    return text, tokens, cost


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


def parse_args(args: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Process documents with Mistral OCR")
    parser.add_argument("patterns", nargs="+", help="Input file patterns (e.g. *.pdf)")
    parser.add_argument("--api-key", help="Mistral API key")
    parser.add_argument("--output-format", default=None, help="Output format, default from config")
    parser.add_argument("--language", default=None, help="Language hint")
    parser.add_argument("--config-path", default=str(CONFIG_PATH), help="Path to configuration file")
    parser.add_argument("--log-level", default=None, help="Logging level")
    return parser.parse_args(args)


def setup_logging(level: str) -> None:
    numeric = getattr(logging, level.upper(), logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(ColorFormatter("%(levelname)s: %(message)s"))
    logging.basicConfig(level=numeric, handlers=[handler])


def main(argv: List[str] | None = None) -> int:
    args = parse_args(argv or [])

    config_path = Path(args.config_path)
    ensure_config_template(config_path)
    config = load_config(config_path)

    if args.output_format:
        config.output_format = args.output_format
    if args.language:
        config.language = args.language
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
            )
        except OCRException as exc:
            logging.error(str(exc))
            continue
        except Exception as exc:  # pragma: no cover - unexpected errors
            logging.exception("Unexpected error: %s", exc)
            continue

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

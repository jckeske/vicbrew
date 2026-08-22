#!/usr/bin/env python3
"""Build the static Vicbrew competition-results search index.

Run from the repository root with:

    python scripts/build_results_search.py

The public links in results.html are the source of truth. The generated JSON is
committed with the site so the search remains entirely static on GitHub Pages.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote

try:
    from pypdf import PdfReader
except ImportError as exc:  # pragma: no cover - developer setup guidance
    raise SystemExit(
        "pypdf is required. Install it with: python -m pip install pypdf"
    ) from exc


YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
YEAR_IN_FILENAME_RE = re.compile(r"(?:19|20)\d{2}")
TEXT_OVERRIDES_PATH = Path("scripts/results_text_overrides.json")
STRUCTURED_TABLE_PROJECTIONS = {
    "results/westgate-stout-extravaganza-results-2026.pdf": {
        "header": ("Place", "Brewer", "Name", "Style", "Club", "Score"),
        # The entry Name is useful in the PDF but is deliberately omitted from
        # search rows so it cannot be mistaken for the beer Style.
        "columns": ("Place", "Brewer", "Style", "Club", "Score"),
        # Pages 7-8 repeat award/category leaders that appear again in the full
        # category tables. Excluding them avoids duplicate search cards.
        "skip_pages": (7, 8),
    }
}


@dataclass
class Cell:
    tag: str
    colspan: int = 1
    text_parts: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(" ".join(self.text_parts).split())


class ResultsPageParser(HTMLParser):
    """Collect table-like rows even when legacy HTML has mismatched tags."""

    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[Cell]] = []
        self.current_row: list[Cell] | None = None
        self.current_cell: Cell | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "tr":
            if self.current_row:
                self.rows.append(self.current_row)
            self.current_row = []
        elif tag in {"th", "td"} and self.current_row is not None:
            self.current_cell = Cell(
                tag=tag,
                colspan=max(1, int(attributes.get("colspan") or "1")),
            )
        elif tag == "a" and self.current_cell is not None:
            href = attributes.get("href") or ""
            if ".pdf" in href.lower():
                self.current_cell.links.append(unquote(href))

    def handle_data(self, data: str) -> None:
        if self.current_cell is not None:
            self.current_cell.text_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"th", "td"} and self.current_cell is not None:
            if self.current_row is not None:
                self.current_row.append(self.current_cell)
            self.current_cell = None
        elif tag == "tr" and self.current_row is not None:
            self.rows.append(self.current_row)
            self.current_row = None

    def close(self) -> None:
        super().close()
        if self.current_row:
            self.rows.append(self.current_row)
            self.current_row = None


def clean_competition(header: str) -> str:
    header = re.sub(r"\s*\([^)]*\)\s*", " ", header).strip()
    aliases = {
        "AABC": "AABC",
        "Vicbrew": "Vicbrew",
        "Beerfest": "Beerfest",
        "Oktoberfest": "Oktoberfest",
        "Stout Extravaganza": "Stout Extravaganza",
        "Pale Ale Mania": "Pale Ale Mania",
        "Geelong Craft Brewers Top 5 shootout": "GCB Top 5 Shootout",
        "Belgian Beerfest": "Belgian Beerfest",
        "IPA Competition": "IPA Competition",
        "British Ale Competition": "British Ale Competition",
        "Pilsner Competition": "Pilsner Competition",
    }
    for prefix, label in aliases.items():
        if header.casefold().startswith(prefix.casefold()):
            return label
    return header or "Other competition"


def fallback_competition(filename: str) -> str:
    name = filename.casefold()
    patterns = (
        ("aabc", "AABC"),
        ("vicbrew", "Vicbrew"),
        ("beerfest", "Beerfest"),
        ("oktoberfest", "Oktoberfest"),
        ("stout", "Stout Extravaganza"),
        ("extravaganza", "Stout Extravaganza"),
        ("paleale", "Pale Ale Mania"),
        ("pale ale", "Pale Ale Mania"),
        ("gcbtop5", "GCB Top 5 Shootout"),
        ("belgian", "Belgian Beerfest"),
        ("bbf", "Belgian Beerfest"),
        ("merrimashers", "IPA Competition"),
        ("ipa", "IPA Competition"),
        ("british", "British Ale Competition"),
        ("pilsner", "Pilsner Competition"),
    )
    return next((label for needle, label in patterns if needle in name), "Other competition")


def document_kind(filename: str, link_text: str) -> str:
    name = filename.casefold()
    if "summary" in name:
        return "Summary"
    if "full" in name:
        return "Full results"
    return "Summary" if "summary" in link_text.casefold() else "Full results"


def build_manifest(results_html: Path) -> list[dict[str, str | int]]:
    parser = ResultsPageParser()
    parser.feed(results_html.read_text(encoding="utf-8"))
    parser.close()

    columns: list[str] = []
    manifest: list[dict[str, str | int]] = []
    seen: set[str] = set()

    for row in parser.rows:
        if not row:
            continue

        row_links = [link for cell in row for link in cell.links]
        year_match = next((YEAR_RE.fullmatch(cell.text) for cell in row if cell.tag == "th"), None)

        if not row_links and not year_match:
            header_cells = [cell for cell in row if cell.tag == "th"]
            if len(header_cells) >= 3:
                candidate_columns: list[str] = []
                for cell in header_cells[1:]:
                    candidate_columns.extend([clean_competition(cell.text)] * cell.colspan)
                if candidate_columns:
                    columns = candidate_columns
            continue

        if not year_match:
            continue

        year = int(year_match.group(0))
        position = 0
        for cell in (cell for cell in row if cell.tag == "td"):
            competition = columns[position] if position < len(columns) else ""
            for href in cell.links:
                filename = Path(href).name
                inferred_competition = fallback_competition(filename)
                if href in seen:
                    continue
                seen.add(href)
                manifest.append(
                    {
                        "path": href,
                        "filename": filename,
                        "competition": inferred_competition
                        if inferred_competition != "Other competition"
                        else competition or inferred_competition,
                        "year": year,
                        "kind": document_kind(filename, cell.text),
                    }
                )
            position += cell.colspan

    # Legacy malformed rows can fall outside the rows understood above. Include
    # every PDF href and infer its metadata so the public archive stays complete.
    all_links = re.findall(
        r'''href=["']([^"']+\.pdf)["']''',
        results_html.read_text(encoding="utf-8"),
        flags=re.IGNORECASE,
    )
    for encoded_href in all_links:
        href = unquote(encoded_href)
        if href in seen:
            continue
        filename = Path(href).name
        year_match = YEAR_IN_FILENAME_RE.search(filename)
        manifest.append(
            {
                "path": href,
                "filename": filename,
                "competition": fallback_competition(filename),
                "year": int(year_match.group(0)) if year_match else 0,
                "kind": document_kind(filename, ""),
            }
        )
        seen.add(href)

    return manifest


def clean_page_text(text: str) -> str:
    lines = [" ".join(line.split()) for line in text.replace("\x00", "").splitlines()]
    return "\n".join(line for line in lines if line).strip()


def extract_page_text(pdf_page: object) -> str:
    """Prefer positional extraction when ordinary extraction collapses tables."""

    try:
        text = clean_page_text(pdf_page.extract_text() or "")
    except Exception:
        text = ""

    if len(text.splitlines()) > 3:
        return text

    try:
        layout_text = clean_page_text(
            pdf_page.extract_text(extraction_mode="layout") or ""
        )
    except Exception:
        return text

    placing_rows = re.findall(
        r"(?im)^\s*=?(?:\d+(?:st|nd|rd|th)?|[123](?:st|nd|rd))\*?\s+\S+",
        layout_text,
    )
    if len(placing_rows) >= 3 and len(layout_text.splitlines()) > len(text.splitlines()):
        return layout_text
    return text


def load_text_overrides(root: Path) -> dict[str, list[str]]:
    """Load reviewed transcriptions for PDFs whose pages are image-only scans."""

    override_path = root / TEXT_OVERRIDES_PATH
    if not override_path.is_file():
        return {}

    raw_overrides = json.loads(override_path.read_text(encoding="utf-8"))
    if not isinstance(raw_overrides, dict):
        raise ValueError(f"{override_path} must contain a JSON object")

    overrides: dict[str, list[str]] = {}
    for document_path, page_texts in raw_overrides.items():
        if not isinstance(document_path, str) or not isinstance(page_texts, list):
            raise ValueError(f"Invalid transcription entry in {override_path}")
        if not all(isinstance(page_text, str) for page_text in page_texts):
            raise ValueError(f"All transcribed pages for {document_path} must be strings")
        overrides[document_path] = [clean_page_text(page_text) for page_text in page_texts]
    return overrides


def project_structured_tables(
    pdf_path: Path,
    fallback_pages: list[str],
    projection: dict[str, object],
) -> list[str]:
    """Use ruled PDF tables when ordinary extraction merges adjacent cells."""

    try:
        import pdfplumber
    except ImportError as exc:  # pragma: no cover - developer setup guidance
        raise SystemExit(
            "pdfplumber is required for structured result tables. "
            "Install it with: python -m pip install pdfplumber"
        ) from exc

    expected_header = tuple(projection["header"])
    output_columns = tuple(projection["columns"])
    skip_pages = set(projection.get("skip_pages", ()))
    projected_pages = list(fallback_pages)

    with pdfplumber.open(pdf_path) as pdf:
        for page_index, pdf_page in enumerate(pdf.pages):
            if page_index + 1 in skip_pages:
                projected_pages[page_index] = ""
                continue
            rows: list[str] = []
            for table in pdf_page.extract_tables():
                if not table:
                    continue
                header = tuple(
                    " ".join(str(cell or "").split()) for cell in table[0]
                )
                if header != expected_header:
                    continue

                column_indexes = [header.index(column) for column in output_columns]
                for table_row in table[1:]:
                    if len(table_row) < len(header):
                        continue
                    values = [
                        " ".join(str(table_row[index] or "").split())
                        for index in column_indexes
                    ]
                    if values[0] and values[1] and values[2]:
                        rows.append(" ".join(value for value in values if value))

            if rows:
                projected_pages[page_index] = clean_page_text(
                    " ".join(output_columns) + "\n" + "\n".join(rows)
                )

    return projected_pages


def detect_result_layout(text: str, item: dict[str, str | int]) -> str:
    """Identify common column orders without claiming uncertain fields."""

    normalized = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
    patterns = (
        ("place first name last name style entry name score", "place_name_style_entry_score"),
        ("place entry style name entrant name club score", "place_entry_style_name_club_score"),
        ("place entrant entry style club score", "place_name_entry_style_club_score"),
        ("place brewer entry style club score", "place_name_entry_style_club_score"),
        ("place entrant style club score", "place_name_style_club_score"),
        ("place brewer style club score", "place_name_style_club_score"),
        ("placing entry nojudging nofirst namelast namestyle club", "place_entry_judging_name_style_club_score"),
        ("placingfirst namelast namestyle club entry numberjudging number", "place_name_style_club_entry_score"),
        ("placing entry sub catstyle first name last name score total", "place_entry_style_name_score"),
        ("placing entry style first name last name score total", "place_entry_style_name_score"),
        ("substyle entry no entrant club score", "style_entry_name_club_score"),
        ("style entry no entrant club score", "style_entry_name_club_score"),
        ("place score style brewer club", "place_score_style_name_club"),
        ("place style entrant club total", "place_style_name_club_score"),
        ("place style name club total", "place_style_name_club_score"),
        ("entry brewer club style points", "entry_name_club_style_score"),
        ("entry brewer club style score", "entry_name_club_style_score"),
        ("place name club score style", "place_name_club_score_style"),
        ("serv entry name club sub style score rank", "service_entry_name_club_style_score_place"),
        ("entry no bottle cap i d name club novice total 50 place", "entry_name_club_score_place"),
        ("brewer state club score beer style", "place_name_state_club_score_style_extra"),
        ("brewer club score b eer style", "place_name_club_score_style_extra"),
        ("brewer club score beer style", "place_name_club_score_style_extra"),
    )
    for header, layout in patterns:
        if header in normalized:
            return layout

    competition = str(item["competition"])
    year = int(item["year"])
    if competition == "Vicbrew" and 2003 <= year <= 2009:
        return "place_name_club_score_style_extra"
    if competition == "AABC" and 2003 <= year <= 2011:
        return "place_name_state_club_score_style_extra"
    if competition == "Vicbrew" and 2012 <= year <= 2019:
        return "place_name_score_club_style_entry"
    if competition == "AABC" and year >= 2020:
        return "name_entry_style_state_score"
    if competition == "Beerfest" and year in {2022, 2023}:
        return "place_name_style_club_score"
    if competition == "Oktoberfest" and year == 2016:
        return "entry_place_style_name_club_score"
    if competition == "Oktoberfest" and year == 2015:
        return "place_entry_style_name_club_score"
    if competition == "Oktoberfest" and year == 2013:
        return "place_style_name_club_score"

    # Many older summary sheets put the beer style in a heading followed by
    # three compact placing rows, for example:
    #
    #   German Lager
    #   1st Hibberd, Mark VIC
    #   2nd Burrell, Ian VIC
    #
    # The style therefore has to be inherited from the nearest heading rather
    # than read from the brewer's row.
    placing_rows = re.findall(
        r"(?im)^\s*=?(?:\d+(?:st|nd|rd|th)|[123](?:st|nd|rd))\s+\S+",
        text,
    )
    if str(item["kind"]) == "Summary" and len(placing_rows) >= 3:
        return "place_name_club_heading_style"
    return "unknown"


def generate_index(root: Path) -> dict[str, object]:
    manifest = build_manifest(root / "results.html")
    text_overrides = load_text_overrides(root)
    pages: list[dict[str, object]] = []
    documents: list[dict[str, object]] = []
    missing: list[str] = []

    logging.getLogger("pypdf").setLevel(logging.ERROR)

    for document_id, item in enumerate(manifest, start=1):
        pdf_path = root / str(item["path"])
        if not pdf_path.is_file():
            missing.append(str(item["path"]))
            continue

        reader = PdfReader(str(pdf_path), strict=False)
        if str(item["path"]) in text_overrides:
            extracted_pages = text_overrides[str(item["path"])]
            if len(extracted_pages) != len(reader.pages):
                raise ValueError(
                    f"Transcription for {item['path']} has {len(extracted_pages)} pages; "
                    f"the PDF has {len(reader.pages)}"
                )
        else:
            extracted_pages = [extract_page_text(pdf_page) for pdf_page in reader.pages]

        projection = STRUCTURED_TABLE_PROJECTIONS.get(str(item["path"]))
        if projection:
            extracted_pages = project_structured_tables(
                pdf_path, extracted_pages, projection
            )

        layout = detect_result_layout("\n".join(extracted_pages), item)
        searchable_pages = 0
        extracted_characters = 0

        for page_number, text in enumerate(extracted_pages, start=1):
            extracted_characters += len(text)
            if len(text) < 80:
                continue
            searchable_pages += 1
            pages.append(
                {
                    "id": f"{document_id}-{page_number}",
                    "documentId": document_id,
                    "path": item["path"],
                    "filename": item["filename"],
                    "competition": item["competition"],
                    "year": item["year"],
                    "kind": item["kind"],
                    "page": page_number,
                    "pageCount": len(reader.pages),
                    "layout": layout,
                    "text": text,
                }
            )

        documents.append(
            {
                **item,
                "pageCount": len(reader.pages),
                "searchablePages": searchable_pages,
                "extractedCharacters": extracted_characters,
                "searchable": extracted_characters >= 80,
            }
        )

    if missing:
        raise FileNotFoundError("Missing linked PDFs: " + ", ".join(sorted(missing)))

    searchable_documents = sum(bool(document["searchable"]) for document in documents)
    return {
        "meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "documents": len(documents),
            "searchableDocuments": searchable_documents,
            "unsearchableDocuments": len(documents) - searchable_documents,
            "searchablePages": len(pages),
        },
        "documents": documents,
        "pages": pages,
    }


def main() -> None:
    script_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=script_root)
    parser.add_argument("--output", type=Path, default=Path("results-search-index.js"))
    args = parser.parse_args()

    root = args.root.resolve()
    output = args.output if args.output.is_absolute() else root / args.output
    index = generate_index(root)
    serialized = json.dumps(index, ensure_ascii=False, separators=(",", ":"))
    output.write_text(
        "window.VICBREW_RESULTS_SEARCH_INDEX=" + serialized + ";\n",
        encoding="utf-8",
    )

    meta = index["meta"]
    print(
        f"Wrote {output} with {meta['searchablePages']} searchable pages from "
        f"{meta['searchableDocuments']}/{meta['documents']} linked PDFs."
    )


if __name__ == "__main__":
    main()

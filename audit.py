#!/usr/bin/env python3
"""
Pulse City Accessibility Auditor
=================================
Static analysis tool for a11y compliance across HTML, JS, Svelte, and CSS.
Run via:  python audit.py
      or: npm run audit

Exit code 0 = clean, 1 = errors found, 2 = warnings found (with --fail-on-warnings).
"""

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

Severity = Literal["error", "warning", "info"]


@dataclass
class Issue:
    severity: Severity
    rule: str
    message: str
    file: str = ""
    line: int = 0


@dataclass
class Report:
    issues: list[Issue] = field(default_factory=list)

    def add(self, severity: Severity, rule: str, message: str, file: str = "", line: int = 0):
        self.issues.append(Issue(severity, rule, message, file, line))

    @property
    def errors(self):
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self):
        return [i for i in self.issues if i.severity == "warning"]

    @property
    def infos(self):
        return [i for i in self.issues if i.severity == "info"]


# ---------------------------------------------------------------------------
# Auditor
# ---------------------------------------------------------------------------

class PulseCityAuditor:
    def __init__(self, root: Path):
        self.root = root
        self.report = Report()

    def run(self) -> Report:
        self._audit_html()
        self._audit_accessibility_observer()
        self._audit_js_and_svelte()
        self._audit_svelte_components()
        self._audit_css()
        self._audit_test_coverage()
        return self.report

    # ── HTML ──────────────────────────────────────────────────────────────────

    def _audit_html(self):
        html = self.root / "index.html"
        if not html.exists():
            self.report.add("error", "html-missing", "index.html not found at project root")
            return

        content = html.read_text(encoding="utf-8")

        checks = [
            (r'<html[^>]+lang=', "error", "html-lang",
             "<html> element must have a lang attribute"),
            (r'<title[^>]*>[^<]+</title>', "error", "page-title",
             "<title> element is missing or empty"),
            (r'<meta[^>]+viewport', "warning", "viewport-meta",
             "Missing viewport meta tag — affects zoom accessibility"),
            (r'<canvas[^>]+(aria-label|role)=', "error", "canvas-aria",
             "Babylon.js <canvas> must have aria-label or role=\"application\""),
            (r'id=["\']pulse-city-a11y["\']', "warning", "a11y-container-html",
             "AccessibilityObserver container not pre-declared in HTML "
             "(acceptable if injected by JS at runtime)"),
        ]

        for pattern, severity, rule, message in checks:
            if not re.search(pattern, content, re.DOTALL | re.IGNORECASE):
                self.report.add(severity, rule, message, str(html))

    # ── AccessibilityObserver ─────────────────────────────────────────────────

    def _audit_accessibility_observer(self):
        candidates = [
            self.root / "src" / "engine" / "AccessibilityObserver.js",
            self.root / "src" / "engine" / "AccessibilityObserver.ts",
        ]
        obs = next((p for p in candidates if p.exists()), None)

        if obs is None:
            self.report.add(
                "error", "observer-missing",
                "AccessibilityObserver not found at src/engine/AccessibilityObserver.{js,ts}",
            )
            return

        content = obs.read_text(encoding="utf-8")
        required = {
            "register":                  "register() method missing",
            "unregister":                "unregister() method missing",
            "announce":                  "announce() method missing",
            "dispose":                   "dispose() method missing",
            "aria-live":                 "aria-live regions not created",
            "onBeforeRenderObservable":  "Scene render observer not attached",
            "sr-only":                   "Visually-hidden CSS class not applied to container",
        }
        for token, msg in required.items():
            if token not in content:
                self.report.add("error", f"observer-{token.replace(' ', '-')}", msg, str(obs))

        # Verify companion test file exists
        test_file = obs.parent / (obs.stem + ".test" + obs.suffix)
        if not test_file.exists():
            self.report.add(
                "warning", "observer-no-tests",
                f"No test file found for AccessibilityObserver (expected {test_file.name})",
                str(obs),
            )

    # ── JS / Svelte anti-patterns ─────────────────────────────────────────────

    def _audit_js_and_svelte(self):
        src = self.root / "src"
        for ext in ("*.js", "*.ts", "*.svelte"):
            for path in src.rglob(ext):
                if ".test." in path.name or path.name.endswith(".spec.js"):
                    continue
                self._scan_file(path)

    def _scan_file(self, path: Path):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return

        rel = str(path.relative_to(self.root))

        for i, line in enumerate(lines, 1):
            # Positive tabIndex breaks natural tab order
            if re.search(r'tabIndex\s*=\s*["\']?[1-9]', line, re.IGNORECASE):
                self.report.add(
                    "error", "tabindex-positive",
                    "Positive tabIndex breaks natural tab order — use 0 or -1",
                    rel, i,
                )

            # Direct innerHTML mutations bypass aria-live
            if "innerHTML" in line and "aria-live" not in line:
                self.report.add(
                    "warning", "innerhtml-aria",
                    "innerHTML mutation won't be announced — push to an aria-live region instead",
                    rel, i,
                )

            # setTimeout below 50ms used inside an announce-style call
            if re.search(r'setTimeout[^,]+,\s*([0-9]{1,2})\b', line):
                ms_match = re.search(r'setTimeout[^,]+,\s*([0-9]+)', line)
                if ms_match and int(ms_match.group(1)) < 50:
                    self.report.add(
                        "warning", "announce-settle-too-short",
                        "setTimeout < 50 ms may outrace screen reader announcement settlement",
                        rel, i,
                    )

            # autofocus on game-critical elements can trap keyboard users
            if re.search(r'\bautofocus\b', line, re.IGNORECASE):
                self.report.add(
                    "info", "autofocus",
                    "autofocus found — verify it does not trap keyboard or screen reader users",
                    rel, i,
                )

    # ── Svelte-specific checks ────────────────────────────────────────────────

    def _audit_svelte_components(self):
        src = self.root / "src"
        svelte_files = list(src.rglob("*.svelte"))

        if not svelte_files and (src / "components").exists():
            self.report.add(
                "warning", "no-svelte-components",
                "No Svelte components found in src/ — UI accessibility layer not yet built",
            )
            return

        for path in svelte_files:
            try:
                content = path.read_text(encoding="utf-8")
            except OSError:
                continue
            rel = str(path.relative_to(self.root))

            # <img> without alt
            for m in re.finditer(r'<img(?![^>]*\balt=)[^>]*>', content, re.IGNORECASE):
                line = content[: m.start()].count("\n") + 1
                self.report.add("error", "img-alt", "<img> missing alt attribute", rel, line)

            # Empty <button> without aria-label
            for m in re.finditer(
                r'<button(?![^>]*aria-label=)[^>]*>\s*(?:<[^>]+>\s*)*</button>',
                content, re.IGNORECASE
            ):
                line = content[: m.start()].count("\n") + 1
                self.report.add(
                    "error", "empty-button",
                    "<button> has no visible text or aria-label", rel, line
                )

            # on:click without on:keydown (keyboard equivalence)
            for m in re.finditer(r'\bon:click\b', content):
                snippet = content[max(0, m.start() - 200): m.end() + 200]
                if "on:keydown" not in snippet and "on:keypress" not in snippet:
                    line = content[: m.start()].count("\n") + 1
                    self.report.add(
                        "warning", "click-no-keyboard",
                        "on:click without on:keydown — ensure element is keyboard accessible",
                        rel, line,
                    )

    # ── CSS ───────────────────────────────────────────────────────────────────

    def _audit_css(self):
        src = self.root / "src"
        for path in list(src.rglob("*.css")) + list(src.rglob("*.svelte")):
            try:
                content = path.read_text(encoding="utf-8")
            except OSError:
                continue
            rel = str(path.relative_to(self.root))

            # Low-contrast marker comment
            for m in re.finditer(r'#[0-9a-fA-F]{3,8}[^;]*;\s*/\*\s*low.?contrast', content, re.IGNORECASE):
                line = content[: m.start()].count("\n") + 1
                self.report.add(
                    "error", "low-contrast-marker",
                    "Low-contrast color marker found — fix before deploy", rel, line
                )

            # Ensure .sr-only is defined (needed by AccessibilityObserver)
            if path.suffix == ".css" and path.name == "global.css":
                if ".sr-only" not in content:
                    self.report.add(
                        "error", "sr-only-missing",
                        ".sr-only utility class missing from global.css "
                        "(required by AccessibilityObserver)",
                        rel,
                    )

    # ── Test coverage markers ─────────────────────────────────────────────────

    def _audit_test_coverage(self):
        src = self.root / "src"
        engine_files = [
            p for p in (src / "engine").rglob("*.js")
            if ".test." not in p.name
        ]
        for path in engine_files:
            test = path.parent / (path.stem + ".test" + path.suffix)
            if not test.exists():
                self.report.add(
                    "warning", "missing-test",
                    f"No test file for {path.name}",
                    str(path.relative_to(self.root)),
                )


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

_RESET  = "\033[0m"
_RED    = "\033[91m"
_YELLOW = "\033[93m"
_CYAN   = "\033[96m"
_GREEN  = "\033[92m"
_BOLD   = "\033[1m"

_COLOR = {"error": _RED, "warning": _YELLOW, "info": _CYAN}
_ICON  = {"error": "[X]", "warning": "[!]", "info": "[i]"}


def print_report(report: Report, *, json_output: bool = False):
    if json_output:
        print(json.dumps(
            [{"severity": i.severity, "rule": i.rule, "message": i.message,
              "file": i.file, "line": i.line}
             for i in report.issues],
            indent=2,
        ))
        return

    if not report.issues:
        print(f"{_GREEN}{_BOLD}[OK] No accessibility issues found.{_RESET}")
        return

    # Sort: errors first, then by file + line
    severity_order = {"error": 0, "warning": 1, "info": 2}
    sorted_issues = sorted(
        report.issues,
        key=lambda i: (severity_order[i.severity], i.file, i.line),
    )

    for issue in sorted_issues:
        c = _COLOR.get(issue.severity, "")
        icon = _ICON.get(issue.severity, "?")
        loc = f"  {_BOLD}{issue.file}{_RESET}"
        if issue.line:
            loc += f":{issue.line}"
        print(f"{c}{icon} [{issue.rule}]{_RESET}{loc}")
        print(f"  {issue.message}")
        print()

    n_err  = len(report.errors)
    n_warn = len(report.warnings)
    n_info = len(report.infos)

    parts = []
    if n_err:
        parts.append(f"{_RED}{_BOLD}{n_err} error{'s' if n_err != 1 else ''}{_RESET}")
    if n_warn:
        parts.append(f"{_YELLOW}{n_warn} warning{'s' if n_warn != 1 else ''}{_RESET}")
    if n_info:
        parts.append(f"{_CYAN}{n_info} info{_RESET}")

    print("  ".join(parts))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Pulse City Accessibility Auditor — static analysis for a11y compliance"
    )
    parser.add_argument(
        "--root", default=".",
        help="Project root directory (default: current directory)"
    )
    parser.add_argument(
        "--json", action="store_true",
        help="Output results as JSON"
    )
    parser.add_argument(
        "--fail-on-warnings", action="store_true",
        help="Exit with code 2 when warnings are present"
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"Error: {root} is not a directory", file=sys.stderr)
        sys.exit(1)

    auditor = PulseCityAuditor(root)
    report = auditor.run()
    print_report(report, json_output=args.json)

    if report.errors:
        sys.exit(1)
    if args.fail_on_warnings and report.warnings:
        sys.exit(2)


if __name__ == "__main__":
    main()

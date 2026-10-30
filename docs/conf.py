"""Sphinx configuration for SpiriDevelopmentKit."""

from __future__ import annotations

project = "SpiriDevelopmentKit"
copyright = "2026, Spiri"  # noqa: A001
author = "Spiri"
release = "edge"

# The SDK is a set of apps, not a Python package, so the template's autodoc
# extensions are left out.
extensions = [
    "sphinx.ext.intersphinx",
    "myst_parser",
]

templates_path = ["_templates"]
exclude_patterns = ["_build", "Thumbs.db", ".DS_Store"]

html_theme = "furo"
html_static_path: list[str] = ["static"]
html_css_files = ["custom.css"]

html_theme_options = {
    "light_logo": "spiri-logo-light.svg",
    "dark_logo": "spiri-logo-dark.svg",
    "sidebar_hide_name": True,
}

# MyST extensions
myst_enable_extensions = ["colon_fence", "deflist"]
myst_heading_anchors = 3

intersphinx_mapping = {
    "python": ("https://docs.python.org/3", None),
}

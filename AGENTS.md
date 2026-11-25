# AGENTS.md

SpiriDevelopmentKit: Develop for Spiri robots: a simulated Mu, its world, and the tools around it. Python >=3.13, managed with `uv` (`uv.lock` is
committed). Generated from the SpiriProjectTemplates copier template; `uvx copier update` pulls
in template changes.

## Commands

- Everything CI checks: `make check`.
- Format and autofix: `make format`.
- Docs: `make docs` (Sphinx, MyST markdown; warnings are errors), `make pdf` for the controlled
  PDF, `make lint-docs` for prose (Vale). HTML is published to GitHub Pages from `main`.

## Conventions

- The docs are a controlled document (spiri-docs, as for every Spiri manual): `revisions.yaml`
  is the only place the document's revision is written. Revise it when what the docs say
  changes; it's separate from the package version.
- The template owns the versions it ships (base dependencies, workflow actions, the uv image)
  and bumps them weekly; take them with `uvx copier update` and `uv lock`, not by hand.
- Every change gets a categorized entry in `CHANGES.md` (Features / Fixes / Improvements /
  Tests / Internal) under `## Unreleased`; commits use conventional-commit style (`feat:`,
  `fix:`, `refactor:`).

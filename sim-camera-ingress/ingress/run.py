"""SpiriCamera's own CLI, with the gz:// source registered first."""

import gz_source  # noqa: F401 - importing it is what registers it

from SpiriCamera.cli import app

app()

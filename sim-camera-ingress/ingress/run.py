"""SpiriCamera's own CLI, with the gz:// source and the hud command registered first."""

import gz_source  # noqa: F401 - importing it is what registers it
import hud  # noqa: F401 - likewise, for the hud command

from SpiriCamera.cli import app

app()

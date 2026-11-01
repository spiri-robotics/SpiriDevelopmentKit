"""hud -- a camera's HUD variant: SpiriCamera's run, with the HUD's widgets.

The HUD camera reads another camera's frames (spirisynq://) and draws the
HUD's widgets on them: the topics in ``HUD_WIDGETS``, by spaces, SpiriMav's
virtual horizon, heading, status, rangefinder and the rest. It names them in
its own overlay_widgets each time it starts, as a new camera starts with
none, and each shows once its publisher has published it. A widget for
something the robot hasn't got, a rangefinder say, is never published, so
never shown.

Registered on SpiriCamera's CLI by being imported, as gz_source is.
"""

from __future__ import annotations

import os
import time

import typer
from loguru import logger

from SpiriCamera.camera import Camera, CameraError
from SpiriCamera.cli import app
from SpiriCamera.main import get_settings


@app.command()
def hud(source: str = "") -> None:
    """Run a camera, as run does, drawing the HUD's widgets on it."""
    settings = get_settings()
    source = source or settings.source
    cam = Camera(
        source=source,
        quality=settings.quality,
        max_width=settings.frame_width,
        max_height=settings.frame_height,
        max_framerate=settings.framerate,
        synq_topic=settings.topic,
    )
    shown = os.environ.get("HUD_WIDGETS", "").split()
    for topic in shown:
        cam.overlay_widgets[topic] = {}

    try:
        cam.start()
    except CameraError as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(1)

    names = ", ".join(shown) or "none"
    logger.info(f"Publishing on {cam.synq_topic} with widgets: {names}")
    try:
        while cam.running:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        cam.stop()

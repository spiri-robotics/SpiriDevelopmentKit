# SpiriCamera, the same camera-ingress a real Mu runs, plus a gz:// source
# that reads a Gazebo camera sensor off zenoh (see gz_source.py), and a hud
# command for a camera's HUD variant (see hud.py).
FROM ghcr.io/spiri-robotics/spiricamera:edge
COPY gz_source.py hud.py run.py /opt/sim-camera-ingress/
ENTRYPOINT ["python", "/opt/sim-camera-ingress/run.py"]
CMD ["run"]

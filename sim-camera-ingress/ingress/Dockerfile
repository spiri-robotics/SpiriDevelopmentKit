# SpiriCamera, the same camera-ingress a real Mu runs, plus a gz:// source
# that reads a Gazebo camera sensor off zenoh. See gz_source.py.
FROM ghcr.io/spiri-robotics/spiricamera:edge
COPY gz_source.py run.py /opt/sim-camera-ingress/
ENTRYPOINT ["python", "/opt/sim-camera-ingress/run.py"]
CMD ["run"]

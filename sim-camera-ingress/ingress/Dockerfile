# SpiriCamera, the same camera-ingress a real Mu runs, plus a gz:// source
# that reads a Gazebo camera sensor off zenoh (see gz_source.py).
ARG SPIRICAMERA_IMAGE=ghcr.io/spiri-robotics/spiricamera:edge
FROM ${SPIRICAMERA_IMAGE}
COPY gz_source.py run.py /opt/sim-camera-ingress/
ENTRYPOINT ["python", "/opt/sim-camera-ingress/run.py"]
CMD ["run"]

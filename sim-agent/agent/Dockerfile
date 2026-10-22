FROM python:3.13-slim
# 1.9.0: 1.8.0 has no working x86_64 wheel. zenoh 1.x versions interoperate.
RUN pip install --no-cache-dir eclipse-zenoh==1.9.0
COPY sim_agent.py iris.sdf /opt/sim-agent/
CMD ["python3", "-u", "/opt/sim-agent/sim_agent.py"]

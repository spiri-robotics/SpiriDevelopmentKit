FROM python:3.13-slim
# 1.9.0: 1.8.0 has no working x86_64 wheel. zenoh 1.x versions interoperate.
RUN pip install --no-cache-dir eclipse-zenoh==1.9.0 PyYAML==6.0.2 jsonschema==4.23.0
COPY index.py check.py /opt/zenoh-index/
CMD ["python3", "-u", "/opt/zenoh-index/index.py"]

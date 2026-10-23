# gz-msgs' message definitions, compiled to one descriptor set, so the index
# can decode Gazebo's messages with protobuf alone. The version Jetty ships.
FROM python:3.13-slim AS gz-msgs
ARG GZ_MSGS_TAG=gz-msgs12_12.0.2
ADD https://github.com/gazebosim/gz-msgs/archive/refs/tags/${GZ_MSGS_TAG}.tar.gz /tmp/gz-msgs.tar.gz
RUN pip install --no-cache-dir grpcio-tools==1.71.0 \
 && mkdir /src && tar xzf /tmp/gz-msgs.tar.gz -C /src --strip-components=1 \
 && python -m grpc_tools.protoc -I /src/proto --include_imports \
      --descriptor_set_out=/gz-msgs.desc /src/proto/gz/msgs/*.proto

FROM python:3.13-slim
# 1.9.0: 1.8.0 has no working x86_64 wheel. zenoh 1.x versions interoperate.
RUN pip install --no-cache-dir eclipse-zenoh==1.9.0 PyYAML==6.0.2 jsonschema==4.23.0 protobuf==5.29.4
COPY --from=gz-msgs /gz-msgs.desc /opt/zenoh-index/gz-msgs.desc
COPY index.py check.py gz.py /opt/zenoh-index/
CMD ["python3", "-u", "/opt/zenoh-index/index.py"]

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update
RUN apt-get install -y --no-install-recommends build-essential gcc-arm-none-eabi libnewlib-dev python3 python3-pyelftools pkg-config
WORKDIR /workspace
ENTRYPOINT ["python3", "/workspace/tools/native-build/build_and_test.py"]

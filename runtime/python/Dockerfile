# Dockerfile — first-party KEEL image (viewer + runner), Iron Bank-shaped:
# minimal runtime, non-root, security-upgraded OS packages, SBOM-friendly.
# syntax=docker/dockerfile:1.7
FROM python:3.11-slim AS builder
ENV PIP_NO_CACHE_DIR=1
WORKDIR /build
COPY pyproject.toml README.md ./
COPY keel ./keel
RUN pip install --prefix=/install ".[viewer,pg,otel]"
# Examples ship in the image so `keel run examples/...` works out of the box; a
# pre-owned /data seeds the anonymous volume with non-root ownership.
COPY examples ./examples
RUN mkdir -p /seed-data

FROM python:3.11-slim-bookworm AS runtime
RUN apt-get update \
    && apt-get upgrade -y \
    && groupadd --gid 65532 nonroot \
    && useradd --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin nonroot \
    && python -m pip uninstall -y pip setuptools wheel jaraco.context \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /install /usr/local
COPY --from=builder /build/examples /app/examples
COPY --from=builder --chown=65532:65532 /seed-data /data
WORKDIR /app
# Distroless CPython does not search /usr/local/.../site-packages by default, so
# make the copied packages importable and route all run state to the /data volume.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/usr/local/lib/python3.11/site-packages \
    KEEL_DATA_DIR=/data
VOLUME /data
EXPOSE 8321
USER 65532:65532
ENTRYPOINT ["python", "-m", "keel.cli"]
CMD ["view", "--host", "0.0.0.0", "--port", "8321"]

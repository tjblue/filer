FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Search can fall back to Python, but ripgrep is faster for content searches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-docker.txt ./
RUN python -m pip install --no-cache-dir --require-hashes -r requirements-docker.txt

COPY app/ ./app/
COPY static/ ./static/
COPY templates/ ./templates/
COPY server.py ./

RUN groupadd --gid 1000 filer \
    && useradd --uid 1000 --gid filer --no-create-home filer \
    && mkdir -p /app/data /files \
    && chown filer:filer /app/data /files

USER filer
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/settings/api', timeout=3).close()"]

ENTRYPOINT ["python", "server.py"]
CMD ["--production", "--host", "0.0.0.0", "--root", "/files"]

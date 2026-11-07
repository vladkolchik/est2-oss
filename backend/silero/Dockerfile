# syntax=docker/dockerfile:1
#
# Self-hosted Silero TTS (compose profile "tts"). CPU-only torch; the model is downloaded
# on first start into /models — mount a volume there so restarts don't re-download it.
# torch 2.5.1 supports Python 3.9-3.12.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SILERO_MODEL=v3_en \
    SILERO_SPEAKER=en_0 \
    SILERO_THREADS=4

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY server.py ./

RUN useradd --create-home --uid 10001 silero && mkdir -p /models && chown silero:silero /models
USER silero

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=4).status == 200 else 1)"

CMD ["sh", "-c", "exec python server.py --host 0.0.0.0 --port 3000 --model \"$SILERO_MODEL\" --speaker \"$SILERO_SPEAKER\" --threads \"$SILERO_THREADS\" --models-dir /models"]

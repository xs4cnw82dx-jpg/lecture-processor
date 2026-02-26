FROM python:3.9-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    LIBREOFFICE_BIN=soffice

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libreoffice \
      libreoffice-common \
      libreoffice-core \
      libreoffice-impress \
      libreoffice-writer \
      fonts-dejavu-core \
      ca-certificates && \
    (which soffice || which libreoffice) && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

EXPOSE 10000

CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-10000} app:app"]

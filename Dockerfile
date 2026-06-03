# Use the official Python 3.12 slim image (Debian-based).
# This image already includes libstdc++, pip, and all C runtime libs
# that numpy/pandas manylinux wheels require — no Nix complications.

FROM python:3.12-slim

# Install build tools needed by some pip packages (e.g. cffi, coincurve)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Force Python to flush logs immediately (critical for Railway log streaming)
# Without this, Python buffers stdout and Railway sees NOTHING until buffer fills
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Copy only requirements first to leverage Docker layer caching
COPY bot/requirements.txt ./bot/requirements.txt

# Install Python dependencies
RUN pip install --no-cache-dir -r bot/requirements.txt

# Copy the full application
COPY . .

# Run the multi-coin launcher (reads BOT_SYMBOLS from env)
# Falls back to single-coin mode via BOT_SYMBOL if BOT_SYMBOLS is not set.
CMD ["python", "launcher.py"]

# Throwaway: the Kurumi turn image plus the must-support clients (the base image has only bun and claude).
FROM kurumi-agent:sdk-0.3.332
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates python3 python3-pip nodejs npm gh openssl \
 && rm -rf /var/lib/apt/lists/*
